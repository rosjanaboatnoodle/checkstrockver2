-- ปฏิทินตารางงาน (repo CalendarsCST): ย้ายจากแท็บ SCHEDULE / SCHEDULE_TEXT ใน Google Sheet
-- "ระบบคิดเงินเดือนพนักงาน" มาเก็บใน Supabase
-- Run this once in the Supabase Dashboard -> SQL Editor, after 0001-0012.
-- ข้อมูลเดิมในชีทดึงเข้ามาทีหลังด้วย action importScheduleFromSheet (ไม่ต้องกรอกเอง)

-- หนึ่งแถวต่อหนึ่งวัน
create table if not exists schedule_days (
  date            date primary key,
  is_holiday      boolean not null default false,
  is_big_clean    boolean not null default false,
  is_stock_check  boolean not null default false,
  toilet_duty     text,              -- Kla / Bank / Maylin / Hom (ตรงกับ type toilet_duty_<ชื่อ> ใน schedule_texts)
  updated_at      timestamptz not null default now()
);

-- ข้อความแจ้งเตือนแต่ละประเภท (เหมือนแท็บ SCHEDULE_TEXT)
-- type: holiday / big_clean / stock_check / toilet_duty_Kla / toilet_duty_Bank / ...
create table if not exists schedule_texts (
  type        text primary key,
  text_th     text not null default '',
  text_mm     text not null default '',
  text_lo     text not null default '',
  updated_at  timestamptz not null default now()
);

alter table schedule_days enable row level security;
alter table schedule_texts enable row level security;
-- No policies = deny-all for anon/authenticated, same as every other table —
-- only the Edge Function's service-role key touches these.
