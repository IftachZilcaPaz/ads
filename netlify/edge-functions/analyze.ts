import type { Config } from '@netlify/edge-functions';
import { handleAnalyzeRequest } from '../../src/server/analytics.ts';

/** Streams like /api/captions: an AI read of the account's numbers. */
export default (req: Request): Promise<Response> => handleAnalyzeRequest(req);

export const config: Config = {
  path: '/api/analyze',
};
