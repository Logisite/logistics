import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';

import { getConfig } from '../config.js';
import { registry } from './registry.js';

// side-effect imports — each router below calls defineRoute so its paths auto-register
import '../auth/router.js';
import '../customers/router.js';
import '../merchants/router.js';
import '../locations/router.js';
import '../pricing/router.js';
import '../modules/shipments/router.js';
import '../modules/operations/router.js';
import '../modules/sync/router.js';
import '../modules/reporting/router.js';
import '../modules/cod/router.js';

import { registry as _reg } from './registry.js';

void _reg;

registry.registerPath({
  method: 'get',
  path: '/health',
  responses: { 200: { description: 'ok' } },
});

export function generateSpec(): ReturnType<OpenApiGeneratorV3['generateDocument']> {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: { title: 'Logistics OS', version: '0.1.0', description: 'Offline-first logistics platform' },
    servers: [{ url: getConfig().appUrl }],
  });
}
