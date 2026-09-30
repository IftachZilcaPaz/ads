// The uploaded file becomes a "media" event for the app's bot, which asks the questions.
const media = $('Route Update').first().json;
const upload = $json;
if (!upload.secure_url) throw new Error('Cloudinary did not return secure_url: ' + JSON.stringify(upload).slice(0, 200));
return [{
  json: {
    ...media,
    event: { kind: 'media', chat_id: media.chat_id, media_url: upload.secure_url, is_video: media.is_video, text: media.text },
  },
}];
