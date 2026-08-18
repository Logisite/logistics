import express from 'express';
import type { ErrorRequestHandler, Express } from 'express';

import { authRouter } from './auth/router.js';
import type { Mailer } from './auth/emails.js';
import { customerRouter } from './customers/router.js';
import { merchantRouter } from './merchants/router.js';
import type { Db } from './db.js';
import { HttpError } from './errors.js';

export interface AppDeps {
  db: Db;
  mailer: Mailer;
}

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
};

export function createApp({ db, mailer }: AppDeps): Express {
  const app = express();

  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/auth', authRouter(db, mailer));
  app.use('/customers', customerRouter(db));
  app.use('/merchants', merchantRouter(db));

  app.use(errorHandler);

  return app;
}