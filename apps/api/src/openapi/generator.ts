import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';

import { getConfig } from '../config.js';
import { registry } from './registry.js';

import { z } from 'zod';

registry.registerPath({
  method: 'get',
  path: '/health',
  responses: { 200: { description: 'ok' } },
});

registry.registerPath({
  method: 'post',
  path: '/auth/login',
  request: { body: { content: { 'application/json': { schema: z.object({ email: z.string().email(), password: z.string() }) } } } },
  responses: { 200: { description: 'ok' }, 400: { description: 'validation' }, 401: { description: 'unauthorized' } },
});

registry.registerPath({
  method: 'post',
  path: '/runs',
  request: { body: { content: { 'application/json': { schema: z.object({ driverUserId: z.string().uuid(), shipments: z.array(z.object({ shipmentId: z.string().uuid(), sequence: z.number() })) }) } } } },
  responses: { 201: { description: 'created' }, 401: { description: 'unauthorized' }, 403: { description: 'forbidden' } },
});

registry.registerPath({
  method: 'get',
  path: '/reports/revenue',
  responses: { 200: { description: 'ok' }, 401: { description: 'unauthorized' }, 403: { description: 'forbidden' } },
});

registry.registerPath({
  method: 'post',
  path: '/sync/push',
  request: { body: { content: { 'application/json': { schema: z.object({ deviceId: z.string().uuid(), ops: z.array(z.object({ seq: z.number(), opId: z.string().uuid(), action: z.string(), entity: z.string() })) }) } } } },
  responses: { 200: { description: 'ok' }, 400: { description: 'validation' } },
});

export function generateSpec(): ReturnType<OpenApiGeneratorV3['generateDocument']> {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: { title: 'Logistics OS', version: '0.1.0', description: 'Offline-first logistics platform' },
    servers: [{ url: getConfig().appUrl }],
  });
}
