import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import { GraphError } from '@microsoft/microsoft-graph-client';
import { HttpError } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { attachmentStore } from '../services/attachments/AttachmentStore.js';

export const attachmentsRouter = Router();

// Only these are shown inline (e.g. images inside an email body). Everything else downloads, so an
// attached HTML/SVG file can never run in the API's origin.
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);

attachmentsRouter.get('/attachments/:id', requireAuth, async (req, res) => {
  let file;
  try {
    file = await attachmentStore.open(String(req.params.id));
  } catch (err) {
    // Stored in the mailbox, but the email has since been deleted or moved out of reach.
    if (err instanceof GraphError && err.statusCode === 404) {
      throw new HttpError(410, 'This attachment is no longer in the mailbox');
    }
    throw err;
  }
  if (!file) throw new HttpError(404, 'Attachment not found');
  const { meta, stream, length } = file;

  // ?download=1 forces a download even for pictures: the web app is on another origin, where a
  // link's `download` attribute is ignored, so an inline picture would replace the app instead.
  const inline = req.query.download === undefined && INLINE_TYPES.has(meta.contentType.toLowerCase());
  res.setHeader('Content-Type', inline ? meta.contentType : 'application/octet-stream');
  if (length !== null) res.setHeader('Content-Length', String(length));
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(meta.filename)}`,
  );
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  // The web app (another site) fetches files with its session token; allow it to read the response.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'private, max-age=3600');

  // pipeline closes the source too if the browser goes away mid-download.
  await pipeline(stream, res).catch((err: unknown) => {
    if ((err as { code?: string }).code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    req.log.error({ err }, 'Attachment stream failed');
  });
});
