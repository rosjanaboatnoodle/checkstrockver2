-- Lets an admin hide one specific item (not a whole category) from one branch's staff view,
-- keyed by "category||name" — the companion to hidden_categories (0006), but item-granularity.
-- This is what replaces per-branch duplicate item rows going forward: a new item meant for
-- several-but-not-all branches is now created once as a central row, then hidden from the
-- branches that shouldn't see it, instead of creating a separate disconnected copy per branch
-- (which used to mean uploading the same photo/SKU again for every branch, with no link back
-- to the central item).
-- Run this once in the Supabase Dashboard -> SQL Editor, after 0001-0007.

alter table branches add column if not exists hidden_items jsonb not null default '[]'::jsonb;
