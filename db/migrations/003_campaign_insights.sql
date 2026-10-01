-- Link to a campaign in Meta Ads Manager (numeric id), the saved AI ads plan,
-- and a small cache so insights pages do not hit the Graph API on every view.
alter table campaigns add column if not exists meta_campaign_id text not null default ''
  check (meta_campaign_id ~ '^[0-9]{0,30}$');

create table if not exists campaign_plans (
  campaign_id text primary key,
  summary     text not null default '',
  ads         jsonb,
  updated_at  timestamptz not null default now()
);

create table if not exists insights_cache (
  key        text primary key,
  data       jsonb not null,
  fetched_at timestamptz not null default now()
);
