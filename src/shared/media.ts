const CLOUDINARY_RE = /^(https:\/\/res\.cloudinary\.com\/[^/]+)\/(image|video)\/upload\/(.+)$/;

/**
 * A resized JPEG still of a Cloudinary asset (first second of a video).
 * Non-Cloudinary URLs are returned unchanged.
 */
export function cloudinaryStill(url: string, width: number): string {
  const m = CLOUDINARY_RE.exec(url);
  if (!m) return url;
  const [, base, kind, rest] = m as unknown as [string, string, string, string];
  if (kind === 'video') {
    return `${base}/video/upload/so_1,w_${width},c_limit/${rest.replace(/\.[a-z0-9]+(\?.*)?$/i, '')}.jpg`;
  }
  return `${base}/image/upload/w_${width},c_limit,q_auto,f_jpg/${rest}`;
}

/** Same delivery transformation the n8n Publisher sends to Instagram (n8n/code/_common.js). */
export const IG_FEED_FIT = 'if_ar_lt_0.8/c_pad,ar_4:5,b_auto/if_end/if_ar_gt_1.91/c_pad,ar_1.91,b_auto/if_end/';

/** JPEG, max 1440 wide, and for feed padded (never cropped) into 4:5-1.91:1. */
export function igImage(url: string, { feed = true } = {}): string {
  const m = /^(https:\/\/res\.cloudinary\.com\/[^/]+)\/image\/upload\/(.+)$/.exec(url);
  if (!m) return url;
  const path = m[2]!.replace(/\.[a-z0-9]+(\?.*)?$/i, '');
  return `${m[1]}/image/upload/${feed ? IG_FEED_FIT : ''}c_limit,w_1440/q_auto:good/${path}.jpg`;
}
