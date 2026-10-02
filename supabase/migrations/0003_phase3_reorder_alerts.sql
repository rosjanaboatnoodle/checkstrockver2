-- Phase 3: reorder-alert round tracking.
-- Run this once in the Supabase Dashboard -> SQL Editor, after 0001 and 0002.

-- ============================================================
-- One row per branch, tracking progress toward the next reorder-alert send:
-- which categories have been checked today (a "round" = every category checked
-- once), which items came up low/critical since the last alert was sent, how
-- many full rounds have completed since the last send (for the "after_n_rounds"
-- trigger), and whether this branch is waiting on the others before a
-- "combined" (all-branches-in-one-message) alert can go out.
-- ============================================================
create table if not exists reorder_round_state (
  branch_id           text primary key references branches(id) on delete cascade,
  tracking_date       date not null default current_date,
  categories_checked  text[] not null default '{}',
  pending_items       text[] not null default '{}',
  rounds_since_alert  integer not null default 0,
  ready_for_combined  boolean not null default false,
  updated_at          timestamptz not null default now()
);

alter table reorder_round_state enable row level security;
-- No policies created = deny-all for anon/authenticated, same as every other table —
-- only the Edge Function's service-role key touches this.
