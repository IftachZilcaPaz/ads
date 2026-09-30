// @include _common.js
// decide_approval() already applied the decision atomically (stale buttons and
// double taps come back as 'stale'). Turn it into Telegram texts and, for
// 'publish_now', the fields the publisher needs.
const input = $('Route Update').first().json;
const r = $('Decide').first().json.result || {};
const cfg = loadConfig();
const id = str(r.id) || input.id;

const TEXTS = {
  publish_now: ['מאושר - מפרסם עכשיו', `⏳ ${id} אושר - מפרסם עכשיו...`],
  approve_later: ['מאושר ✅', `✅ ${id} אושר ויעלה ב-${str(r.publish_at)}`],
  reject: ['נדחה', `❌ ${id} נדחה וחזר ללוח לעריכה`],
  stale: ['הבקשה הזאת כבר לא בתוקף', `⚠️ ${id}: הבקשה כבר לא בתוקף${r.status ? ` (סטטוס: ${r.status})` : ''}. אם צריך - אשר מהלוח.`],
};
const decision = TEXTS[r.decision] ? r.decision : 'stale';

return [{
  json: {
    ...r,
    id,
    decision,
    answer: TEXTS[decision][0],
    edit_text: TEXTS[decision][1],
    query_id: input.query_id,
    chat_id: input.chat_id,
    message_id: input.message_id,
    caption: cleanCaption(r.caption),
    ig_user_id: cfg.ig_user_id,
    access_token: cfg.access_token,
    telegram_chat_id: cfg.telegram_chat_id,
  },
}];
