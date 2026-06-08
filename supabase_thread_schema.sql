-- Minimal paid-thread support for What's it Doing?
-- Run this in the Supabase SQL editor before testing the paid flow.
-- It is written to be safe against existing columns/tables.

create extension if not exists pgcrypto;

create table if not exists consults (
  id uuid primary key default gen_random_uuid(),
  public_id text,
  customer_name text,
  customer_email text,
  customer_phone text,
  phone_ok boolean default false,
  vehicle_summary text,
  issue_summary text,
  work_done_summary text,
  diy_status text,
  ability_level text,
  intake_text text,
  followup_text text,
  queue_type text default 'guided',
  status text default 'unpaid',
  payment_status text default 'unpaid',
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  paid_at timestamptz,
  closed_at timestamptz,
  file_links jsonb default '[]'::jsonb,
  voice_note_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists consults add column if not exists public_id text;
alter table if exists consults add column if not exists customer_email text;
alter table if exists consults add column if not exists customer_phone text;
alter table if exists consults add column if not exists phone_ok boolean default false;
alter table if exists consults add column if not exists queue_type text default 'guided';
alter table if exists consults add column if not exists payment_status text default 'unpaid';
alter table if exists consults add column if not exists stripe_checkout_session_id text;
alter table if exists consults add column if not exists stripe_payment_intent_id text;
alter table if exists consults add column if not exists paid_at timestamptz;
alter table if exists consults add column if not exists closed_at timestamptz;
alter table if exists consults add column if not exists diy_status text;
alter table if exists consults add column if not exists ability_level text;
alter table if exists consults add column if not exists file_links jsonb default '[]'::jsonb;
alter table if exists consults add column if not exists voice_note_url text;


-- v83 hardening: if a prior/partial consults table already existed, make sure every field used by the current Netlify functions exists.
alter table if exists consults add column if not exists customer_name text;
alter table if exists consults add column if not exists vehicle_summary text;
alter table if exists consults add column if not exists issue_summary text;
alter table if exists consults add column if not exists work_done_summary text;
alter table if exists consults add column if not exists intake_text text;
alter table if exists consults add column if not exists followup_text text;
alter table if exists consults add column if not exists status text default 'unpaid';
alter table if exists consults add column if not exists created_at timestamptz not null default now();
alter table if exists consults add column if not exists updated_at timestamptz not null default now();
alter table if exists consults add column if not exists last_workflow_status text;
alter table if exists consults add column if not exists last_message text;
alter table if exists consults add column if not exists last_message_at timestamptz;
alter table if exists consults add column if not exists upload_count integer default 0;
alter table if exists consults add column if not exists has_voice_note boolean default false;

create table if not exists consult_messages (
  id uuid primary key default gen_random_uuid(),
  consult_id uuid not null,
  who text not null check (who in ('customer','operator','system')),
  text text not null,
  created_at timestamptz not null default now()
);

create index if not exists consult_messages_consult_created_idx on consult_messages (consult_id, created_at);
create index if not exists consults_status_updated_idx on consults (status, updated_at desc);
create index if not exists consults_checkout_session_idx on consults (stripe_checkout_session_id);

-- v87 persistent thread attachments for operator/customer message images.
alter table if exists consult_messages add column if not exists image_data text;
alter table if exists consult_messages add column if not exists image_name text;
alter table if exists consult_messages add column if not exists attachment_type text;
alter table if exists consult_messages add column if not exists attachment_name text;
alter table if exists consult_messages add column if not exists attachment_url text;
