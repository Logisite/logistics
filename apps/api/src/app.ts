import express from 'express';
import type { ErrorRequestHandler, Express } from 'express';
import pinoHttp from 'pino-http';

import { authRouter, capabilityRouter, requireAuth, requirePermission, PERMISSIONS } from './modules/auth/index.js';
import type { Mailer } from './modules/auth/index.js';
import { customerRouter } from './modules/customers/index.js';
import { locationRouter } from './modules/locations/index.js';
import { merchantRouter } from './modules/merchants/index.js';
import { pricingRouter } from './modules/pricing/index.js';
import { shipmentsRouter, trackingRouter } from './modules/shipments/index.js';
import { codRouter } from './modules/cod/index.js';
import { operationsRouter } from './modules/operations/index.js';
import { reportingRouter } from './modules/reporting/index.js';
import { syncRouter } from './modules/sync/index.js';
import { generateSpec } from './openapi/generator.js';
import type { Db } from './shared/db.js';
import { API } from './openapi/registry.js';
import pkg from '../package.json' with { type: 'json' };
import { HttpError } from './shared/errors.js';
import { getConfig } from './shared/config.js';
import { logger } from './shared/logger.js';

export interface AppDeps {
  db: Db;
  mailer: Mailer;
}

const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  req.log.error({ err }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
};

export function createApp({ db, mailer }: AppDeps): Express {
  const app = express();
  const config = getConfig();

  const httpLogger = pinoHttp({
    logger,
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? undefined,
    customSuccessMessage: (req: express.Request, res: express.Response) => {
      if (res.statusCode >= 400) return 'request failed';
      return 'request completed';
    },
    customLogLevel: (_req: express.Request, res: express.Response, err?: Error) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  });

  app.use(httpLogger);

  app.use(express.json());

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin === config.appUrl) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get(`${API}/health`, (_req, res) => {
    res.json({ status: 'ok', version: (pkg as { version: string }).version, sha: process.env.GIT_SHA ?? 'dev' });
  });

  app.get(`${API}/openapi.json`, (_req, res) => {
    res.json(generateSpec());
  });

  app.get(`${API}/docs`, requireAuth(db), requirePermission(PERMISSIONS.AUDIT_READ), async (req, res) => {
    const { default: swaggerUi } = await import('swagger-ui-express');
    const spec = generateSpec();
    const html = swaggerUi.generateHTML(spec);
    res.setHeader('content-type', 'text/html');
    res.send(html);
  });

  app.use(`${API}/auth`, authRouter(db, mailer));
  app.use(`${API}/capability`, capabilityRouter(db));
  app.use(`${API}/customers`, customerRouter(db));
  app.use(`${API}/locations`, locationRouter(db));
  app.use(`${API}/merchants`, merchantRouter(db));
  app.use(`${API}/pricing`, pricingRouter(db));
  app.use(`${API}/shipments`, shipmentsRouter(db, mailer));
  app.use(`${API}/tracking`, trackingRouter(db));
  app.use(`${API}/cod`, codRouter(db));
  app.use(`${API}/runs`, operationsRouter(db));
  app.use(`${API}/sync`, syncRouter(db));
  app.use(`${API}/reports`, reportingRouter(db));

  app.use(errorHandler);

  return app;
}
