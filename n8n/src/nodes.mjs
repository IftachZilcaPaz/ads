// Small builders for n8n node JSON so workflows stay readable and consistent.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CODE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'code');

export const PG_CREDENTIAL = '__PG_CREDENTIAL_ID__';
export const OWNER_CHAT = '__TELEGRAM_CHAT_ID__';
export const ERROR_WORKFLOW_ID = 'cPELz1Hlnup9oEir';

// Credential *references* (names/ids inside your n8n), not secrets.
const POSTGRES = { postgres: { id: PG_CREDENTIAL, name: 'BP Postgres' } };
const TELEGRAM = { telegramApi: { id: 'gQQT4wEAXLPFc22J', name: 'ReynovationSocial' } };

/** Deterministic UUID so rebuilding produces identical JSON (clean diffs). */
export function stableId(...parts) {
  const h = createHash('sha1').update(parts.join('|')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Inlines `// @include file.js` and substitutes `@@VAR@@` placeholders. */
export function loadCode(file, vars = {}) {
  let src = readFileSync(join(CODE_DIR, file), 'utf8');
  src = src.replace(/^\/\/ @include (\S+)\n/gm, (_, inc) => readFileSync(join(CODE_DIR, inc), 'utf8'));
  for (const [k, v] of Object.entries(vars)) src = src.replaceAll(`@@${k}@@`, v);
  const leftover = /@@[A-Z_]+@@/.exec(src);
  if (leftover) throw new Error(`${file}: unresolved ${leftover[0]}`);
  return src;
}

const at = ([col, row]) => [col * 224, row * 176];

function node(name, type, typeVersion, pos, parameters, extra = {}) {
  return { parameters, name, type, typeVersion, position: at(pos), ...extra };
}

export const schedule = (name, pos, rule) =>
  node(name, 'n8n-nodes-base.scheduleTrigger', 1.2, pos, { rule: { interval: [rule] } });

export const code = (name, pos, file, { perItem = false, vars } = {}) =>
  node(name, 'n8n-nodes-base.code', 2, pos, {
    ...(perItem ? { mode: 'runOnceForEachItem' } : {}),
    jsCode: loadCode(file, vars),
  });

/**
 * Runs SQL against the app database. `params` is an n8n expression that
 * evaluates to an array (safe for values containing commas or quotes).
 * `perItem` runs once per input item; otherwise the node runs once.
 */
export const pg = (name, pos, query, { params, perItem = false } = {}) =>
  node(
    name,
    'n8n-nodes-base.postgres',
    2.5,
    pos,
    {
      operation: 'executeQuery',
      query,
      options: {
        ...(params ? { queryReplacement: params } : {}),
        ...(perItem ? { queryBatching: 'independently' } : {}),
      },
    },
    { credentials: POSTGRES, ...(perItem ? {} : { executeOnce: true }) },
  );

/** String equality IF node; output 0 = true, 1 = false. */
export const ifEquals = (name, pos, left, right) =>
  node(name, 'n8n-nodes-base.if', 2.2, pos, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 1 },
      conditions: [
        { id: stableId(name, 'cond'), leftValue: left, rightValue: right, operator: { type: 'string', operation: 'equals' } },
      ],
      combinator: 'and',
    },
    options: {},
  });

const tg = (name, pos, parameters, extra = {}) =>
  node(name, 'n8n-nodes-base.telegram', 1.2, pos, parameters, {
    webhookId: stableId(name, 'webhook'),
    credentials: TELEGRAM,
    ...extra,
  });

const quiet = { appendAttribution: false, disable_web_page_preview: true };

export const tgMessage = (name, pos, chatId, text, { buttons, extra } = {}) =>
  tg(
    name,
    pos,
    {
      chatId,
      text,
      ...(buttons
        ? {
            replyMarkup: 'inlineKeyboard',
            inlineKeyboard: {
              rows: [{ row: { buttons: buttons.map(([t, data]) => ({ text: t, additionalFields: { callback_data: data } })) } }],
            },
          }
        : {}),
      additionalFields: quiet,
    },
    extra,
  );

export const tgPhoto = (name, pos, chatId, file, caption, extra = {}) =>
  tg(name, pos, { operation: 'sendPhoto', chatId, file, additionalFields: { caption, appendAttribution: false } }, extra);

export const tgAnswer = (name, pos, queryId, text) =>
  tg(name, pos, { resource: 'callback', operation: 'answerQuery', queryId, additionalFields: { text } }, { onError: 'continueRegularOutput' });

export const tgEdit = (name, pos, chatId, messageId, text) =>
  tg(
    name,
    pos,
    { operation: 'editMessageText', chatId, messageId, text, additionalFields: { disable_web_page_preview: true } },
    { onError: 'continueRegularOutput' },
  );

export const tgFile = (name, pos, fileId) => tg(name, pos, { resource: 'file', fileId, additionalFields: {} });

export const tgTrigger = (name, pos, webhookId) =>
  node(name, 'n8n-nodes-base.telegramTrigger', 1.2, pos, { updates: ['message', 'callback_query'], additionalFields: {} }, {
    webhookId,
    credentials: TELEGRAM,
  });

export const http = (name, pos, parameters, extra = {}) => node(name, 'n8n-nodes-base.httpRequest', 4.2, pos, parameters, extra);

export const errorTrigger = (name, pos) => node(name, 'n8n-nodes-base.errorTrigger', 1, pos, {});

/** Builds a workflow; `links` are [from, to, outputIndex?]. */
export function workflow({ name, id, nodes, links, timezone }) {
  const byName = new Set(nodes.map((n) => n.name));
  const connections = {};
  for (const [from, to, output = 0] of links) {
    if (!byName.has(from) || !byName.has(to)) throw new Error(`${name}: bad link ${from} -> ${to}`);
    const outputs = (connections[from] ??= { main: [] }).main;
    while (outputs.length <= output) outputs.push([]);
    outputs[output].push({ node: to, type: 'main', index: 0 });
  }
  return {
    name,
    nodes: nodes.map((n) => ({ ...n, id: stableId(name, n.name) })),
    pinData: {},
    connections,
    active: false,
    settings: {
      executionOrder: 'v1',
      ...(timezone ? { timezone } : {}),
      ...(id === ERROR_WORKFLOW_ID ? {} : { errorWorkflow: ERROR_WORKFLOW_ID }),
    },
    id,
    tags: [{ id: '6qksHX28xg9UwYfk', name: 'Social' }],
  };
}
