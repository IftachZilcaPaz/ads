// @include _common.js
// Hands the AI result (or its failure) back to the bot, tagged with the
// conversation nonce so a late or duplicate result is ignored.
const route = $('Route Update').first().json;
const asked = $('Ask Bot').first().json;
const r = $json || {};
const errorOf = (j) => (typeof j.error === 'string' ? j.error : j.error && j.error.message) || '';
const ok = Array.isArray(r.variants);
return [{
  json: {
    ...route,
    event: {
      kind: 'variants',
      chat_id: route.chat_id,
      nonce: str(asked.generate && asked.generate.nonce),
      ...(ok ? { result: r } : { error: str(errorOf(r)).slice(0, 900) || 'no response' }),
    },
  },
}];
