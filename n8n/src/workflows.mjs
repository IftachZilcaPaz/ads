// Source of truth for the n8n workflows. `npm run n8n:build` renders these to
// n8n/workflows/*.json (placeholders) and n8n/dist/*.json (your real IDs).
import {
  OWNER_CHAT,
  code,
  errorTrigger,
  http,
  ifEquals,
  pg,
  schedule,
  tgAnswer,
  tgEdit,
  tgFile,
  tgMessage,
  tgPhoto,
  tgTrigger,
  workflow,
} from './nodes.mjs';

const TZ = 'Asia/Jerusalem';
const approveButtons = (src) => [
  ['✅ אשר', `=approve:{{ ${src}.id }}:{{ ${src}.approval_ref }}`],
  ['❌ דחה', `=reject:{{ ${src}.id }}:{{ ${src}.approval_ref }}`],
];

const LOAD_CONFIG = 'select key, value from settings';
export const PUBLISH_TRIGGER = 'Every N min';
const SAVE_RESULT_SQL = 'select id, status from finish_publish($1, $2, $3, $4, $5)';
const SAVE_RESULT_PARAMS = "={{ [$json.id, $json.status, $json.ig_media_id || '', $json.permalink || '', $json.error || ''] }}";

// ---------------------------------------------------------------------------
// BP 1 - Publisher: every 15 min. claim_due_posts() atomically locks approved,
// due posts (nothing unapproved can be returned); request_approvals() marks
// unapproved posts inside the lead window and gives each a one-time ref.
// ---------------------------------------------------------------------------
const publisher = workflow({
  name: 'BP 1 - Publisher',
  id: 'EMES0elQDjPxhY6Z',
  timezone: TZ,
  nodes: [
    schedule(PUBLISH_TRIGGER, [0, 1], { field: 'minutes', minutesInterval: 15 }),
    pg('Load Config', [1, 1], LOAD_CONFIG),

    pg('Claim Due Posts', [2, 0], 'select * from claim_due_posts($1)', { params: "={{ ['claim:' + $execution.id] }}" }),
    code('Prepare Publish', [3, 0], 'prepare-publish.js'),
    code('Publish to Instagram', [4, 0], 'publish-instagram.js', { perItem: true, vars: { ITEM: '$json' } }),
    pg('Save Result', [5, 0], SAVE_RESULT_SQL, { params: SAVE_RESULT_PARAMS, perItem: true }),
    tgMessage(
      'Notify Result',
      [6, 0],
      "={{ $('Publish to Instagram').item.json.telegram_chat_id }}",
      "={{ $('Publish to Instagram').item.json.status === 'published' ? '🎉 פורסם: ' + $('Publish to Instagram').item.json.id + ($('Publish to Instagram').item.json.permalink ? '\\n' + $('Publish to Instagram').item.json.permalink : '') : '🚨 פרסום נכשל: ' + $('Publish to Instagram').item.json.id + '\\n' + $('Publish to Instagram').item.json.error }}",
    ),

    pg('Request Approvals', [2, 2], 'select * from request_approvals()'),
    code('Prepare Ask', [3, 2], 'prepare-ask.js'),
    tgPhoto(
      'Send Preview',
      [4, 2],
      "={{ $('Prepare Ask').item.json.telegram_chat_id }}",
      "={{ $('Prepare Ask').item.json.preview_url }}",
      "={{ $('Prepare Ask').item.json.id }}{{ $('Prepare Ask').item.json.media_count > 1 ? ' · ' + $('Prepare Ask').item.json.media_count + ' פריטים' : '' }}",
      { onError: 'continueRegularOutput' },
    ),
    tgMessage(
      'Ask Approval',
      [5, 2],
      "={{ $('Prepare Ask').item.json.telegram_chat_id }}",
      "={{ ($('Prepare Ask').item.json.overdue ? '⏰ המועד עבר - יעלה מיד כשתאשר' : '🕑 מחכה לאישור שלך') + '\\n' + $('Prepare Ask').item.json.type + ' · ' + $('Prepare Ask').item.json.publish_at + ' · ' + $('Prepare Ask').item.json.id + '\\n\\n' + $('Prepare Ask').item.json.caption }}",
      { buttons: approveButtons("$('Prepare Ask').item.json") },
    ),
  ],
  links: [
    [PUBLISH_TRIGGER, 'Load Config'],
    ['Load Config', 'Claim Due Posts'],
    ['Load Config', 'Request Approvals'],
    ['Claim Due Posts', 'Prepare Publish'],
    ['Prepare Publish', 'Publish to Instagram'],
    ['Publish to Instagram', 'Save Result'],
    ['Save Result', 'Notify Result'],
    ['Request Approvals', 'Prepare Ask'],
    ['Prepare Ask', 'Send Preview'],
    ['Send Preview', 'Ask Approval'],
  ],
});

