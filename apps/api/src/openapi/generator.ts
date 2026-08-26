import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';

import { getConfig } from '../config.js';
import { registry } from './registry.js';
import pkg from '../../package.json' with { type: 'json' };

// side-effect imports — each router below calls defineRoute so its paths auto-register
import '../auth/router.js';
import '../customers/router.js';
import '../merchants/router.js';
import '../locations/router.js';
import '../pricing/router.js';
import '../modules/shipments/index.js';
import '../modules/operations/index.js';
import '../modules/sync/index.js';
import '../modules/reporting/index.js';
import '../modules/cod/index.js';

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
    info: { title: 'Logistics OS', version: (pkg as { version: string }).version, description: 'Offline-first logistics platform' },
    servers: [{ url: getConfig().appUrl }],
  });
}
