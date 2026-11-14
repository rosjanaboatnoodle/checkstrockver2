-- Phase: AI-generated pronunciation audio cache for the stock-check page's 🔊 button.
-- Run this once in the Supabase Dashboard -> SQL Editor, after 0012_item_location.sql.

-- ============================================================
-- One row per unique Thai item name, holding a ready-to-play WAV file (already
-- base64-encoded) generated once by Gemini's text-to-speech model. getItemSpeech
-- reads this first and only calls Gemini (then writes the result here) on a
-- cache miss -- so the per-item Gemini TTS cost is paid once ever, not per tap.
-- ============================================================
create table if not exists tts_cache (
  name        text primary key,
  audio_b64   text not null,
  mime_type   text not null default 'audio/wav',
  updated_at  timestamptz not null default now()
);

alter table tts_cache enable row level security;
-- No policies created = deny-all for anon/authenticated, same as every other table —
-- only the Edge Function's service-role key touches this.
