-- 0009 added last_verified_qty to flag "low" by comparing current running qty against
-- the qty recorded at the last check/adjust. That's wrong the moment a check just
-- landed: the check IS the last-verified point, so predicted == actual == the number
-- just entered, and the flag can never fire right when it matters most (immediately
-- after a check comes in critically short). The LINE alert avoids this because it
-- compares the fresh count against the system's state *before* that check landed
-- (computeLowStockFlags, called pre-insert in handleCreate) — a comparison that only
-- exists at the moment of the check, not reconstructable from a later snapshot.
--
-- Fix: persist that same check-time flag instead of trying to recompute it later.
-- check_record_items.is_low is now set by handleCreate using the exact same
-- computeLowStockFlags result already used for the LINE/reorder-alert logic, and
-- get_current_stock_levels surfaces the latest check's flag as last_check_was_low.
-- This is a snapshot as of the last check, same as the LINE alert itself — a stock
-- movement after that check won't update it until the next check runs.
alter table check_record_items add column if not exists is_low boolean;

drop function if exists get_current_stock_levels(text);

create function get_current_stock_levels(p_branch_id text)
returns table (
  item_name          text,
  category           text,
  unit               text,
  qty                numeric,
  has_baseline       boolean,
  last_check_was_low boolean
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
           cri.quantity_base as base_value,
           cri.is_low as base_is_low
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
         (bq.base_value is not null or f.item_name is not null) as has_baseline,
         -- manual 'adjust' movements correct the baseline outright (someone physically
         -- recounted), so they supersede whatever the last formal check flagged — same
         -- precedence the qty calculation above already gives last_adjust over base_value.
         (case when f.last_adjust is not null then false else coalesce(bq.base_is_low, false) end) as last_check_was_low
  from base_qty bq
  left join folded f on f.item_name = bq.item_name;
$$;
