// @include _common.js
// The exchange endpoint returns a fresh 60-day token; persist it (and when).
const res = $json;
if (!res || !res.access_token) {
  throw new Error('Meta token exchange failed: ' + JSON.stringify(res && res.error ? res.error : res).slice(0, 300));
}
const days = res.expires_in ? Math.round(Number(res.expires_in) / 86400) : 60;
return [
  { json: { key: 'access_token', value: res.access_token, days } },
  { json: { key: 'access_token_refreshed_at', value: toLocal(), days } },
];
