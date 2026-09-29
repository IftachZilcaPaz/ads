// @include _common.js
// Optimistic lock: the previous node wrote approval_ref = "claim:<execution id>".
// Re-reading the sheet tells us whether we still own the row (a double tap on
// Telegram, or an edit in the app, replaces or clears approval_ref).
const claim = `claim:${$execution.id}`;
const cfg = loadConfig();
const fresh = new Map($('Re-read Calendar').all().map((i) => [str(i.json.id), i.json]));

return $('Claim Posts').all().flatMap((item) => {
  const id = str(item.json.id);
  const row = fresh.get(id);
  const owned = !!row && str(row.approval_ref) === claim;
  const ok = owned && isApproved(row);
  // Not ours (someone else took the row): leave it completely alone.
  if (!owned) return [];
  return {
    json: {
      ...row,
      id,
      caption: cleanCaption(row.caption),
      // false = we hold the lock but approval was withdrawn meanwhile: release it.
      claimed: ok,
      ig_user_id: cfg.ig_user_id,
      access_token: cfg.access_token,
      telegram_chat_id: cfg.telegram_chat_id,
      app_url: cfg.app_url || '',
    },
  };
});
