-- BP Social schema. Times are Israel wall-clock text "YYYY-MM-DD HH:mm":
-- the same sortable format the app and n8n use, immune to server timezones.

create or replace function il_now(offset_minutes int default 0) returns text
language sql stable as $$
  select to_char((now() at time zone 'Asia/Jerusalem') + make_interval(mins => offset_minutes), 'YYYY-MM-DD HH24:MI')
$$;

create table if not exists posts (
  id            text primary key check (id ~ '^\S{1,64}$'),
  publish_at    text not null default '' check (publish_at = '' or publish_at ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$'),
  type          text not null default 'POST' check (type in ('POST', 'CAROUSEL', 'REEL', 'STORY')),
  media_urls    text not null default '',
  caption       text not null default '',
  approval_mode text not null default 'approve' check (approval_mode in ('approve', 'auto')),
  status        text not null default 'draft'
                check (status in ('draft', 'ready', 'pending_approval', 'publishing', 'published', 'failed', 'rejected', 'archived')),
  ig_media_id   text not null default '',
  error         text not null default '',
  campaign_id   text not null default '',
  product_id    text not null default '',
  approved_at   text not null default '',
  approval_ref  text not null default '',
  notes         text not null default '',
  permalink     text not null default '',
  created_at    text not null default '',
  updated_at    text not null default ''
);
create index if not exists posts_status_publish_at_idx on posts (status, publish_at);

create table if not exists campaigns (
  id          text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  name        text not null check (name <> ''),
  status      text not null default 'active' check (status in ('active', 'paused', 'ended')),
  start_date  text not null default '',
  end_date    text not null default '',
  goal        text not null default '',
  audience    text not null default '',
  key_message text not null default '',
  offer       text not null default '',
  cta         text not null default '',
  hashtags    text not null default '',
  link        text not null default '',
  tone        text not null default '',
  notes       text not null default ''
);

create table if not exists products (
  id          text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  name        text not null check (name <> ''),
  status      text not null default 'active' check (status in ('active', 'archived')),
  category    text not null default '',
  description text not null default '',
  benefits    text not null default '',
  price       text not null default '',
  url         text not null default '',
  hashtags    text not null default '',
  notes       text not null default ''
);

-- Brand voice (key/value), edited from the app.
create table if not exists brand (
  key   text primary key,
  value text not null default ''
);

-- Replaces the sheet's `config` tab: Meta token, Telegram chat, Cloudinary...
-- The app reads only an explicit allow-list of keys from here.
create table if not exists settings (
  key   text primary key,
  value text not null default ''
);

-- ---------------------------------------------------------------------------
-- n8n entry points. Each is a single atomic statement, so a post can never be
-- published without approval, twice, or while it is being edited.
-- ---------------------------------------------------------------------------

-- Approved posts that are due → 'publishing' (the lock), returned for posting.
create or replace function claim_due_posts(claim text) returns setof posts
language sql as $$
  update posts p
     set status = 'publishing', approval_ref = claim, error = '', updated_at = il_now()
   where p.id in (
     select id from posts
      where status = 'ready' and publish_at <> '' and publish_at <= il_now()
        and (approval_mode = 'auto' or approved_at <> '')
      order by publish_at
      for update skip locked)
  returning p.*
$$;

-- Unapproved posts inside the lead window → 'pending_approval' with a fresh
-- one-time ref that the Telegram buttons must echo back.
create or replace function request_approvals() returns setof posts
language sql as $$
  update posts p
     set status = 'pending_approval', approval_ref = substr(md5(random()::text || p.id), 1, 6),
         error = '', updated_at = il_now()
   where p.id in (
     select id from posts
      where status = 'ready' and publish_at <> '' and approval_mode <> 'auto' and approved_at = ''
        and publish_at <= il_now(60 * coalesce(
              (select case when value ~ '^\d{1,3}$' then value::int end from settings where key = 'approval_lead_hours'), 12))
      for update skip locked)
  returning p.*
$$;

-- A Telegram button press. Stale refs (edited/handled/double tap) do nothing.
-- decision: publish_now | approve_later | reject | stale
create or replace function decide_approval(p_id text, p_ref text, p_action text) returns jsonb
language plpgsql as $$
declare
  r posts;
  due boolean;
begin
  select * into r from posts where id = p_id for update;
  if not found then
    return jsonb_build_object('decision', 'stale', 'reason', 'missing', 'id', p_id);
  end if;
  if r.status <> 'pending_approval' or r.approval_ref <> coalesce(p_ref, '') then
    return to_jsonb(r) || jsonb_build_object('decision', 'stale', 'reason', 'outdated');
  end if;

  if p_action = 'reject' then
    update posts set status = 'rejected', approval_ref = '', updated_at = il_now()
     where id = p_id returning * into r;
    return to_jsonb(r) || jsonb_build_object('decision', 'reject');
  elsif p_action = 'approve' then
    due := r.publish_at <= il_now();
    update posts
       set approved_at = il_now(), updated_at = il_now(), error = '',
           status = case when due then 'publishing' else 'ready' end,
           approval_ref = case when due then 'claim:telegram' else '' end
     where id = p_id returning * into r;
    return to_jsonb(r) || jsonb_build_object('decision', case when due then 'publish_now' else 'approve_later' end);
  end if;
  return to_jsonb(r) || jsonb_build_object('decision', 'stale', 'reason', 'unknown action');
end
$$;

-- Records the Instagram result for a post this workflow claimed.
create or replace function finish_publish(p_id text, p_status text, p_media_id text, p_permalink text, p_error text)
returns setof posts language sql as $$
  update posts
     set status = p_status, ig_media_id = coalesce(p_media_id, ''), permalink = coalesce(p_permalink, ''),
         error = left(coalesce(p_error, ''), 1000), approval_ref = '', updated_at = il_now()
   where id = p_id and status = 'publishing'
  returning *
$$;

-- Telegram photo → draft. Takes JSON as text so every driver passes it the same way.
create or replace function insert_draft(draft_json text) returns setof posts
language sql as $$
  with d as (select draft_json::jsonb as j)
  insert into posts (id, type, media_urls, caption, approval_mode, status, campaign_id, product_id, notes, created_at, updated_at)
  select j->>'id', coalesce(nullif(j->>'type', ''), 'POST'), coalesce(j->>'media_urls', ''), coalesce(j->>'caption', ''),
         'approve', 'draft', coalesce(j->>'campaign_id', ''), coalesce(j->>'product_id', ''), coalesce(j->>'notes', ''),
         il_now(), il_now()
    from d
  returning *
$$;
