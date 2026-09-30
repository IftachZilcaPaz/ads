-- One Telegram conversation per chat: the post being prepared and the
-- question the bot is waiting on. `nonce` is embedded in inline buttons, so
-- buttons from an older conversation are recognised as stale.
create table if not exists bot_sessions (
  chat_id    text primary key,
  nonce      text not null,
  post_id    text not null,
  step       text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
