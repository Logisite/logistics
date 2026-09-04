import { writeFileSync } from 'node:fs';
import { generateSpec } from './generator.js';
import { logger } from '../shared/logger.js';

const spec = generateSpec();
writeFileSync('openapi.json', JSON.stringify(spec, null, 2));
logger.info({ paths: Object.keys(spec.paths ?? {}).length }, 'wrote openapi.json');
