import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export type Effort = 'low' | 'medium' | 'high';

export interface AiOptions {
  model: string;
  effort: Effort;
}

/** A failure with a user-facing (Hebrew) message and an HTTP status. */
export class AiError extends Error {
  override name = 'AiError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type AiEvent = { type: 'progress'; chars: number };

/** Maps SDK errors to user-facing messages without leaking internals. */
export function toAiError(err: unknown, messages: { badRequest?: string; unexpected?: string } = {}): AiError {
  if (err instanceof AiError) return err;
  if (err instanceof Anthropic.RateLimitError) return new AiError('יותר מדי בקשות ל-AI כרגע, נסה שוב בעוד דקה', 429);
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AiError('מפתח ה-API של Claude לא תקין (ANTHROPIC_API_KEY)', 500);
  }
  if (err instanceof Anthropic.BadRequestError) return new AiError(messages.badRequest ?? 'הבקשה ל-Claude לא תקינה', 400);
  if (err instanceof Anthropic.APIConnectionError) return new AiError('אין חיבור ל-Claude, נסה שוב', 503);
  if (err instanceof Anthropic.APIError) return new AiError(`שגיאת Claude (${err.status ?? '?'})`, 502);
  console.error(err);
  return new AiError(messages.unexpected ?? 'שגיאה לא צפויה ב-AI', 500);
}

export interface StructuredCall<S extends z.ZodType> {
  system: string;
  content: Anthropic.Beta.BetaContentBlockParam[];
  schema: S;
  maxTokens?: number;
}

/**
 * One structured-output call. Streams so long generations never hit an HTTP
 * timeout, and reports progress so the UI can show it is alive. Refusals,
 * truncation and schema mismatches become AiError.
 */
export async function structuredCall<S extends z.ZodType>(
  client: Anthropic,
  call: StructuredCall<S>,
  opts: AiOptions,
  onEvent?: (event: AiEvent) => void,
): Promise<z.infer<S>> {
  const stream = client.beta.messages.stream({
    model: opts.model,
    max_tokens: call.maxTokens ?? 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: call.system,
    output_config: { effort: opts.effort, format: betaZodOutputFormat(call.schema) },
    messages: [{ role: 'user', content: call.content }],
  });

  let chars = 0;
  stream.on('text', (delta) => {
    chars += delta.length;
    onEvent?.({ type: 'progress', chars });
  });

  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') throw new AiError('Claude סירב לבקשה הזו. נסה לנסח אותה אחרת', 422);
  if (message.stop_reason === 'max_tokens') throw new AiError('התשובה נקטעה, נסה לבקש פחות', 502);

  const text = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AiError('Claude החזיר תשובה לא תקינה, נסה שוב', 502);
  }
  const parsed = call.schema.safeParse(data);
  if (!parsed.success) throw new AiError('Claude החזיר תשובה לא תקינה, נסה שוב', 502);
  return parsed.data;
}
