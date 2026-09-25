-- Phase 2: AI translation cache + AI item-import job queue.
-- Run this once in the Supabase Dashboard -> SQL Editor, after 0001_init.sql.

-- ============================================================
-- Translation cache: one row per language, holding the full {ui, items, units,
-- categories} dict the client expects from getDictionary. Rebuilt wholesale by
-- translateAll (admin-triggered, calls Gemini), read as-is by getDictionary.
-- ============================================================
create table if not exists translation_cache (
  lang        text primary key,
  dict        jsonb not null,
  updated_at  timestamptz not null default now()
);

-- ============================================================
-- AI import jobs: async job queue for parseItemsAI / getAiImportResult.
-- The client posts a job (fire-and-forget) then polls by job_id until the
-- status flips from 'pending' to 'done' or 'error'.
-- ============================================================
create table if not exists ai_import_jobs (
  job_id      text primary key,
  status      text not null default 'pending' check (status in ('pending', 'done', 'error')),
  items       jsonb,
  error       text,
  created_at  timestamptz not null default now()
);

alter table translation_cache enable row level security;
alter table ai_import_jobs enable row level security;
-- No policies created = deny-all for anon/authenticated, same as every other table —
-- only the Edge Function's service-role key touches these.
