import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { CaptionError, generateCaptions } from '../src/server/captions-service.ts';
import { handleCaptionRequest } from '../src/server/captions-handler.ts';
import {
  CaptionRequestSchema,
  buildCaptionUserText,
  composeCaption,
  modelImageUrl,
} from '../src/shared/captions.ts';

const IMG = 'https://res.cloudinary.com/demo/image/upload/v17/folder/pic.png';

function fakeClient(message: Partial<Anthropic.Beta.BetaMessage>) {
  const create = vi.fn();
  const client = {
    beta: {
      messages: {
        stream: (params: unknown) => {
          create(params);
          const handlers: ((t: string) => void)[] = [];
          return {
            on: (_: string, h: (t: string) => void) => handlers.push(h),
            finalMessage: async () => {
              handlers.forEach((h) => h('{"x":'));
              return { stop_reason: 'end_turn', content: [], ...message };
            },
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, create };
}

const RESULT = {
  image_notes: 'ספה בסלון',
  alt_text: 'ספה אפורה',
  variants: [
    { angle: 'סיפור', caption: 'שורה — ראשונה', hashtags: ['#עיצוב', 'interior design', 'עיצוב'], why: 'כי' },
    { angle: 'ריק', caption: '   ', hashtags: [], why: '' },
  ],
};

describe('caption prompt', () => {
  it('resizes Cloudinary media for the model', () => {
    expect(modelImageUrl(IMG)).toBe('https://res.cloudinary.com/demo/image/upload/w_1280,c_limit,q_auto,f_jpg/v17/folder/pic.png');
    expect(modelImageUrl('https://res.cloudinary.com/demo/video/upload/v1/clip.mp4')).toBe(
      'https://res.cloudinary.com/demo/video/upload/so_1,w_1280,c_limit/v1/clip.jpg',
    );
    expect(modelImageUrl('https://example.com/a.jpg')).toBe('https://example.com/a.jpg');
  });

  it('includes only the context that exists, wrapped as data', () => {
    const req = CaptionRequestSchema.parse({
      media: [IMG],
      brief: 'השקה',
      campaign: { name: 'חורף', key_message: 'חם בבית' },
      brand: { name: 'Rey', voice: 'חם' },
    });
    const text = buildCaptionUserText(req);
    expect(text).toContain('<campaign>');
    expect(text).toContain('- מסר מרכזי: חם בבית');
    expect(text).not.toContain('<product>');
    expect(text).toContain('<brief>\nהשקה\n</brief>');
    expect(text).toContain('כתוב 3 גרסאות');
  });

  it('supports refining an existing caption', () => {
    const req = CaptionRequestSchema.parse({ media: [IMG], variants: 2, refine: { caption: 'ישן', instruction: 'קצר יותר' } });
    expect(buildCaptionUserText(req)).toContain('שכתב את הקפשן הבא');
  });

  it('rejects non-https media', () => {
    expect(CaptionRequestSchema.safeParse({ media: ['http://x.com/a.jpg'] }).success).toBe(false);
  });

  it('composes the publishable caption', () => {
    expect(composeCaption({ caption: 'טקסט — כאן', hashtags: ['a', '#b', 'a'] })).toBe('טקסט - כאן\n\n#a #b');
  });
});

describe('generateCaptions', () => {
  const input = CaptionRequestSchema.parse({ media: [IMG, IMG, IMG, IMG, IMG] });
  const opts = { model: 'claude-opus-5-5', effort: 'medium' as const };

  it('sends images + structured output request and normalizes the result', async () => {
    const { client, create } = fakeClient({ content: [{ type: 'text', text: JSON.stringify(RESULT), citations: null }] });
    const progress = vi.fn();
    const result = await generateCaptions(client, input, opts, progress);

    const params = create.mock.calls[0]![0];
    expect(params.model).toBe('claude-opus-5-5');
    expect(params.fallbacks).toBe('default');
    expect(params.output_config.effort).toBe('medium');
    expect(params.output_config.format.type).toBe('json_schema');
    expect(params.messages[0].content.filter((b: { type: string }) => b.type === 'image')).toHaveLength(4);
    expect(progress).toHaveBeenCalled();

    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]).toMatchObject({ caption: 'שורה - ראשונה', hashtags: ['עיצוב', 'interior_design'] });
  });

  it('surfaces refusals and malformed output as CaptionError', async () => {
    const refused = fakeClient({ stop_reason: 'refusal' });
    await expect(generateCaptions(refused.client, input, opts)).rejects.toBeInstanceOf(CaptionError);
    const garbage = fakeClient({ content: [{ type: 'text', text: 'not json', citations: null }] });
    await expect(generateCaptions(garbage.client, input, opts)).rejects.toThrow(/לא תקינה/);
  });
});

describe('caption endpoint', () => {
  process.env.SESSION_SECRET = 'z'.repeat(40);
  process.env.API_TOKEN = 'tok';
  const deps = {
    client: () => fakeClient({ content: [{ type: 'text', text: JSON.stringify(RESULT), citations: null }] }).client,
    model: () => 'm',
    effort: () => 'low' as const,
  };
  const request = (headers: Record<string, string>) =>
    new Request('https://app.example/api/captions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ media: [IMG] }),
    });

  it('rejects anonymous callers', async () => {
    expect((await handleCaptionRequest(request({}), deps)).status).toBe(401);
  });

  it('returns JSON for automation clients', async () => {
    const res = await handleCaptionRequest(request({ authorization: 'Bearer tok' }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).variants).toHaveLength(1);
  });

  it('streams NDJSON events for the browser', async () => {
    const res = await handleCaptionRequest(request({ authorization: 'Bearer tok', accept: 'application/x-ndjson' }), deps);
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({ type: 'progress', chars: 0 });
    expect(lines.at(-1).type).toBe('result');
  });
});
