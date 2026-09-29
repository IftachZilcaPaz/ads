// @include _common.js
// Daily health check + tomorrow's digest. Silent when there is nothing to say.
const cfg = loadConfig();
const now = toLocal();
const tomorrow = addMinutesLocal(`${now.slice(0, 10)} 00:00`, 24 * 60).slice(0, 10);
const grace = addMinutesLocal(now, -45);

const rows = $('Read Calendar').all().map((i) => i.json).filter((r) => str(r.id));
const line = (r) => `• ${str(r.publish_at).slice(11) || '--:--'} ${str(r.id)} ${cleanCaption(r.caption).replace(/\s+/g, ' ').slice(0, 40)}`;

const problems = [];
for (const r of rows) {
  const st = str(r.status);
  const when = str(r.publish_at);
  const due = LOCAL_RE.test(when) && when <= grace;
  if (!due) continue;
  if (st === 'ready' && isApproved(r)) problems.push(`🚨 מאושר ולא עלה: ${r.id} (${when})`);
  else if (st === 'publishing') problems.push(`🚨 תקוע בפרסום: ${r.id} (${when})`);
  else if (st === 'pending_approval') problems.push(`⏳ מחכה לאישור שלך ועבר הזמן: ${r.id} (${when})`);
  else if (st === 'ready') problems.push(`⏳ לא אושר ועבר הזמן: ${r.id} (${when})`);
  else if (st === 'failed' && when.slice(0, 10) === now.slice(0, 10)) problems.push(`❌ נכשל היום: ${r.id} - ${str(r.error).slice(0, 120)}`);
}

const tmr = rows
  .filter((r) => str(r.publish_at).startsWith(tomorrow) && ['ready', 'pending_approval'].includes(str(r.status)))
  .sort((a, b) => str(a.publish_at).localeCompare(str(b.publish_at)));
const approved = tmr.filter((r) => str(r.status) === 'ready' && isApproved(r));
const waiting = tmr.filter((r) => !(str(r.status) === 'ready' && isApproved(r)));

const parts = [];
if (problems.length) parts.push(`בדיקת מערכת:\n${problems.join('\n')}`);
if (tmr.length) {
  let digest = `📅 מחר (${tomorrow}): ${tmr.length} פוסטים`;
  if (approved.length) digest += `\n✅ מאושרים:\n${approved.map(line).join('\n')}`;
  if (waiting.length) digest += `\n⏳ מחכים לאישור שלך (לא יעלו בלי אישור):\n${waiting.map(line).join('\n')}`;
  parts.push(digest);
}
if (!parts.length) return [];
if (cfg.app_url && (waiting.length || problems.length)) parts.push(`לאישור בלוח: ${cfg.app_url}`);
return [{ json: { telegram_chat_id: cfg.telegram_chat_id, text: parts.join('\n\n') } }];
