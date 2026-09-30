// @include _common.js
// Rows returned by claim_due_posts() are already locked as 'publishing' in the
// database. Attach the Meta credentials the publisher needs.
const cfg = loadConfig();
return $input.all().map((item) => ({
  json: {
    ...item.json,
    caption: cleanCaption(item.json.caption),
    ig_user_id: cfg.ig_user_id,
    access_token: cfg.access_token,
    telegram_chat_id: cfg.telegram_chat_id,
  },
}));