// ---------------------------------------------------------------------------
// BP 2 - Telegram Hub: approve/reject buttons, and photo/video → AI draft.
// ---------------------------------------------------------------------------
const decided = "$('Decision').first().json";
const published = "$('Publish to Instagram').first().json";


/** Authenticated JSON POST to the app; the base URL and token come from settings. */
const appPost = (name, pos, path, jsonBody, { timeout, onError } = {}) =>
  http(
    name,
    pos,
    {
      method: 'POST',
      url: `={{ $('Route Update').first().json.app_url }}${path}`,
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Authorization', value: "=Bearer {{ $('Route Update').first().json.app_api_token }}" }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody,
      options: { timeout },
    },
    onError ? { onError } : {},
  );

const telegramHub = workflow({
  name: 'BP 2 - Telegram Hub',
  id: 'RbzKFcz4zIHRiJJl',
  timezone: TZ,
  nodes: [
    tgTrigger('Telegram Trigger', [0, 2], '63215956-13f4-4c3f-90a4-d747840135b1'),
    pg('Load Config', [1, 2], LOAD_CONFIG),
    code('Route Update', [2, 2], 'telegram-route.js'),
    ifEquals('Is Button?', [3, 2], '={{ $json.kind }}', 'callback'),

    // ----- approve / reject buttons (decide_approval is atomic and stale-safe) -----
    pg('Decide', [4, 0], 'select decide_approval($1, $2, $3) as result', { params: '={{ [$json.id, $json.ref, $json.action] }}' }),
    code('Decision', [5, 0], 'callback-decision.js'),
    tgAnswer('Answer Button', [6, 0], `={{ ${decided}.query_id }}`, `={{ ${decided}.answer }}`),
    ifEquals('Publish Now?', [7, 0], `={{ ${decided}.decision }}`, 'publish_now'),
    code('Publish to Instagram', [8, 0], 'publish-instagram.js', { perItem: true, vars: { ITEM: decided } }),
    pg('Save Result', [9, 0], SAVE_RESULT_SQL, { params: SAVE_RESULT_PARAMS, perItem: true }),
    tgEdit(
      'Edit (Published)',
      [10, 0],
      `={{ ${decided}.chat_id }}`,
      `={{ ${decided}.message_id }}`,
      `={{ ${published}.status === 'published' ? '🎉 ' + ${published}.id + ' פורסם' + (${published}.permalink ? '\\n' + ${published}.permalink : '') : '🚨 ' + ${published}.id + ' נכשל: ' + ${published}.error }}`,
    ),
    tgEdit('Edit (Done)', [8, 1], `={{ ${decided}.chat_id }}`, `={{ ${decided}.message_id }}`, `={{ ${decided}.edit_text }}`),

    // ----- everything else is a conversation run by the app (/api/bot) -----
    ifEquals('Is Media?', [4, 3], '={{ $json.kind }}', 'media'),
    tgFile('Get File', [5, 3], '={{ $json.file_id }}'),
    http('Upload to Cloudinary', [6, 3], {
      method: 'POST',
      url: "=https://api.cloudinary.com/v1_1/{{ $('Route Update').first().json.cloudinary_cloud }}/auto/upload",
      sendBody: true,
      contentType: 'multipart-form-data',
      bodyParameters: {
        parameters: [
          { parameterType: 'formBinaryData', name: 'file', inputDataFieldName: 'data' },
          { name: 'upload_preset', value: "={{ $('Route Update').first().json.cloudinary_preset }}" },
        ],
      },
      options: {},
    }),
    code('Media Event', [7, 3], 'bot-media-event.js'),
    appPost('Ask Bot', [8, 4], '/api/bot', '={{ JSON.stringify($json.event) }}', { timeout: 30000 }),
    ifEquals('Needs Caption?', [9, 4], '={{ String(!!$json.generate) }}', 'true'),
    appPost('Write Caption (AI)', [10, 4], '/api/captions', '={{ JSON.stringify($json.generate.request) }}', { timeout: 90000, onError: 'continueRegularOutput' }),
    code('Variants Event', [11, 4], 'bot-variants-event.js'),
    appPost('Deliver Variants', [12, 4], '/api/bot', '={{ JSON.stringify($json.event) }}', { timeout: 30000 }),
  ],
  links: [
    ['Telegram Trigger', 'Load Config'],
    ['Load Config', 'Route Update'],
    ['Route Update', 'Is Button?'],
    ['Is Button?', 'Decide', 0],
    ['Is Button?', 'Is Media?', 1],
    ['Decide', 'Decision'],
    ['Decision', 'Answer Button'],
    ['Answer Button', 'Publish Now?'],
    ['Publish Now?', 'Publish to Instagram', 0],
    ['Publish Now?', 'Edit (Done)', 1],
    ['Publish to Instagram', 'Save Result'],
    ['Save Result', 'Edit (Published)'],
    ['Is Media?', 'Get File', 0],
    ['Is Media?', 'Ask Bot', 1],
    ['Get File', 'Upload to Cloudinary'],
    ['Upload to Cloudinary', 'Media Event'],
    ['Media Event', 'Ask Bot'],
    ['Ask Bot', 'Needs Caption?'],
    ['Needs Caption?', 'Write Caption (AI)', 0],
    ['Write Caption (AI)', 'Variants Event'],
    ['Variants Event', 'Deliver Variants'],
  ],
});

