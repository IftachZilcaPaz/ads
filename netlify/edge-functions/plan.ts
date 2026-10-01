import type { Config } from '@netlify/edge-functions';
import { handlePlanRequest } from '../../src/server/plan-service.ts';

/** Streams like /api/captions: a campaign plan can take longer than a Node function may run. */
export default (req: Request): Promise<Response> => handlePlanRequest(req);

export const config: Config = {
  path: '/api/plan',
};
