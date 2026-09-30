// @include _common.js
// Turns an uploaded Telegram photo/video into a caption request for the app.
//   "#campaign-id #product-id free text"  → AI caption, text is the brief
//   "!exact caption"                      → use the text verbatim, no AI
const cfg = loadConfig();
const media = $('Route Update').first().json;
const upload = $('Upload to Cloudinary').first().json;
if (!upload.secure_url) throw new Error('Cloudinary did not return secure_url: ' + JSON.stringify(upload).slice(0, 200));

const catalog = $('Read Catalog').first().json;
const campaigns = catalog.campaigns || [];
const products = catalog.products || [];
const brand = catalog.brand || {};

const text = media.text;
const verbatim = text.startsWith('!');
const tags = [...text.matchAll(/#([a-z0-9][a-z0-9_-]{1,39})/gi)].map((m) => m[1].toLowerCase());
const campaign = campaigns.find((c) => tags.includes(str(c.id).toLowerCase())) || null;
const product = products.find((p) => tags.includes(str(p.id).toLowerCase())) || null;
const brief = text.replace(/#[a-z0-9][a-z0-9_-]{1,39}/gi, ' ').replace(/\s+/g, ' ').trim();

const pick = (obj, keys) => (obj ? Object.fromEntries(keys.map((k) => [k, str(obj[k])])) : null);
const useAi = !verbatim && !!cfg.app_url && !!cfg.app_api_token;

return [{
  json: {
    use_ai: useAi,
    app_url: cfg.app_url.replace(/\/+$/, ''),
    app_api_token: cfg.app_api_token,
    media_url: upload.secure_url,
    is_video: media.is_video,
    chat_id: media.chat_id,
    campaign_id: campaign ? str(campaign.id) : '',
    product_id: product ? str(product.id) : '',
    fallback_caption: cleanCaption(verbatim ? text.slice(1).trim() : brief),
    brief,
    request: {
      media: [upload.secure_url],
      post_type: media.is_video ? 'REEL' : 'POST',
      brief,
      campaign: pick(campaign, ['id', 'name', 'status', 'start_date', 'end_date', 'goal', 'audience', 'key_message', 'offer', 'cta', 'hashtags', 'link', 'tone', 'notes']),
      product: pick(product, ['id', 'name', 'status', 'category', 'description', 'benefits', 'price', 'url', 'hashtags', 'notes']),
      brand,
      variants: 3,
    },
  },
}];
