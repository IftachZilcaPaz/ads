// @include _common.js
// Publishes ONE item to Instagram via the Graph API. Never throws: returns
// status "published" or "failed" with Meta's real error message.
const j = @@ITEM@@;
const token = j.access_token;
const igId = j.ig_user_id;
const G = 'https://graph.facebook.com/v26.0';

// Already on Instagram (double click / retry after partial failure): don't post twice.
if (str(j.ig_media_id)) {
  return { json: { ...j, status: 'published', error: '' } };
}

const api = async (method, path, qs) => {
  const res = await this.helpers.httpRequest({
    method,
    url: `${G}/${path}`,
    qs: { ...qs, access_token: token },
    json: true,
    returnFullResponse: true,
    ignoreHttpStatusErrors: true,
  });
  const body = res && res.body !== undefined ? res.body : res;
  if (body && body.error) {
    const er = body.error;
    throw new Error(`Meta ${er.code || ''}${er.error_subcode ? '/' + er.error_subcode : ''}: ${er.message || JSON.stringify(er)}`);
  }
  if (res && res.statusCode >= 400) throw new Error(`HTTP ${res.statusCode}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const waitReady = async (creationId, everyMs, tries) => {
  for (let i = 0; i < tries; i++) {
    const s = await api('GET', creationId, { fields: 'status_code' });
    if (s.status_code === 'FINISHED') return;
    if (s.status_code === 'ERROR') throw new Error('Media processing failed');
    await wait(everyMs);
  }
  throw new Error('Timed out waiting for media processing');
};

const caption = cleanCaption(j.caption);
const urls = mediaList(j.media_urls);
const type = str(j.type || 'POST').toUpperCase();

try {
  if (!token || !igId) throw new Error('Missing access_token / ig_user_id in config tab');
  if (!urls.length) throw new Error(`Row ${j.id}: media_urls is empty`);

  let creationId;
  if (type === 'CAROUSEL') {
    const children = [];
    for (const u of urls) {
      const qs = isVideoUrl(u)
        ? { media_type: 'VIDEO', video_url: u, is_carousel_item: true }
        : { image_url: igImage(u), is_carousel_item: true };
      const c = await api('POST', `${igId}/media`, qs);
      if (isVideoUrl(u)) await waitReady(c.id, 10000, 40);
      children.push(c.id);
    }
    const parent = await api('POST', `${igId}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption });
    creationId = parent.id;
  } else if (type === 'REEL') {
    const c = await api('POST', `${igId}/media`, { media_type: 'REELS', video_url: urls[0], caption });
    creationId = c.id;
    await waitReady(creationId, 15000, 40);
  } else if (type === 'STORY') {
    const qs = isVideoUrl(urls[0])
      ? { media_type: 'STORIES', video_url: urls[0] }
      : { media_type: 'STORIES', image_url: igImage(urls[0], { feed: false }) };
    const c = await api('POST', `${igId}/media`, qs);
    creationId = c.id;
    if (isVideoUrl(urls[0])) await waitReady(creationId, 15000, 40);
  } else {
    const c = await api('POST', `${igId}/media`, { image_url: igImage(urls[0]), caption });
    creationId = c.id;
  }

  // Images also need a moment of processing before publishing (error 9007).
  await waitReady(creationId, 4000, 30);

  let pub;
  for (let i = 0; ; i++) {
    try {
      pub = await api('POST', `${igId}/media_publish`, { creation_id: creationId });
      break;
    } catch (e) {
      if (i < 5 && /9007|Media ID is not available/.test(String(e.message))) {
        await wait(5000);
        continue;
      }
      throw e;
    }
  }

  let permalink = '';
  try {
    permalink = (await api('GET', pub.id, { fields: 'permalink' })).permalink || '';
  } catch (e) {
    // Non-fatal: the post is live even if we cannot read its link.
  }
  return { json: { ...j, status: 'published', ig_media_id: pub.id, permalink, error: '', updated_at: toLocal() } };
} catch (e) {
  return { json: { ...j, status: 'failed', error: String(e.message || e).slice(0, 500), updated_at: toLocal() } };
}
