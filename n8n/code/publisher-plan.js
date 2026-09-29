// @include _common.js
// Decides, per calendar row, whether to publish now or to ask for approval.
// A row is published ONLY if: status=ready, approved, and publish_at has passed.
const cfg = loadConfig();
const now = toLocal();
const leadHours = Number(cfg.approval_lead_hours || 12);
const askBefore = addMinutesLocal(now, Math.max(0, leadHours) * 60);

const out = [];
for (const it of $('Read Calendar').all()) {
  const r = it.json;
  if (str(r.status) !== 'ready' || !str(r.id)) continue;
  const when = str(r.publish_at);
  if (!LOCAL_RE.test(when)) continue;

  const base = {
    ...r,
    id: str(r.id),
    caption: cleanCaption(r.caption),
    ig_user_id: cfg.ig_user_id,
    access_token: cfg.access_token,
    telegram_chat_id: cfg.telegram_chat_id,
    app_url: cfg.app_url || '',
  };

  if (isApproved(r)) {
    if (when <= now) out.push({ json: { ...base, route: 'publish' } });
  } else if (when <= askBefore) {
    // Not approved: never publish. Ask on Telegram ahead of time instead.
    const media = mediaList(r.media_urls);
    out.push({
      json: {
        ...base,
        route: 'ask',
        approval_ref: randomRef(),
        preview_url: cloudinaryStill(media[0]),
        media_count: media.length,
        overdue: when <= now,
      },
    });
  }
}
return out;
