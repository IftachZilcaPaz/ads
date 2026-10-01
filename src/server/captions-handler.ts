import { CaptionRequestSchema } from '../shared/captions.ts';
import { defaultAiDeps, handleAiRequest, type AiHandlerDeps } from './ai-handler.ts';
import { generateCaptions, toCaptionError } from './captions-service.ts';

export type CaptionHandlerDeps = AiHandlerDeps;
export const defaultCaptionDeps = defaultAiDeps;

/** POST /api/captions - see handleAiRequest for the two response modes. */
export function handleCaptionRequest(req: Request, deps: CaptionHandlerDeps = defaultCaptionDeps): Promise<Response> {
  return handleAiRequest(req, { schema: CaptionRequestSchema, generate: generateCaptions, toError: toCaptionError }, deps);
}
