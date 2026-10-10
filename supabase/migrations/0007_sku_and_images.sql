-- Adds barcode/SKU lookup and a photo per item.
-- Run this once in the Supabase Dashboard -> SQL Editor, after 0001-0006.

alter table items add column if not exists sku text;
alter table items add column if not exists image_url text;

-- Public bucket for item photos — uploads only ever happen server-side through the Edge
-- Function (service-role key, bypasses storage RLS entirely), so no storage policies are
-- needed here; `public: true` is what makes the uploaded files readable via a plain URL.
insert into storage.buckets (id, name, public)
values ('item-images', 'item-images', true)
on conflict (id) do nothing;
