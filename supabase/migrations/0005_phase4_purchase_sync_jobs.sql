-- Phase 4 fix: previewPurchaseSync moved to an async job-queue pattern (same shape as
-- ai_import_jobs) because matching unmatched rows against Gemini one-by-one, plus the
-- Sheets reads/writes, routinely ran past the client's request timeout. The handler now
-- enqueues a job and returns immediately; the real work runs in the background and the
-- client polls getPurchaseSyncResult for the outcome.
-- Run this once in the Supabase Dashboard -> SQL Editor, after 0001-0004.

create table if not exists purchase_sync_jobs (
  job_id      text primary key,
  status      text not null default 'pending' check (status in ('pending', 'done', 'error')),
  result      jsonb,
  error       text,
  created_at  timestamptz not null default now()
);

alter table purchase_sync_jobs enable row level security;
-- No policies created = deny-all for anon/authenticated, same as every other table —
-- only the Edge Function's service-role key touches this.
