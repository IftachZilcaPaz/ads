import Anthropic from '@anthropic-ai/sdk';
import { CaptionRequestSchema } from '../shared/captions.ts';
import { readEnv, requireEnv } from './env.ts';
import { CaptionError, DEFAULT_MODEL, generateCaptions, toCaptionError, type Effort } from './captions-service.ts';
import { errorResponse, HttpError, json, readJson } from './http.ts';
import { isAuthorized, isSameOrigin } from './session.ts';

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high'];

export interface CaptionHandlerDeps {
  client: () => Anthropic;
  model: () => string;
  effort: () => Effort;
}

export const defaultCaptionDeps: CaptionHandlerDeps = {
  client: () => new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY'), maxRetries: 1 }),
  model: () => readEnv('CLAUDE_MODEL') ?? DEFAULT_MODEL,
  effort: () => {
    const value = readEnv('CLAUDE_EFFORT') as Effort | undefined;
    return value && EFFORTS.includes(value) ? value : 'medium';
  },
};

/**
 * POST /api/captions
 *   Accept: application/x-ndjson → streamed events (browser; keeps the
 *     connection alive for as long as generation takes):
 *       {"type":"progress","chars":123}
 *       {"type":"result","data":{...}} | {"type":"error","error":"..."}
 *   otherwise → a single JSON body (n8n / scripts).
 */
export async function handleCaptionRequest(req: Request, deps: CaptionHandlerDeps = defaultCaptionDeps): Promise<Response> {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const secrets = { sessionSecret: requireEnv('SESSION_SECRET'), apiToken: readEnv('API_TOKEN') };
    if (!(await isAuthorized(req, secrets))) throw new HttpError(401, 'צריך להתחבר');
    if (!isSameOrigin(req)) throw new HttpError(403, 'Cross-origin request blocked');

    const input = await readJson(req, CaptionRequestSchema);
    const client = deps.client();
    const opts = { model: deps.model(), effort: deps.effort() };

    if (!(req.headers.get('accept') ?? '').includes('application/x-ndjson')) {
      try {
        return json(await generateCaptions(client, input, opts));
      } catch (err) {
        const e = toCaptionError(err);
        return json({ error: e.message }, { status: e.status });
      }
    }

    const encoder = new TextEncoder();
    let lastProgress = 0;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        send({ type: 'progress', chars: 0 });
        try {
          const data = await generateCaptions(client, input, opts, (event) => {
            // Throttle: one progress line per ~200 chars is plenty for a spinner.
            if (event.chars - lastProgress >= 200) {
              lastProgress = event.chars;
              send(event);
            }
          });
          send({ type: 'result', data });
        } catch (err) {
          const e: CaptionError = toCaptionError(err);
          send({ type: 'error', error: e.message, status: e.status });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(body, {
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
