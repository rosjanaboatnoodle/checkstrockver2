-- 0010's last_check_was_low is a frozen snapshot from the moment of the last check — it
-- doesn't account for stock movements (เบิกเข้า/เบิกออก) that happen afterward, so an item
-- that was fine at check time but gets heavily withdrawn afterward stays looking "fine" on
-- the overview page until the next check runs. The admin wants movements counted too.
--
-- Fix: store the frozen *prediction* itself (predicted_qty — the same "what we expected
-- right before this check" baseline computeLowStockFlags/computeCheckTimePredictions already
-- computes) instead of a frozen boolean, and compare it against the *current* running qty
-- (which already reflects movements since the check) using the *current* buffer-config
-- settings. So: predicted is frozen at the last check, actual stays live.
alter table check_record_items add column if not exists predicted_qty numeric;

drop function if exists get_current_stock_levels(text);

create function get_current_stock_levels(p_branch_id text)
returns table (
  item_name     text,
  category      text,
  unit          text,
  qty           numeric,
  has_baseline  boolean,
  predicted_qty numeric
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
           cri.predicted_qty as base_predicted_qty
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
         -- a manual 'adjust' movement is a fresh physical recount that supersedes whatever the
         -- last formal check predicted — same precedence the qty calculation above already
         -- gives last_adjust over base_value, so there's nothing meaningful left to compare
         -- the running qty against until the next check re-establishes a prediction.
         (case when f.last_adjust is not null then null else bq.base_predicted_qty end) as predicted_qty
  from base_qty bq
  left join folded f on f.item_name = bq.item_name;
$$;
