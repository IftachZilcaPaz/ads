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
