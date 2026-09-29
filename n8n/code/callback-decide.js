// @include _common.js
// Interprets an approve/reject button press. Buttons carry "action:id:ref";
// the ref must match the row's current approval_ref, so a stale message (the
// post was edited, re-requested or already handled) can never approve content
// you did not see.
const input = $('Route Update').first().json;
const [action, id, ref = ''] = input.data.split(':');
const row = $('Read Calendar').all().map((i) => i.json).find((r) => str(r.id) === id);
const now = toLocal();

const result = (decision, answer, edit) => [{
  json: {
    ...(row || {}),
    id,
    decision,
    answer,
    edit_text: edit || answer,
    query_id: input.query_id,
    chat_id: input.chat_id,
    message_id: input.message_id,
    approved_at: decision === 'publish_now' || decision === 'approve_later' ? now : str(row && row.approved_at),
  },
}];

if (!row) return result('stale', 'הפוסט לא נמצא בלוח', `⚠️ ${id}: הפוסט לא נמצא בלוח`);
const status = str(row.status);
const validRef = str(row.approval_ref) === ref;
if (status !== 'pending_approval' || !validRef) {
  return result('stale', 'הבקשה הזאת כבר לא בתוקף', `⚠️ ${id}: הבקשה כבר לא בתוקף (סטטוס: ${status}). אם צריך - אשר מהלוח.`);
}
if (action === 'reject') return result('reject', 'נדחה', `❌ ${id} נדחה וחזר ללוח לעריכה`);
if (action !== 'approve') return result('stale', 'פעולה לא מוכרת');

const when = str(row.publish_at);
if (!LOCAL_RE.test(when) || when <= now) {
  return result('publish_now', 'מאושר - מפרסם עכשיו', `⏳ ${id} אושר - מפרסם עכשיו...`);
}
return result('approve_later', 'מאושר ✅', `✅ ${id} אושר ויעלה ב-${when}`);
