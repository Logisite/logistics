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

function operationIdFrom(method: string, path: string): string {
  const verb = method.toLowerCase();
  const slug = path
    .replace(/[{}]/g, '')
    .split('/')
    .filter(Boolean)
    .map((segment) =>
      segment
        .replace(/[^A-Za-z0-9]+/g, ' ')
        .trim()
        .split(' ')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(''),
    )
    .join('');
  return `${verb}${slug.charAt(0).toUpperCase()}${slug.slice(1)}`;
}

function summaryFrom(method: string, path: string): string {
  const verb = method.toUpperCase();
  const slug = path.split('/').filter(Boolean).join(' /');
  return `${verb} /${slug}`;
}

// Only the errors every route can plausibly return. 404 and 409 are opt-in,
// because a GET that advertises a 409, or a register route that advertises a
// 404, tells the client to handle failures that cannot happen. Clients should
// branch on error.code in the body rather than on the status.
const DEFAULT_ERRORS = {
  400: { description: 'Validation error', content: { 'application/json': { schema: ErrorResponse } } },
  401: { description: 'Unauthenticated', content: { 'application/json': { schema: ErrorResponse } } },
  403: { description: 'Forbidden', content: { 'application/json': { schema: ErrorResponse } } },
} as const;

/** Group by the first path segment so generated clients can group screens. */
function tagsFrom(path: string): string[] {
  const top = path.split('/').filter(Boolean)[0];
  return top ? [top] : [];
}

export function defineRoute(config: RouteConfig): RouteConfig {
  const isPublic = config.security !== undefined && Array.isArray(config.security) && config.security.length === 0;

  const merged = {
    ...config,
    path: `${API}${config.path}`,
    summary: config.summary ?? summaryFrom(config.method, config.path),
    operationId: config.operationId ?? operationIdFrom(config.method, config.path),
    tags: config.tags ?? tagsFrom(config.path),
    security: isPublic ? [] : [{ bearerAuth: [] }],
    responses: mergeErrors(config.responses ?? {}, isPublic, config.path),
  };

  registry.registerPath(merged);
  return config;
}

const NOT_FOUND = {
  description: 'Not found',
  content: { 'application/json': { schema: ErrorResponse } },
};

function mergeErrors(
  responses: RouteConfig['responses'],
  isPublic: boolean,
  path: string,
): NonNullable<RouteConfig['responses']> {
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

  // A route scoped by a path parameter can always miss on a lookup, so 404 is
  // derived rather than hand-declared. It cannot rot the way 96 hand-edited
  // responses would, and it keeps the blanket 409 out of every GET.
  if (path.includes('{') && !(404 in out)) {
    out[404] = NOT_FOUND;
  }

  return out as NonNullable<RouteConfig['responses']>;
}
