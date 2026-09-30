import { UpstreamError } from '../errors.ts';

export type Button = { text: string; data: string };
export type Keyboard = Button[][];

/** The few Bot API calls the conversation needs. */
export interface Telegram {
  send(chatId: string, text: string, keyboard?: Keyboard): Promise<number>;
  sendPhoto(chatId: string, photoUrl: string, caption: string, keyboard?: Keyboard): Promise<number>;
  /** Replaces a message's text and keyboard (none = remove). Never throws. */
  edit(chatId: string, messageId: number, text: string, keyboard?: Keyboard): Promise<void>;
  /** Removes the buttons under a message. Never throws. */
  clearButtons(chatId: string, messageId: number): Promise<void>;
  /** Stops the button spinner, optionally with a toast. Never throws. */
  answer(queryId: string, text?: string): Promise<void>;
}

const markup = (keyboard?: Keyboard) =>
  keyboard?.length
    ? { inline_keyboard: keyboard.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) }
    : { inline_keyboard: [] };

export function createTelegram(token: string, fetchImpl: typeof fetch = fetch): Telegram {
  async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      });
    } catch (err) {
      throw new UpstreamError(`Telegram unreachable: ${(err as Error).message}`);
    }
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!body.ok) throw new UpstreamError(`Telegram ${method}: ${body.description ?? res.status}`);
    return body.result as T;
  }
  const quietly = (p: Promise<unknown>) => p.then(() => undefined).catch(() => undefined);

  return {
    async send(chatId, text, keyboard) {
      const msg = await call<{ message_id: number }>('sendMessage', {
        chat_id: chatId,
        text: text.slice(0, 4096),
        disable_web_page_preview: true,
        ...(keyboard ? { reply_markup: markup(keyboard) } : {}),
      });
      return msg.message_id;
    },
    async sendPhoto(chatId, photoUrl, caption, keyboard) {
      const msg = await call<{ message_id: number }>('sendPhoto', {
        chat_id: chatId,
        photo: photoUrl,
        caption: caption.slice(0, 1024),
        ...(keyboard ? { reply_markup: markup(keyboard) } : {}),
      });
      return msg.message_id;
    },
    edit: (chatId, messageId, text, keyboard) =>
      quietly(
        call('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: text.slice(0, 4096),
          disable_web_page_preview: true,
          reply_markup: markup(keyboard),
        }),
      ),
    clearButtons: (chatId, messageId) =>
      quietly(call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: markup() })),
    answer: (queryId, text) => quietly(call('answerCallbackQuery', { callback_query_id: queryId, ...(text ? { text } : {}) })),
  };
}
