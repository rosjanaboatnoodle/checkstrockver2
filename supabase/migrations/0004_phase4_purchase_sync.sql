-- Phase 4: purchase/expense sync from the external ledger Google Sheet.
-- Run this once in the Supabase Dashboard -> SQL Editor, after 0001, 0002, 0003.

-- ============================================================
-- Remembers which catalog item an admin matched a raw ledger-sheet item name to,
-- keyed by the normalized (trimmed, lowercased) raw name. Checked before falling
-- back to asking Gemini, so the same misspelled/abbreviated receipt text only ever
-- needs a human decision once.
-- ============================================================
create table if not exists purchase_match_memory (
  raw_name    text primary key,
  item_name   text not null,
  updated_at  timestamptz not null default now()
);

alter table purchase_match_memory enable row level security;
-- No policies created = deny-all for anon/authenticated, same as every other table —
-- only the Edge Function's service-role key touches this.
