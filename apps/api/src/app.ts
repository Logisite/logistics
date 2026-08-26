import express from 'express';
import type { ErrorRequestHandler, Express } from 'express';

import { authRouter } from './auth/router.js';
import type { Mailer } from './auth/emails.js';
import { customerRouter } from './customers/router.js';
import { locationRouter } from './locations/router.js';
import { merchantRouter } from './merchants/router.js';
import { pricingRouter } from './pricing/router.js';
import { shipmentsRouter, trackingRouter } from './modules/shipments/index.js';
import { codRouter } from './modules/cod/index.js';
import { operationsRouter } from './modules/operations/index.js';
import { reportingRouter } from './modules/reporting/index.js';
import { syncRouter } from './modules/sync/index.js';
import { generateSpec } from './openapi/generator.js';
import { requireAuth, requirePermission } from './auth/middleware.js';
import { PERMISSIONS } from './auth/permissions.js';
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

  app.get('/openapi.json', (_req, res) => {
    res.json(generateSpec());
  });

  app.get('/docs', requireAuth(db), requirePermission(PERMISSIONS.AUDIT_READ), async (req, res) => {
    const { default: swaggerUi } = await import('swagger-ui-express');
    const spec = generateSpec();
    const html = swaggerUi.generateHTML(spec);
    res.setHeader('content-type', 'text/html');
    res.send(html);
  });

  app.use('/auth', authRouter(db, mailer));
  app.use('/customers', customerRouter(db));
  app.use('/locations', locationRouter(db));
  app.use('/merchants', merchantRouter(db));
  app.use('/pricing', pricingRouter(db));
  app.use('/shipments', shipmentsRouter(db, mailer));
  app.use('/tracking', trackingRouter(db));
  app.use('/cod', codRouter(db));
  app.use('/runs', operationsRouter(db));
  app.use('/sync', syncRouter(db));
  app.use('/reports', reportingRouter(db));

  app.use(errorHandler);

  return app;
}