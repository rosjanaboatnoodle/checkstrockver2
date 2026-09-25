-- Phase 0: core schema for the stock-check app on Supabase.
-- Run this once in the Supabase Dashboard -> SQL Editor (paste the whole file, click Run).
-- Covers only what Phase 1 of the Edge Function needs: branches, items, check-in
-- records, stock movements, admin log, and a key/value settings table for buffer
-- and unit config. Translation cache, AI import jobs, and purchase-sync tables are
-- added in their own later-phase migrations, not here.

create extension if not exists pgcrypto;

-- ============================================================
-- Password hashing helpers (wrap pgcrypto so the Edge Function never has to know
-- the specific algorithm/salt format — it just calls crypt_hash/crypt_check).
-- SECURITY DEFINER so these can run even though RLS locks down direct table access;
-- they take/return plain values only, never touch a table themselves.
-- ============================================================
create or replace function crypt_hash(plain text)
returns text language sql as $$
  select crypt(plain, gen_salt('bf'));
$$;

create or replace function crypt_check(plain text, hash text)
returns boolean language sql as $$
  select crypt(plain, hash) = hash;
$$;

-- Atomically append one entry to a check_records row's edit_history jsonb array —
-- avoids a separate fetch-modify-write from the Edge Function.
create or replace function append_edit_history(p_record_id uuid, p_entry jsonb)
returns void language sql as $$
  update check_records
  set edit_history = edit_history || jsonb_build_array(p_entry),
      updated_at = now()
  where id = p_record_id;
$$;

