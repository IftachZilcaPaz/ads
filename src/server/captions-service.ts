import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import {
  CAPTION_SYSTEM_PROMPT,
  CaptionResultSchema,
  MAX_IMAGES_FOR_MODEL,
  buildCaptionUserText,
  modelImageUrl,
  type CaptionResult,
  type ParsedCaptionRequest,
} from '../shared/captions.ts';
import { cleanCaption } from '../shared/post.ts';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export type Effort = 'low' | 'medium' | 'high';

export interface CaptionOptions {
  model: string;
  effort: Effort;
}

export class CaptionError extends Error {
  override name = 'CaptionError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type CaptionEvent = { type: 'progress'; chars: number };

function normalize(result: CaptionResult): CaptionResult {
  return {
    image_notes: result.image_notes.trim(),
    alt_text: result.alt_text.trim().slice(0, 300),
    variants: result.variants
      .filter((v) => v.caption.trim())
      .map((v) => ({
        angle: v.angle.trim(),
        caption: cleanCaption(v.caption).trim(),
        hashtags: [...new Set(v.hashtags.map((h) => h.trim().replace(/^#+/, '').replace(/\s+/g, '_')).filter(Boolean))],
        why: v.why.trim(),
      })),
  };
}

/** Maps SDK errors to user-facing (Hebrew) messages without leaking internals. */
export function toCaptionError(err: unknown): CaptionError {
  if (err instanceof CaptionError) return err;
  if (err instanceof Anthropic.RateLimitError) return new CaptionError('יותר מדי בקשות ל-AI כרגע, נסה שוב בעוד דקה', 429);
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new CaptionError('מפתח ה-API של Claude לא תקין (ANTHROPIC_API_KEY)', 500);
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new CaptionError('Claude לא הצליח לקרוא את המדיה. ודא שהקישור ציבורי ושזה קובץ תמונה/וידאו', 400);
  }
  if (err instanceof Anthropic.APIConnectionError) return new CaptionError('אין חיבור ל-Claude, נסה שוב', 503);
  if (err instanceof Anthropic.APIError) return new CaptionError(`שגיאת Claude (${err.status ?? '?'})`, 502);
  console.error(err);
  return new CaptionError('שגיאה לא צפויה ביצירת הקפשן', 500);
}

/**
 * One structured-output call: images + brand/campaign/product context in,
 * N caption variants out. Streams so long generations never hit an HTTP
 * timeout, and reports progress so the UI can show it is alive.
 */
export async function generateCaptions(
  client: Anthropic,
  input: ParsedCaptionRequest,
  opts: CaptionOptions,
  onEvent?: (event: CaptionEvent) => void,
): Promise<CaptionResult> {
  const images: Anthropic.Beta.BetaImageBlockParam[] = input.media
    .slice(0, MAX_IMAGES_FOR_MODEL)
    .map((url) => ({ type: 'image', source: { type: 'url', url: modelImageUrl(url) } }));

  const stream = client.beta.messages.stream({
    model: opts.model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: CAPTION_SYSTEM_PROMPT,
    output_config: { effort: opts.effort, format: betaZodOutputFormat(CaptionResultSchema) },
    messages: [{ role: 'user', content: [...images, { type: 'text', text: buildCaptionUserText(input) }] }],
  });

  let chars = 0;
  stream.on('text', (delta) => {
    chars += delta.length;
    onEvent?.({ type: 'progress', chars });
  });

  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') {
    throw new CaptionError('Claude סירב לכתוב לתוכן הזה. נסה לנסח את הבריף אחרת', 422);
  }
  if (message.stop_reason === 'max_tokens') throw new CaptionError('התשובה נקטעה, נסה פחות גרסאות', 502);

  const text = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new CaptionError('Claude החזיר תשובה לא תקינה, נסה שוב', 502);
  }
  const parsed = CaptionResultSchema.safeParse(data);
  if (!parsed.success) throw new CaptionError('Claude החזיר תשובה לא תקינה, נסה שוב', 502);
  const result = normalize(parsed.data);
  if (!result.variants.length) throw new CaptionError('לא התקבלו גרסאות, נסה שוב', 502);
  return result;
}
