// @include _common.js
// After claiming the row, make sure this execution still owns it, then carry
// the decision forward (single callback per execution).
const claim = `claim:${$execution.id}`;
const decided = $('Decide').first().json;
const row = $('Re-read Calendar').all().map((i) => i.json).find((r) => str(r.id) === decided.id);
if (!row || str(row.approval_ref) !== claim) {
  return [{ json: { ...decided, decision: 'stale', edit_text: `⚠️ ${decided.id}: הבקשה טופלה כבר (לחיצה כפולה?)` } }];
}
const cfg = loadConfig();
return [{
  json: {
    ...row,
    ...decided,
    caption: cleanCaption(row.caption),
    media_urls: row.media_urls,
    ig_user_id: cfg.ig_user_id,
    access_token: cfg.access_token,
  },
}];