-- ============================================================
-- Branches
-- ============================================================
create table if not exists branches (
  id              text primary key,              -- human-readable id (matches today's scheme)
  name            text not null,
  staff_password_hash text not null,
  created_at      timestamptz not null default now()
);

-- ============================================================
-- Items (central catalog = branch_id IS NULL; branch-specific overrides otherwise)
-- ============================================================
create table if not exists items (
  id          uuid primary key default gen_random_uuid(),
  branch_id   text references branches(id) on delete cascade,  -- NULL = central/shared
  category    text not null,
  is_header   boolean not null default false,
  name        text not null,
  unit        text,
  sort_order  integer not null default 0,
  active      boolean not null default true,       -- soft delete, matches current deleteItem behavior
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Mirrors the current merge key exactly: central + branch rows share identity by
-- (category, name); a branch row with the same category+name as a central row
-- overrides it. This partial-unique form only enforces uniqueness among ACTIVE rows,
-- so soft-deleted rows never block re-adding an item with the same name (this was
-- the exact bug hit this session with the old Sheets backend).
create unique index if not exists items_scope_key_active
  on items (coalesce(branch_id, ''), category, name)
  where active;

create index if not exists items_branch_active_idx on items (branch_id, active);

-- ============================================================
-- Check-in records (header + normalized line items)
-- ============================================================
create table if not exists check_records (
  id            uuid primary key default gen_random_uuid(),
  branch_id     text not null references branches(id),
  category      text not null,
  checker_name  text,
  date          timestamptz not null,
  line_text     text,                              -- exact LINE report text as sent, kept for history/debugging
  edit_history  jsonb not null default '[]',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz
);
create index if not exists check_records_branch_cat_date_idx
  on check_records (branch_id, category, date desc);

create table if not exists check_record_items (
  id             bigint generated always as identity primary key,
  record_id      uuid not null references check_records(id) on delete cascade,
  item_name      text not null,
  quantity       numeric not null,
  quantity_base  numeric,
  unit           text,
  note           text,
  waste_qty      numeric
);
create index if not exists check_record_items_name_idx on check_record_items (item_name, record_id);

-- ============================================================
-- Stock movements (รับเข้า / เบิกออก / ปรับยอด)
-- ============================================================
create table if not exists stock_movements (
  id            uuid primary key default gen_random_uuid(),
  branch_id     text not null references branches(id),
  checker_name  text,
  date          timestamptz not null,
  line_text     text,
  created_at    timestamptz not null default now()
);
create table if not exists stock_movement_lines (
  id            bigint generated always as identity primary key,
  movement_id   uuid not null references stock_movements(id) on delete cascade,
  item_name     text not null,
  direction     text not null check (direction in ('in', 'out', 'adjust')),
  quantity      numeric not null,
  unit          text
);
create index if not exists stock_movement_lines_name_idx on stock_movement_lines (item_name, movement_id);

-- ============================================================
-- Admin action audit log (mirrors the current AdminLog sheet)
-- ============================================================
create table if not exists admin_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  action     text not null,
  details    jsonb not null default '{}'
);

-- ============================================================
-- Key/value settings: admin password hash, buffer config, unit config
-- (replaces Apps Script PropertiesService JSON blobs)
-- ============================================================
create table if not exists app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- ============================================================
-- get_current_stock_levels: replaces the old slow JS scan (parsed every check +
-- movement record's JSON blob on every call) with one indexed query. For each item
-- in the branch's effective catalog: start from the latest check_record for that
-- item's category, then apply every movement line dated after that check.
-- ============================================================
create or replace function get_current_stock_levels(p_branch_id text)
returns table (
  item_name    text,
  category     text,
  unit         text,
  qty          numeric,
  has_baseline boolean
) language sql stable as $$
  with effective_items as (
    -- central items, overridden by same-name branch-specific rows
    select coalesce(b.name, c.name) as name,
           coalesce(b.category, c.category) as category,
           coalesce(b.unit, c.unit) as unit
    from items c
    left join items b
      on b.branch_id = p_branch_id and b.active and b.name = c.name and b.category = c.category
    where c.branch_id is null and c.active and coalesce(c.is_header, false) = false
    union
    select i.name, i.category, i.unit
    from items i
    where i.branch_id = p_branch_id and i.active and coalesce(i.is_header, false) = false
      and not exists (
        select 1 from items c2
        where c2.branch_id is null and c2.active and c2.name = i.name and c2.category = i.category
      )
  ),
  latest_check_per_category as (
    select distinct on (category) id, category, date
    from check_records
    where branch_id = p_branch_id
    order by category, date desc
  ),
  base_qty as (
    select ei.name as item_name, ei.category, ei.unit,
           lc.date as base_date,
           cri.quantity_base as base_value
    from effective_items ei
    left join latest_check_per_category lc on lc.category = ei.category
    left join check_record_items cri on cri.record_id = lc.id and cri.item_name = ei.name
  ),
  movements_after as (
    select bq.item_name, sml.direction, sml.quantity, sm.date
    from base_qty bq
    join stock_movement_lines sml on sml.item_name = bq.item_name
    join stock_movements sm on sm.id = sml.movement_id
    where sm.branch_id = p_branch_id
      and (bq.base_date is null or sm.date > bq.base_date)
  ),
  folded as (
    select item_name,
           -- last-write-wins for 'adjust', running sum for in/out, applied in date order
           (array_agg(
              case direction when 'adjust' then quantity else null end
              order by date desc
            ) filter (where direction = 'adjust'))[1] as last_adjust,
           max(date) filter (where direction = 'adjust') as last_adjust_date,
           sum(case when direction = 'in' then quantity
                    when direction = 'out' then -quantity
                    else 0 end) as net_in_out,
           sum(case when direction = 'in' then quantity
                    when direction = 'out' then -quantity
                    else 0 end) filter (
             where date > coalesce(
               (select max(date) from movements_after m2
                where m2.item_name = movements_after.item_name and m2.direction = 'adjust'),
               '-infinity'::timestamptz)
           ) as net_in_out_after_adjust
    from movements_after
    group by item_name
  )
  select bq.item_name,
         bq.category,
         bq.unit,
         coalesce(
           case when f.last_adjust is not null then f.last_adjust + coalesce(f.net_in_out_after_adjust, 0)
                else coalesce(bq.base_value, 0) + coalesce(f.net_in_out, 0) end,
           bq.base_value, 0
         ) as qty,
         (bq.base_value is not null or f.item_name is not null) as has_baseline
  from base_qty bq
  left join folded f on f.item_name = bq.item_name;
$$;

-- ============================================================
-- Row Level Security: deny-all for anon/authenticated. All access goes through the
-- Edge Function using the service-role key (same trust model as today, where only
-- Apps Script itself can touch the Sheet -- no per-user Supabase Auth accounts).
-- ============================================================
alter table branches enable row level security;
alter table items enable row level security;
alter table check_records enable row level security;
alter table check_record_items enable row level security;
alter table stock_movements enable row level security;
alter table stock_movement_lines enable row level security;
alter table admin_log enable row level security;
alter table app_settings enable row level security;
-- No policies created = deny-all by default for anon/authenticated roles.
-- The service-role key (used only by the Edge Function, never the browser) bypasses RLS entirely.
