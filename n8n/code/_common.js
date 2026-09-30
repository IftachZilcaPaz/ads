// ---- shared helpers (inlined into every code node by scripts/build-n8n.mjs) ----
const TZ = 'Asia/Jerusalem';
const LOCAL_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

/** Israel wall-clock "YYYY-MM-DD HH:mm"; comparable as plain strings. */
const toLocal = (date = new Date()) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date).replace(' 24:', ' 00:');

const addMinutesLocal = (value, minutes) => {
  const [d, t] = value.split(' ');
  const [y, m, day] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, day, hh, mm + minutes)).toISOString().slice(0, 16).replace('T', ' ');
};

/** key/value rows of the `config` tab → object. */
const loadConfig = (nodeName = 'Load Config') => {
  const cfg = {};
  for (const it of $(nodeName).all()) {
    if (it.json.key) cfg[String(it.json.key).trim()] = String(it.json.value ?? '').trim();
  }
  return cfg;
};

const str = (v) => String(v ?? '').trim();
const cleanCaption = (s) => String(s ?? '').replace(/[—–]/g, '-');
const mediaList = (s) => str(s).split(/[\s,]+/).filter(Boolean);
const isVideoUrl = (u) => /\.(mp4|mov|m4v|webm)(\?|#|$)/i.test(u) || /\/video\/upload\//.test(u);

/** Approved = explicit approval stamp, or a standing "auto" approval. */
const isApproved = (r) => str(r.approval_mode) === 'auto' || str(r.approved_at) !== '';

/** Small JPEG still of a Cloudinary image/video (Telegram previews, thumbnails). */
const cloudinaryStill = (url, width = 1080) => {
  const m = /^(https:\/\/res\.cloudinary\.com\/[^/]+)\/(image|video)\/upload\/(.+)$/.exec(url || '');
  if (!m) return url || '';
  if (m[2] === 'video') return `${m[1]}/video/upload/so_1,w_${width},c_limit/${m[3].replace(/\.[a-z0-9]+(\?.*)?$/i, '')}.jpg`;
  return `${m[1]}/image/upload/w_${width},c_limit,q_auto,f_jpg/${m[3]}`;
};

// Instagram takes only JPEG, and feed images only between 4:5 and 1.91:1.
// Cloudinary pads outliers (never crops) and converts, at delivery time.
const IG_FEED_FIT = 'if_ar_lt_0.8/c_pad,ar_4:5,b_auto/if_end/if_ar_gt_1.91/c_pad,ar_1.91,b_auto/if_end/';
const igImage = (url, { feed = true } = {}) => {
  const m = /^(https:\/\/res\.cloudinary\.com\/[^/]+)\/image\/upload\/(.+)$/.exec(url || '');
  if (!m) return url || '';
  const path = m[2].replace(/\.[a-z0-9]+(\?.*)?$/i, '');
  return `${m[1]}/image/upload/${feed ? IG_FEED_FIT : ''}c_limit,w_1440/q_auto:good/${path}.jpg`;
};

const randomRef = () => Math.random().toString(36).slice(2, 8);
// ---- end shared helpers ----
