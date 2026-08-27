import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { OpenAPIRegistry, type RouteConfig } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

export const ErrorResponse = z.object({
  error: z.object({
    code: z.string().openapi({ examples: ['VALIDATION', 'NOT_FOUND', 'DUPLICATE_EMAIL'] }),
    message: z.string().openapi({ examples: ['Invalid request payload', 'No such resource'] }),
  }),
}).openapi('ErrorResponse');

export const API = '/api/v1';

function summaryFrom(method: string, path: string): string {
  const verb = method.toUpperCase();
  const slug = path.split('/').filter(Boolean).join(' /');
  return `${verb} /${slug}`;
}

const DEFAULT_ERRORS = {
  400: { description: 'Validation error', content: { 'application/json': { schema: ErrorResponse } } },
  401: { description: 'Unauthenticated', content: { 'application/json': { schema: ErrorResponse } } },
  403: { description: 'Forbidden', content: { 'application/json': { schema: ErrorResponse } } },
  404: { description: 'Not found', content: { 'application/json': { schema: ErrorResponse } } },
  409: { description: 'Conflict', content: { 'application/json': { schema: ErrorResponse } } },
} as const;

export function defineRoute(config: RouteConfig): RouteConfig {
  const isPublic = config.security !== undefined && Array.isArray(config.security) && config.security.length === 0;

  const merged = {
    ...config,
    path: `${API}${config.path}`,
    summary: config.summary ?? summaryFrom(config.method, config.path),
    security: isPublic ? [] : [{ bearerAuth: [] }],
    responses: mergeErrors(config.responses ?? {}, isPublic),
  };

  registry.registerPath(merged);
  return config;
}

function mergeErrors(responses: RouteConfig['responses'], isPublic: boolean): NonNullable<RouteConfig['responses']> {
  const out = { ...responses } as Record<string, unknown>;

  if (isPublic) {
    delete out[401];
    delete out[403];
  }

  for (const [status, spec] of Object.entries(DEFAULT_ERRORS)) {
    if (!(status in out)) {
      out[status] = spec;
    }
  }

  return out as NonNullable<RouteConfig['responses']>;
}
