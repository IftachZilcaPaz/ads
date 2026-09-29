import type { Config } from '@netlify/functions';
import { api } from '../../src/server/container.ts';

export default (req: Request): Promise<Response> => api.handle(req);

export const config: Config = {
  path: ['/api/*'],
};
