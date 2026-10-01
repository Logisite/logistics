import { randomUUID } from 'node:crypto';

import express from 'express';
import type { ErrorRequestHandler, Express, RequestHandler } from 'express';
import pinoHttp from 'pino-http';
import { ZodError } from 'zod';

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

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function requestIdFrom(header: string | undefined): string | undefined {
  if (!header) return undefined;
  return REQUEST_ID_PATTERN.test(header) ? header : undefined;
}

const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid request payload' } });
    return;
  }
  const bodyParse = err as { type?: string; status?: number };
  if (bodyParse.type === 'entity.parse.failed' || bodyParse.type === 'entity.too.large') {
    req.log.warn({ err: bodyParse.type }, 'request rejected');
    res.status(400).json({ error: { code: 'VALIDATION', message: 'Malformed request body' } });
    return;
  }
  req.log.error({ err }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
};

const notFoundHandler: RequestHandler = (req, res) => {
  req.log.info({ path: req.path, method: req.method }, 'route not found');
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } });
};

export function createApp({ db, mailer }: AppDeps): Express {
  const app = express();
  const config = getConfig();

  const httpLogger = pinoHttp({
    logger,
    genReqId: (req) => requestIdFrom(req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
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

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin === config.appUrl) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '1mb' }));

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

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
