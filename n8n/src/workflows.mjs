// Source of truth for the n8n workflows. `npm run n8n:build` renders these to
// n8n/workflows/*.json (placeholders) and n8n/dist/*.json (your real IDs).
import {
  OWNER_CHAT,
  code,
  errorTrigger,
  http,
  ifEquals,
  schedule,
  sheetAppend,
  sheetRead,
  sheetUpdate,
  tgAnswer,
  tgEdit,
  tgFile,
  tgMessage,
  tgPhoto,
  tgTrigger,
  workflow,
} from './nodes.mjs';

const TZ = 'Asia/Jerusalem';
const NOW = "={{ $now.setZone('Asia/Jerusalem').toFormat('yyyy-MM-dd HH:mm') }}";
const approveButtons = (src) => [
  ['✅ אשר', `=approve:{{ ${src}.id }}:{{ ${src}.approval_ref }}`],
  ['❌ דחה', `=reject:{{ ${src}.id }}:{{ ${src}.approval_ref }}`],
];

// ---------------------------------------------------------------------------
// BP 1 - Publisher: every 15 min. Publishes approved posts that are due; for
// posts that still need approval, sends a Telegram request ahead of time.
// ---------------------------------------------------------------------------
const publisher = workflow({
  name: 'BP 1 - Publisher',
  id: 'EMES0elQDjPxhY6Z',
  timezone: TZ,
  nodes: [
    schedule('Every 15 min', [0, 1], { field: 'minutes', minutesInterval: 15 }),
    sheetRead('Load Config', [1, 1], 'config'),
    sheetRead('Read Calendar', [2, 1], 'calendar'),
    code('Plan', [3, 1], 'publisher-plan.js'),
    ifEquals('Publish Now?', [4, 1], '={{ $json.route }}', 'publish'),

    // Approved & due → claim (lock) → verify still approved → publish.
    sheetUpdate('Claim Posts', [5, 0], 'calendar', {
      id: '={{ $json.id }}',
      status: 'publishing',
      approval_ref: '=claim:{{ $execution.id }}',
    }),
    sheetRead('Re-read Calendar', [6, 0], 'calendar'),
    code('Verify Claim', [7, 0], 'claim-verify.js'),
    ifEquals('Still Approved?', [8, 0], '={{ String($json.claimed) }}', 'true'),
    code('Publish to Instagram', [9, 0], 'publish-instagram.js', { perItem: true }),
    sheetUpdate('Save Result', [10, 0], 'calendar', {
      id: '={{ $json.id }}',
      status: '={{ $json.status }}',
      ig_media_id: '={{ $json.ig_media_id || "" }}',
      permalink: '={{ $json.permalink || "" }}',
      error: '={{ $json.error }}',
      approval_ref: '',
      updated_at: '={{ $json.updated_at }}',
    }),
    tgMessage(
      'Notify Result',
      [11, 0],
      "={{ $('Publish to Instagram').item.json.telegram_chat_id }}",
      "={{ $('Publish to Instagram').item.json.status === 'published' ? '🎉 פורסם: ' + $('Publish to Instagram').item.json.id + ($('Publish to Instagram').item.json.permalink ? '\\n' + $('Publish to Instagram').item.json.permalink : '') : '🚨 פרסום נכשל: ' + $('Publish to Instagram').item.json.id + '\\n' + $('Publish to Instagram').item.json.error }}",
    ),
    sheetUpdate('Release', [9, 1], 'calendar', { id: '={{ $json.id }}', status: 'ready', approval_ref: '' }),

    // Not approved yet → mark pending → Telegram preview + approve/reject buttons.
    sheetUpdate('Mark Pending', [5, 2], 'calendar', {
      id: '={{ $json.id }}',
      status: 'pending_approval',
      approval_ref: '={{ $json.approval_ref }}',
      error: '',
    }),
    tgPhoto(
      'Send Preview',
      [6, 2],
      "={{ $('Plan').item.json.telegram_chat_id }}",
      "={{ $('Plan').item.json.preview_url }}",
      "={{ $('Plan').item.json.id }}{{ $('Plan').item.json.media_count > 1 ? ' · ' + $('Plan').item.json.media_count + ' פריטים' : '' }}",
      { onError: 'continueRegularOutput' },
    ),
    tgMessage(
      'Ask Approval',
      [7, 2],
      "={{ $('Plan').item.json.telegram_chat_id }}",
      "={{ ($('Plan').item.json.overdue ? '⏰ המועד עבר - יעלה מיד כשתאשר' : '🕑 מחכה לאישור שלך') + '\\n' + $('Plan').item.json.type + ' · ' + $('Plan').item.json.publish_at + ' · ' + $('Plan').item.json.id + '\\n\\n' + $('Plan').item.json.caption }}",
      { buttons: approveButtons("$('Plan').item.json") },
    ),
  ],
  links: [
    ['Every 15 min', 'Load Config'],
    ['Load Config', 'Read Calendar'],
    ['Read Calendar', 'Plan'],
    ['Plan', 'Publish Now?'],
    ['Publish Now?', 'Claim Posts', 0],
    ['Publish Now?', 'Mark Pending', 1],
    ['Claim Posts', 'Re-read Calendar'],
    ['Re-read Calendar', 'Verify Claim'],
    ['Verify Claim', 'Still Approved?'],
    ['Still Approved?', 'Publish to Instagram', 0],
    ['Still Approved?', 'Release', 1],
    ['Publish to Instagram', 'Save Result'],
    ['Save Result', 'Notify Result'],
    ['Mark Pending', 'Send Preview'],
    ['Send Preview', 'Ask Approval'],
  ],
});

