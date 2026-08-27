import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';

import { getConfig } from '../shared/config.js';
import { registry, API, defineRoute } from './registry.js';
import pkg from '../../package.json' with { type: 'json' };

import '../modules/auth/index.js';
import '../modules/customers/index.js';
import '../modules/merchants/index.js';
import '../modules/locations/index.js';
import '../modules/pricing/index.js';
import '../modules/shipments/index.js';
import '../modules/operations/index.js';
import '../modules/sync/index.js';
import '../modules/reporting/index.js';
import '../modules/cod/index.js';

defineRoute({ method: 'get', path: '/health', responses: { 200: { description: 'ok' } } });

export function generateSpec(): ReturnType<OpenApiGeneratorV31['generateDocument']> {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: { title: 'Logistics OS', version: (pkg as { version: string }).version, description: 'Offline-first logistics platform' },
    servers: [{ url: `${getConfig().appUrl}${API}` }],
  });
}
