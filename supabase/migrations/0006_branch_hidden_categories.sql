-- Lets an admin hide specific categories (central or branch-own) from one branch's staff view,
-- without needing separate per-branch copies of items just to control visibility.
-- Run this once in the Supabase Dashboard -> SQL Editor, after 0001-0005.

alter table branches add column if not exists hidden_categories jsonb not null default '[]'::jsonb;
