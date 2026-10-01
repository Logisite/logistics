import type { z } from 'zod';

import { badRequest } from './errors.js';

export function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body);
  if (!result.success) throw badRequest('VALIDATION', 'Invalid request payload');
  return result.data;
}