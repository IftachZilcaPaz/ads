// @include _common.js
// Builds the draft row. Uses the first AI variant when available and falls
// back to the Telegram text if the AI call was skipped or failed.
const req = $('Build Caption Request').first().json;
const ai = $json && Array.isArray($json.variants) ? $json : null;

const compose = (v) => {
  const tags = [...new Set((v.hashtags || []).map((h) => '#' + String(h).replace(/^#+/, '').trim()).filter((h) => h.length > 1))];
  const body = cleanCaption(v.caption).trim();
  return tags.length ? `${body}\n\n${tags.slice(0, 30).join(' ')}` : body;
};

const variants = ai ? ai.variants.filter((v) => str(v.caption)) : [];
const caption = variants.length ? compose(variants[0]) : req.fallback_caption;
const now = toLocal();
const day = now.slice(0, 10);

const errorOf = (j) => (j && (typeof j.error === 'string' ? j.error : j.error && j.error.message)) || '';
const aiError = req.use_ai && !variants.length ? str(errorOf($json)) || 'no response' : '';
const alternatives = variants.slice(1).map((v, i) => `— גרסה ${i + 2} (${str(v.angle)}):\n${compose(v)}`).join('\n\n');

return [{
  json: {
    id: `${day}-${Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0')}`,
    type: req.is_video ? 'REEL' : 'POST',
    media_urls: req.media_url,
    caption,
    approval_mode: 'approve',
    status: 'draft',
    campaign_id: req.campaign_id,
    product_id: req.product_id,
    notes: req.brief ? `בריף מטלגרם: ${req.brief}`.slice(0, 500) : '',
    created_at: now,
    updated_at: now,
    chat_id: req.chat_id,
    app_url: req.app_url,
    ai_used: variants.length > 0,
    ai_error: aiError,
    alternatives,
  },
}];
