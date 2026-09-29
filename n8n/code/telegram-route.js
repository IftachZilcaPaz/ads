// @include _common.js
// Only the owner's chat may drive the bot. Anyone else is silently ignored,
// so strangers cannot create drafts or press approval buttons.
const cfg = loadConfig();
const update = $('Telegram Trigger').first().json;
const owner = str(cfg.telegram_chat_id);

const cb = update.callback_query;
const msg = update.message;
const fromChat = str(cb ? cb.message && cb.message.chat && cb.message.chat.id : msg && msg.chat && msg.chat.id);
if (!owner || fromChat !== owner) return [];

if (cb) {
  return [{ json: { kind: 'callback', data: str(cb.data), query_id: cb.id, chat_id: fromChat, message_id: cb.message.message_id } }];
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
    json: { kind: 'media', ...file, text, chat_id: fromChat, cloudinary_cloud: cfg.cloudinary_cloud || '', cloudinary_preset: cfg.cloudinary_preset || '' },
  }];
}
return [{ json: { kind: 'other', text, chat_id: fromChat, app_url: cfg.app_url || '' } }];
