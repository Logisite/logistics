import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { OpenAPIRegistry, type RouteConfig } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

export const API = '/api/v1';

export function defineRoute(config: RouteConfig): RouteConfig {
  registry.registerPath({ ...config, path: `${API}${config.path}` });
  return config;
}
