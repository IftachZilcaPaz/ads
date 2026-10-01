import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { AiError, DEFAULT_MODEL, type AiEvent, type AiOptions, type Effort } from './ai.ts';
import { readEnv, requireEnv } from './env.ts';
import { errorResponse, HttpError, json, readJson } from './http.ts';
import { isAuthorized, isSameOrigin } from './session.ts';

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high'];

export interface AiHandlerDeps {
  client: () => Anthropic;
  model: () => string;
  effort: () => Effort;
}

export const defaultAiDeps: AiHandlerDeps = {
  client: () => new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY'), maxRetries: 1 }),
  model: () => readEnv('CLAUDE_MODEL') ?? DEFAULT_MODEL,
  effort: () => {
    const value = readEnv('CLAUDE_EFFORT') as Effort | undefined;
    return value && EFFORTS.includes(value) ? value : 'medium';
  },
};

export interface AiEndpoint<S extends z.ZodType> {
  schema: S;
  generate: (client: Anthropic, input: z.output<S>, opts: AiOptions, onEvent: (e: AiEvent) => void) => Promise<unknown>;
  toError: (err: unknown) => AiError;
  /** Overrides the configured effort (e.g. planning benefits from more thought). */
  effort?: Effort;
}

/**
 * POST handler shared by the AI endpoints.
 *   Accept: application/x-ndjson → streamed events (browser; keeps the
 *     connection alive for as long as generation takes):
 *       {"type":"progress","chars":123}
 *       {"type":"result","data":{...}} | {"type":"error","error":"..."}
 *   otherwise → a single JSON body (n8n / scripts).
 */
export async function handleAiRequest<S extends z.ZodType>(req: Request, endpoint: AiEndpoint<S>, deps: AiHandlerDeps): Promise<Response> {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const secrets = { sessionSecret: requireEnv('SESSION_SECRET'), apiToken: readEnv('API_TOKEN') };
    if (!(await isAuthorized(req, secrets))) throw new HttpError(401, 'צריך להתחבר');
    if (!isSameOrigin(req)) throw new HttpError(403, 'Cross-origin request blocked');

    const input = await readJson(req, endpoint.schema);
    const client = deps.client();
    const opts: AiOptions = { model: deps.model(), effort: endpoint.effort ?? deps.effort() };

    if (!(req.headers.get('accept') ?? '').includes('application/x-ndjson')) {
      try {
        return json(await endpoint.generate(client, input, opts, () => {}));
      } catch (err) {
        const e = endpoint.toError(err);
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
          const data = await endpoint.generate(client, input, opts, (event) => {
            // Throttle: one progress line per ~200 chars is plenty for a spinner.
            if (event.chars - lastProgress >= 200) {
              lastProgress = event.chars;
              send(event);
            }
          });
          send({ type: 'result', data });
        } catch (err) {
          const e = endpoint.toError(err);
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
