import express, { type ErrorRequestHandler } from 'express';
import multer from 'multer';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { ZodError } from 'zod';
import { CSRF_HEADER } from './shared.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { HttpError } from './lib/http.js';
import { requireCsrfHeader } from './middleware/csrf.js';
import { apiLimiter, sendLimiter, signInLimiter, webhookLimiter } from './middleware/rateLimit.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { attachmentsRouter } from './routes/attachments.js';
import { GRAPH_WEBHOOK_PATH, graphWebhookRouter } from './routes/graphWebhook.js';
import { lookupsRouter } from './routes/lookups.js';
import { ticketsRouter } from './routes/tickets.js';
import { composeRouter } from './routes/compose.js';
import { templatesRouter } from './routes/templates.js';
import { automationRouter } from './routes/automation.js';
import { departmentsRouter } from './routes/departments.js';
import { reportsRouter } from './routes/reports.js';
import { usersRouter } from './routes/users.js';
import { notificationsRouter } from './routes/notifications.js';
import { approvalsRouter } from './routes/approvals.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      origin: env.FRONTEND_ORIGIN,
      allowedHeaders: ['Content-Type', 'Authorization', CSRF_HEADER],
      // So the web app can name CSV downloads as the API does.
      exposedHeaders: ['Content-Disposition'],
      // Every call carries an Authorization header, so browsers preflight it; cache the answer.
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/health' } }));

  app.use(`/api${GRAPH_WEBHOOK_PATH}`, webhookLimiter);
  app.use('/api', apiLimiter);
  app.use(['/api/auth/session', '/api/auth/dev-login'], signInLimiter);
  app.post(
    ['/api/tickets', '/api/tickets/:id/messages', '/api/tickets/:id/escalate', '/api/tickets/:id/attachments'],
    sendLimiter,
  );
  app.use('/api', requireCsrfHeader([GRAPH_WEBHOOK_PATH]));
  app.use('/api', healthRouter);
  app.use('/api', graphWebhookRouter);
  app.use('/api', authRouter);
  app.use('/api', lookupsRouter);
  app.use('/api', ticketsRouter);
  app.use('/api', composeRouter);
  app.use('/api', templatesRouter);
  app.use('/api', automationRouter);
  app.use('/api', departmentsRouter);
  app.use('/api', usersRouter);
  app.use('/api', reportsRouter);
  app.use('/api', notificationsRouter);
  app.use('/api', approvalsRouter);
  app.use('/api', attachmentsRouter);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 25 MB or smaller' : err.message;
      res.status(400).json({ error: message });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({ error: 'Invalid request', issues: err.issues });
      return;
    }
    // express.json(): malformed JSON or a body over the size limit.
    const bodyError = err as { type?: string; status?: number };
    if (bodyError.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'The request body is not valid JSON' });
      return;
    }
    if (bodyError.type === 'entity.too.large') {
      res.status(413).json({ error: 'The request is too large' });
      return;
    }
    req.log.error({ err }, 'Unhandled request error');
    res.status(500).json({ error: 'Internal server error' });
  };
  app.use(errorHandler);

  return app;
}
