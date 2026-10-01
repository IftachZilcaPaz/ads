import type Anthropic from '@anthropic-ai/sdk';
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
import { AiError, structuredCall, toAiError, type AiEvent, type AiOptions } from './ai.ts';

export { DEFAULT_MODEL, type Effort } from './ai.ts';
export { AiError as CaptionError };
export type CaptionOptions = AiOptions;
export type CaptionEvent = AiEvent;

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

export function toCaptionError(err: unknown): AiError {
  return toAiError(err, {
    badRequest: 'Claude לא הצליח לקרוא את המדיה. ודא שהקישור ציבורי ושזה קובץ תמונה/וידאו',
    unexpected: 'שגיאה לא צפויה ביצירת הקפשן',
  });
}

/** Images + brand/campaign/product context in, N caption variants out. */
export async function generateCaptions(
  client: Anthropic,
  input: ParsedCaptionRequest,
  opts: CaptionOptions,
  onEvent?: (event: CaptionEvent) => void,
): Promise<CaptionResult> {
  const images: Anthropic.Beta.BetaImageBlockParam[] = input.media
    .slice(0, MAX_IMAGES_FOR_MODEL)
    .map((url) => ({ type: 'image', source: { type: 'url', url: modelImageUrl(url) } }));

  const result = normalize(
    await structuredCall(
      client,
      {
        system: CAPTION_SYSTEM_PROMPT,
        content: [...images, { type: 'text', text: buildCaptionUserText(input) }],
        schema: CaptionResultSchema,
      },
      opts,
      onEvent,
    ),
  );
  if (!result.variants.length) throw new AiError('לא התקבלו גרסאות, נסה שוב', 502);
  return result;
}
