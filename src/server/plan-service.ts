import type Anthropic from '@anthropic-ai/sdk';
import {
  PLAN_SYSTEM_PROMPT,
  PlanRequestSchema,
  PlanResultSchema,
  buildPlanUserText,
  normalizePlan,
  type ParsedPlanRequest,
  type PlanResult,
} from '../shared/campaign-plan.ts';
import { AiError, structuredCall, toAiError, type AiEvent, type AiOptions } from './ai.ts';
import { defaultAiDeps, handleAiRequest, type AiHandlerDeps } from './ai-handler.ts';

/** Campaign context in, an organic content plan (and optionally a Meta ads plan) out. */
export async function generatePlan(
  client: Anthropic,
  input: ParsedPlanRequest,
  opts: AiOptions,
  onEvent?: (event: AiEvent) => void,
): Promise<PlanResult> {
  const result = normalizePlan(
    await structuredCall(
      client,
      { system: PLAN_SYSTEM_PROMPT, content: [{ type: 'text', text: buildPlanUserText(input) }], schema: PlanResultSchema, maxTokens: 32000 },
      opts,
      onEvent,
    ),
    input,
  );
  if (!result.posts.length) throw new AiError('לא התקבלו פוסטים בטווח התאריכים, נסה שוב', 502);
  return result;
}

const toPlanError = (err: unknown) => toAiError(err, { unexpected: 'שגיאה לא צפויה בבניית התוכנית' });

/** POST /api/plan. Planning is strategy work, so it runs at high effort. */
export function handlePlanRequest(req: Request, deps: AiHandlerDeps = defaultAiDeps): Promise<Response> {
  return handleAiRequest(req, { schema: PlanRequestSchema, generate: generatePlan, toError: toPlanError, effort: 'high' }, deps);
}
