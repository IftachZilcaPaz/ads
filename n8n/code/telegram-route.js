// @include _common.js
// Only the owner's chat may drive the bot. Anyone else is silently ignored,
// so strangers cannot create drafts or press approval buttons.
//   approval buttons ("action:id:ref")  → handled here in n8n (decide_approval)
//   photo / video                        → Cloudinary, then the app's bot
//   anything else (text, "b|..." buttons) → the app's bot (/api/bot)
const cfg = loadConfig();
const update = $('Telegram Trigger').first().json;
const owner = str(cfg.telegram_chat_id);

const cb = update.callback_query;
const msg = update.message;
const fromChat = str(cb ? cb.message && cb.message.chat && cb.message.chat.id : msg && msg.chat && msg.chat.id);
if (!owner || fromChat !== owner) return [];

const app = { chat_id: fromChat, app_url: str(cfg.app_url).replace(/\/+$/, ''), app_api_token: str(cfg.app_api_token) };
const toBot = (event) => {
  if (!app.app_url || !app.app_api_token) throw new Error('Missing app_url / app_api_token in settings (npm run db:set)');
  return [{ json: { kind: 'bot', ...app, event: { chat_id: fromChat, ...event } } }];
};

if (cb) {
  const data = str(cb.data);
  if (data.startsWith('b|')) return toBot({ kind: 'button', data, message_id: cb.message.message_id, query_id: str(cb.id) });
  // Buttons carry "action:id:ref" (old messages: "action:id").
  const [action = '', id = '', ref = ''] = data.split(':');
  return [{ json: { kind: 'callback', action, id, ref, query_id: cb.id, chat_id: fromChat, message_id: cb.message.message_id } }];
}

const text = str(msg.caption || msg.text);
let file = null;
if (msg.photo && msg.photo.length) file = { file_id: msg.photo[msg.photo.length - 1].file_id, is_video: false };
else if (msg.video) file = { file_id: msg.video.file_id, is_video: true };
else if (msg.document && /^(image|video)\//.test(msg.document.mime_type || '')) {
  file = { file_id: msg.document.file_id, is_video: /^video\//.test(msg.document.mime_type) };
}

if (file) {
  return [{
    json: { kind: 'media', ...file, text, ...app, cloudinary_cloud: cfg.cloudinary_cloud || '', cloudinary_preset: cfg.cloudinary_preset || '' },
  }];
}
return toBot({ kind: 'text', text });
