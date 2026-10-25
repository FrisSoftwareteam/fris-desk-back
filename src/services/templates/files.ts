import { Types } from 'mongoose';
import type { AttachmentDto } from '../../shared.js';
import { HttpError } from '../../lib/http.js';
import { attachmentStore, type AttachmentMeta } from '../attachments/AttachmentStore.js';

const toDto = (a: AttachmentMeta): AttachmentDto => ({
  id: a.id,
  filename: a.filename,
  contentType: a.contentType,
  size: a.size,
});

export const safeFilename = (name: string) => name.replace(/[\\/\r\n]/g, '_').slice(0, 200) || 'attachment';

/** Details of a template's form files, in the order the template lists them. */
export async function templateFiles(ids: Types.ObjectId[]): Promise<AttachmentDto[]> {
  return (await attachmentStore.getMeta(ids)).map(toDto);
}

/** Stores uploaded form files for a template. They belong to no enquiry until copied into a reply. */
export async function storeTemplateFiles(files: Express.Multer.File[]): Promise<AttachmentDto[]> {
  const saved: AttachmentDto[] = [];
  for (const f of files) {
    const meta = await attachmentStore.save(
      {
        filename: safeFilename(f.originalname),
        contentType: f.mimetype || 'application/octet-stream',
        size: f.size,
        ticketId: null,
      },
      async () => f.buffer,
    );
    saved.push(toDto(meta));
  }
  return saved;
}

/**
 * Copies a template's form files into new uploads staged on an enquiry. The template keeps its own
 * copies: once a reply is sent, mailbox storage re-points (and drops) the files it sent.
 */
export async function copyTemplateFiles(ids: Types.ObjectId[], ticketId: Types.ObjectId): Promise<AttachmentDto[]> {
  const copies: AttachmentDto[] = [];
  for (const id of ids) {
    const file = await attachmentStore.open(id.toString());
    if (!file) throw new HttpError(404, 'One of the template’s form files is missing. Ask a supervisor to re-add it.');
    const chunks: Buffer[] = [];
    for await (const chunk of file.stream) chunks.push(chunk as Buffer);
    const meta = await attachmentStore.save(
      { filename: file.meta.filename, contentType: file.meta.contentType, size: file.meta.size, ticketId },
      async () => Buffer.concat(chunks),
    );
    copies.push(toDto(meta));
  }
  return copies;
}