// ---------------------------------------------------------------------------
// BP 2 - Telegram Hub: approve/reject buttons, and photo/video → AI draft.
// ---------------------------------------------------------------------------
const decided = "$('Decide').first().json";
const verified = "$('Verify Claim').first().json";
const published = "$('Publish to Instagram').first().json";
const draft = "$('Make Draft').first().json";

const telegramHub = workflow({
  name: 'BP 2 - Telegram Hub',
  id: 'RbzKFcz4zIHRiJJl',
  timezone: TZ,
  nodes: [
    tgTrigger('Telegram Trigger', [0, 2], '63215956-13f4-4c3f-90a4-d747840135b1'),
    sheetRead('Load Config', [1, 2], 'config'),
    code('Route Update', [2, 2], 'telegram-route.js'),
    ifEquals('Is Button?', [3, 2], '={{ $json.kind }}', 'callback'),

    // ----- approve / reject buttons -----
    sheetRead('Read Calendar', [4, 0], 'calendar'),
    code('Decide', [5, 0], 'callback-decide.js'),
    tgAnswer('Answer Button', [6, 0], `={{ ${decided}.query_id }}`, `={{ ${decided}.answer }}`),
    ifEquals('Stale?', [7, 0], `={{ ${decided}.decision }}`, 'stale'),
    tgEdit('Edit (Stale)', [8, 1], `={{ ${decided}.chat_id }}`, `={{ ${decided}.message_id }}`, `={{ ${decided}.edit_text }}`),
    sheetUpdate('Claim', [8, 0], 'calendar', {
      id: `={{ ${decided}.id }}`,
      status: `={{ ${decided}.decision === 'publish_now' ? 'publishing' : ${decided}.status }}`,
      approval_ref: '=claim:{{ $execution.id }}',
    }),
    sheetRead('Re-read Calendar', [9, 0], 'calendar'),
    code('Verify Claim', [10, 0], 'callback-verify.js'),
    ifEquals('Publish Now?', [11, 0], '={{ $json.decision }}', 'publish_now'),
    code('Publish to Instagram', [12, 0], 'publish-instagram.js', { perItem: true }),
    sheetUpdate('Save Result', [13, 0], 'calendar', {
      id: '={{ $json.id }}',
      status: '={{ $json.status }}',
      approved_at: '={{ $json.approved_at }}',
      ig_media_id: '={{ $json.ig_media_id || "" }}',
      permalink: '={{ $json.permalink || "" }}',
      error: '={{ $json.error }}',
      approval_ref: '',
      updated_at: '={{ $json.updated_at }}',
    }),
    tgEdit(
      'Edit (Published)',
      [14, 0],
      `={{ ${verified}.chat_id }}`,
      `={{ ${verified}.message_id }}`,
      `={{ ${published}.status === 'published' ? '🎉 ' + ${published}.id + ' פורסם' + (${published}.permalink ? '\\n' + ${published}.permalink : '') : '🚨 ' + ${published}.id + ' נכשל: ' + ${published}.error }}`,
    ),
    ifEquals('Approve Later?', [12, 1], '={{ $json.decision }}', 'approve_later'),
    sheetUpdate('Save Approval', [13, 1], 'calendar', {
      id: '={{ $json.id }}',
      status: 'ready',
      approved_at: '={{ $json.approved_at }}',
      approval_ref: '',
      error: '',
      updated_at: NOW,
    }),
    ifEquals('Reject?', [13, 2], '={{ $json.decision }}', 'reject'),
    sheetUpdate('Save Rejection', [14, 2], 'calendar', {
      id: '={{ $json.id }}',
      status: 'rejected',
      approval_ref: '',
      updated_at: NOW,
    }),
    tgEdit('Edit (Done)', [15, 1], `={{ ${verified}.chat_id }}`, `={{ ${verified}.message_id }}`, `={{ ${verified}.edit_text }}`),

    // ----- photo / video → Cloudinary → AI caption → draft -----
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
    sheetRead('Read Campaigns', [7, 3], 'campaigns'),
    sheetRead('Read Products', [8, 3], 'products'),
    sheetRead('Read Brand', [9, 3], 'brand'),
    code('Build Caption Request', [10, 3], 'intake-request.js'),
    ifEquals('Use AI?', [11, 3], '={{ String($json.use_ai) }}', 'true'),
    http(
      'Write Caption (AI)',
      [12, 3],
      {
        method: 'POST',
        url: '={{ $json.app_url }}/api/captions',
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'Authorization', value: '=Bearer {{ $json.app_api_token }}' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.request) }}',
        options: { timeout: 90000 },
      },
      { onError: 'continueRegularOutput' },
    ),
    code('Make Draft', [13, 4], 'intake-draft.js'),
    sheetAppend('Append Draft', [14, 4], 'calendar', {
      id: '={{ $json.id }}',
      type: '={{ $json.type }}',
      media_urls: '={{ $json.media_urls }}',
      caption: '={{ $json.caption }}',
      approval_mode: 'approve',
      status: 'draft',
      campaign_id: '={{ $json.campaign_id }}',
      product_id: '={{ $json.product_id }}',
      notes: '={{ $json.notes }}',
      created_at: '={{ $json.created_at }}',
      updated_at: '={{ $json.updated_at }}',
    }),
    tgMessage(
      'Confirm Draft',
      [15, 4],
      `={{ ${draft}.chat_id }}`,
      `={{ ('📝 נוצרה טיוטה ' + ${draft}.id + '\\n' + (${draft}.ai_used ? '✨ קפשן מה-AI:' : (${draft}.ai_error ? '⚠️ ה-AI לא זמין (' + ${draft}.ai_error + ') - שמרתי את הטקסט שלך:' : 'הקפשן:')) + '\\n\\n' + (${draft}.caption || '(ריק)') + (${draft}.alternatives ? '\\n\\nגרסאות נוספות:\\n' + ${draft}.alternatives : '') + (${draft}.app_url ? '\\n\\nלקביעת מועד ואישור: ' + ${draft}.app_url : '')).slice(0, 4000) }}`,
    ),
    tgMessage(
      'Usage Hint',
      [5, 5],
      '={{ $json.chat_id }}',
      "={{ 'שלח לי תמונה או וידאו ואכין טיוטה עם קפשן 📝\\n\\n• #מזהה-קמפיין או #מזהה-מוצר בטקסט - ישייך ויכתוב בהתאם\\n• שאר הטקסט = בריף ל-AI\\n• טקסט שמתחיל ב-! נשמר כקפשן כמו שהוא' + ($json.app_url ? '\\n\\nהלוח: ' + $json.app_url : '') }}",
    ),
  ],
  links: [
    ['Telegram Trigger', 'Load Config'],
    ['Load Config', 'Route Update'],
    ['Route Update', 'Is Button?'],
    ['Is Button?', 'Read Calendar', 0],
    ['Is Button?', 'Is Media?', 1],
    ['Read Calendar', 'Decide'],
    ['Decide', 'Answer Button'],
    ['Answer Button', 'Stale?'],
    ['Stale?', 'Edit (Stale)', 0],
    ['Stale?', 'Claim', 1],
    ['Claim', 'Re-read Calendar'],
    ['Re-read Calendar', 'Verify Claim'],
    ['Verify Claim', 'Publish Now?'],
    ['Publish Now?', 'Publish to Instagram', 0],
    ['Publish Now?', 'Approve Later?', 1],
    ['Publish to Instagram', 'Save Result'],
    ['Save Result', 'Edit (Published)'],
    ['Approve Later?', 'Save Approval', 0],
    ['Approve Later?', 'Reject?', 1],
    ['Save Approval', 'Edit (Done)'],
    ['Reject?', 'Save Rejection', 0],
    ['Reject?', 'Edit (Done)', 1],
    ['Save Rejection', 'Edit (Done)'],
    ['Is Media?', 'Get File', 0],
    ['Is Media?', 'Usage Hint', 1],
    ['Get File', 'Upload to Cloudinary'],
    ['Upload to Cloudinary', 'Read Campaigns'],
    ['Read Campaigns', 'Read Products'],
    ['Read Products', 'Read Brand'],
    ['Read Brand', 'Build Caption Request'],
    ['Build Caption Request', 'Use AI?'],
    ['Use AI?', 'Write Caption (AI)', 0],
    ['Use AI?', 'Make Draft', 1],
    ['Write Caption (AI)', 'Make Draft'],
    ['Make Draft', 'Append Draft'],
    ['Append Draft', 'Confirm Draft'],
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
    sheetRead('Load Config', [1, 0], 'config'),
    sheetRead('Read Calendar', [2, 0], 'calendar'),
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
    sheetRead('Load Config', [1, 0], 'config'),
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
    sheetUpdate('Save Token', [5, 0], 'config', { key: '={{ $json.key }}', value: '={{ $json.value }}' }, { match: 'key', upsert: true }),
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
