// @include _common.js
// Rows returned by request_approvals() are now 'pending_approval' with a fresh
// approval_ref. Build what the Telegram preview + buttons need.
const cfg = loadConfig();
const now = toLocal();
return $input.all().map((item) => {
  const r = item.json;
  const media = mediaList(r.media_urls);
  return {
    json: {
      ...r,
      caption: cleanCaption(r.caption),
      telegram_chat_id: cfg.telegram_chat_id,
      preview_url: cloudinaryStill(media[0]),
      media_count: media.length,
      overdue: str(r.publish_at) <= now,
    },
  };
});