// ---------------------------------------------------------------------------
// BP 3 - Watchdog: nightly health check + tomorrow's approval digest.
// ---------------------------------------------------------------------------
const watchdog = workflow({
  name: 'BP 3 - Watchdog',
  id: 'sE2eyZ6EJD3PjYwY',
  timezone: TZ,
  nodes: [
    schedule('Daily 20:30', [0, 0], { field: 'cronExpression', expression: '30 20 * * *' }),
    pg('Load Config', [1, 0], LOAD_CONFIG),
    pg('Read Calendar', [2, 0], "select * from posts where status in ('ready', 'pending_approval', 'publishing', 'failed')"),
    code('Check', [3, 0], 'watchdog.js'),
    tgMessage('Alert', [4, 0], '={{ $json.telegram_chat_id }}', '={{ $json.text }}'),
  ],
  links: [
    ['Daily 20:30', 'Load Config'],
    ['Load Config', 'Read Calendar'],
    ['Read Calendar', 'Check'],
    ['Check', 'Alert'],
  ],
});

// ---------------------------------------------------------------------------
// BP 4 - Token Refresh: extends the Meta long-lived token and SAVES it.
// ---------------------------------------------------------------------------
const tokenRefresh = workflow({
  name: 'BP 4 - Token Refresh',
  id: 'tjCHfryj2pTghgZl',
  timezone: TZ,
  nodes: [
    schedule('Twice a Month', [0, 0], { field: 'cronExpression', expression: '0 3 1,15 * *' }),
    pg('Load Config', [1, 0], LOAD_CONFIG),
    code('Prep', [2, 0], 'config-json.js'),
    http('Exchange Token', [3, 0], {
      url: 'https://graph.facebook.com/v26.0/oauth/access_token',
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'grant_type', value: 'fb_exchange_token' },
          { name: 'client_id', value: '={{ $json.meta_app_id }}' },
          { name: 'client_secret', value: '={{ $json.meta_app_secret }}' },
          { name: 'fb_exchange_token', value: '={{ $json.access_token }}' },
        ],
      },
      options: {},
    }),
    code('Token Rows', [4, 0], 'token-rows.js'),
    pg('Save Token', [5, 0], 'insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', {
      params: '={{ [$json.key, $json.value] }}',
      perItem: true,
    }),
    tgMessage(
      'Notify',
      [6, 0],
      "={{ $('Prep').first().json.telegram_chat_id }}",
      "=🔑 הטוקן של Meta חודש ונשמר ({{ $('Token Rows').first().json.days }} יום)",
      { extra: { executeOnce: true } },
    ),
  ],
  links: [
    ['Twice a Month', 'Load Config'],
    ['Load Config', 'Prep'],
    ['Prep', 'Exchange Token'],
    ['Exchange Token', 'Token Rows'],
    ['Token Rows', 'Save Token'],
    ['Save Token', 'Notify'],
  ],
});

// ---------------------------------------------------------------------------
// BP 5 - Error Alert: any workflow failure → Telegram (set as error workflow).
// ---------------------------------------------------------------------------
const errorAlert = workflow({
  name: 'BP 5 - Error Alert',
  id: 'cPELz1Hlnup9oEir',
  nodes: [
    errorTrigger('Error Trigger', [0, 0]),
    tgMessage(
      'Alert',
      [1, 0],
      OWNER_CHAT,
      "=🚨 workflow נפל: {{ $json.workflow.name }}\n{{ $json.execution?.lastNodeExecuted ? 'בשלב: ' + $json.execution.lastNodeExecuted + '\\n' : '' }}{{ $json.execution?.error?.message || 'unknown error' }}{{ $json.execution?.url ? '\\n' + $json.execution.url : '' }}",
    ),
  ],
  links: [['Error Trigger', 'Alert']],
});

export const WORKFLOWS = {
  'bp1-publisher': publisher,
  'bp2-telegram-hub': telegramHub,
  'bp3-watchdog': watchdog,
  'bp4-token-refresh': tokenRefresh,
  'bp5-error-alert': errorAlert,
};
