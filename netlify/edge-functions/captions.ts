import type { Config } from '@netlify/edge-functions';
import { handleCaptionRequest } from '../../src/server/captions-handler.ts';

/**
 * Runs at the edge because edge functions may stream for as long as the model
 * needs, unlike synchronous Node functions with their short timeout.
 */
export default (req: Request): Promise<Response> => handleCaptionRequest(req);

export const config: Config = {
  path: '/api/captions',
};
