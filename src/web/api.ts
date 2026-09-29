import type { Brand, Campaign, Product } from '../shared/catalog.ts';
import type { CaptionRequest, CaptionResult } from '../shared/captions.ts';
import type { NewPostInput, Post, PostAction, PostChanges } from '../shared/post.ts';
import type { PublicSettings, Snapshot } from '../server/store.ts';

export type { Snapshot, PublicSettings };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: string[] = [],
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? null : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('אין חיבור לשרת', 0);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; details?: unknown };
  if (!res.ok) {
    if (res.status === 401 && !path.endsWith('/login')) onUnauthorized();
    const details = Array.isArray(data.details) ? data.details.map(String) : [];
    throw new ApiError(data.error ?? `שגיאה (${res.status})`, res.status, details);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  session: () => request<{ authenticated: boolean }>('GET', '/api/session'),
  login: (password: string) => request<{ ok: true }>('POST', '/api/login', { password }),
  logout: () => request<{ ok: true }>('POST', '/api/logout'),
  bootstrap: () => request<Snapshot>('GET', '/api/bootstrap'),

  createPost: (input: NewPostInput) => request<Post>('POST', '/api/posts', input),
  editPost: (id: string, changes: PostChanges) => request<Post>('PATCH', `/api/posts/${enc(id)}`, changes),
  act: (id: string, action: PostAction) => request<Post>('POST', `/api/posts/${enc(id)}/${action}`),
  duplicate: (id: string) => request<Post>('POST', `/api/posts/${enc(id)}/duplicate`),
  bulk: (ids: string[], action: PostAction) =>
    request<{ updated: Post[]; failed: { id: string; error: string }[] }>('POST', '/api/posts-bulk', { ids, action }),

  saveCampaign: (c: Partial<Campaign>, id?: string) =>
    id ? request<Campaign>('PUT', `/api/campaigns/${enc(id)}`, c) : request<Campaign>('POST', '/api/campaigns', c),
  saveProduct: (p: Partial<Product>, id?: string) =>
    id ? request<Product>('PUT', `/api/products/${enc(id)}`, p) : request<Product>('POST', '/api/products', p),
  saveBrand: (b: Brand) => request<Brand>('PUT', '/api/brand', b),

  /** Reads the NDJSON event stream from the caption edge function. */
  async captions(req: CaptionRequest, onProgress: (chars: number) => void, signal?: AbortSignal): Promise<CaptionResult> {
    let res: Response;
    try {
      res = await fetch('/api/captions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify(req),
        signal: signal ?? null,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new ApiError('אין חיבור לשרת', 0);
    }
    if (!res.ok || !res.body) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 401) onUnauthorized();
      throw new ApiError(data.error ?? `שגיאה (${res.status})`, res.status);
    }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += value;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const event = JSON.parse(line) as
          | { type: 'progress'; chars: number }
          | { type: 'result'; data: CaptionResult }
          | { type: 'error'; error: string; status?: number };
        if (event.type === 'progress') onProgress(event.chars);
        else if (event.type === 'result') return event.data;
        else throw new ApiError(event.error, event.status ?? 500);
      }
      if (done) break;
    }
    throw new ApiError('החיבור נקטע לפני שהתקבלה תשובה', 502);
  },
};

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Browser → Cloudinary direct upload (unsigned preset). The file never passes
 * through our functions, so there is no body-size limit on our side.
 */
export function uploadToCloudinary(
  file: File,
  settings: PublicSettings,
  onProgress: (fraction: number) => void,
): Promise<string> {
  if (!settings.cloudinary_cloud || !settings.cloudinary_preset) {
    return Promise.reject(new ApiError('חסרים cloudinary_cloud / cloudinary_preset בלשונית config', 0));
  }
  if (!/^(image|video)\//.test(file.type)) return Promise.reject(new ApiError(`${file.name}: רק תמונות או וידאו`, 0));
  if (file.size > MAX_UPLOAD_BYTES) return Promise.reject(new ApiError(`${file.name}: קובץ גדול מ-100MB`, 0));

  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    form.append('upload_preset', settings.cloudinary_preset);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `https://api.cloudinary.com/v1_1/${encodeURIComponent(settings.cloudinary_cloud)}/auto/upload`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      const body = JSON.parse(xhr.responseText || '{}') as { secure_url?: string; error?: { message?: string } };
      if (xhr.status < 300 && body.secure_url) resolve(body.secure_url);
      else reject(new ApiError(`העלאה נכשלה: ${body.error?.message ?? xhr.status}`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('העלאה נכשלה (רשת)', 0));
    xhr.send(form);
  });
}
