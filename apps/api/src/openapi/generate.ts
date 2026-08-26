import { writeFileSync } from 'node:fs';
import { generateSpec } from './generator.js';

const spec = generateSpec();
writeFileSync('openapi.json', JSON.stringify(spec, null, 2));
console.log(`wrote openapi.json with ${Object.keys(spec.paths ?? {}).length} paths`);
