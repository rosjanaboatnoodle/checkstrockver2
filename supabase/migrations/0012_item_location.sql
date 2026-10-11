-- Optional "where is this stored" field per item (e.g. "ชั้น A1", "ตู้เย็น 2") — nullable, blank by
-- default, shown only when an admin bothers to fill it in. No required-field validation anywhere;
-- leaving it empty is the normal case.
alter table items add column if not exists location text;
