// Phase 1 Edge Function: one consolidated dispatcher, mirroring the existing
// Code.gs doGet/doPost switch(action) pattern so future edits stay "find the case,
// edit it" — same mental model as today's Google Apps Script workflow.
//
// Deploy: Supabase Dashboard -> Edge Functions -> create function named "api" ->
// paste this file's contents -> Deploy. No CLI/Deno install needed on your end.
//
// Secrets needed (Dashboard -> Edge Functions -> Secrets), before first real use:
//   LINE_CHANNEL_ACCESS_TOKEN   (LINE Messaging API channel access token)
//   LINE_TARGET_ID              (the LINE user/group id reports get pushed to)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by the platform —
// you do not set those yourself.
//
// Every request is a POST with a JSON body: { action: "...", ...params }.
// Every response is JSON with at least an `ok` boolean, matching the shape the
// client already expects from each action (see index.html call sites).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// ============================================================
// Small helpers
// ============================================================

async function logAdmin(action: string, details: Record<string, unknown> = {}) {
  await supabase.from("admin_log").insert({ action, details });
}

async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const { data } = await supabase.from("app_settings").select("value").eq("key", key).maybeSingle();
  return (data?.value as T) ?? fallback;
}

async function setSetting(key: string, value: unknown) {
  await supabase.from("app_settings").upsert({ key, value, updated_at: new Date().toISOString() });
}

// Password check via Postgres pgcrypto (crypt()), so plaintext never sits in JS memory
// longer than necessary and the same hashing the DB stores is used to verify it.
async function checkPassword(hash: string | null, plain: string): Promise<boolean> {
  if (!hash) return false;
  const { data, error } = await supabase.rpc("crypt_check", { plain, hash });
  if (error) { console.error("crypt_check error", error); return false; }
  return !!data;
}
async function hashPassword(plain: string): Promise<string> {
  const { data, error } = await supabase.rpc("crypt_hash", { plain });
  if (error) throw error;
  return data as string;
}

const ADMIN_PW_KEY = "admin_password_hash";

async function checkAdminPassword(pw: string): Promise<boolean> {
  const hash = await getSetting<string | null>(ADMIN_PW_KEY, null);
  if (!hash) return false; // no admin password set up yet
  return checkPassword(hash, pw);
}

async function sendLine(text: string) {
  const token = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN");
  const to = Deno.env.get("LINE_TARGET_ID");
  if (!token || !to) { console.warn("LINE secrets not configured, skipping send"); return; }
  try {
    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
    });
  } catch (e) {
    console.error("sendLine failed", e);
  }
}

// ============================================================
// Action handlers — one function per action, same names as the old Code.gs cases
// ============================================================

async function handleUnlock(p: Record<string, unknown>) {
  const password = String(p.password ?? "");
  if (await checkAdminPassword(password)) {
    const { data: branches } = await supabase.from("branches").select("id, name").order("name");
    return json({ ok: true, role: "admin", branches: branches ?? [] });
  }
  const { data: branches } = await supabase.from("branches").select("id, name, staff_password_hash");
  for (const b of branches ?? []) {
    if (await checkPassword(b.staff_password_hash, password)) {
      return json({ ok: true, role: "staff", branch: { id: b.id, name: b.name } });
    }
  }
  return json({ ok: false });
}

async function handleHasBranches() {
  const { count } = await supabase.from("branches").select("id", { count: "exact", head: true });
  return json({ ok: true, hasBranches: (count ?? 0) > 0 });
}

async function handleListBranches(p: Record<string, unknown>) {
  if (!(await checkAdminPassword(String(p.password ?? "")))) return json({ ok: false });
  const { data } = await supabase.from("branches").select("id, name").order("name");
  return json({ ok: true, branches: data ?? [] });
}

async function handleAddBranch(p: Record<string, unknown>) {
  const pw = String(p.password ?? "");
  const existingHash = await getSetting<string | null>(ADMIN_PW_KEY, null);
  if (existingHash) {
    if (!(await checkPassword(existingHash, pw))) return json({ ok: false });
  } else {
    // ยังไม่เคยตั้งรหัสผ่านแอดมินมาก่อน (ระบบใหม่เอี่ยม) — รหัสผ่านที่กรอกตอนสร้างสาขาแรก
    // (หน้า "ตั้งค่าสาขาแรก") จะกลายเป็นรหัสผ่านแอดมินไปเลย ตรงกับที่ UI ฝั่งเว็บออกแบบไว้
    // (ให้กรอกรหัสผ่านแอดมินใหม่พร้อมกับตั้งสาขาแรกทีเดียว ไม่ได้คาดหวังว่าจะมีอยู่ก่อนแล้ว)
    if (!pw) return json({ ok: false, error: "missing_password" });
    await setSetting(ADMIN_PW_KEY, await hashPassword(pw));
  }
  const name = String(p.name ?? "").trim();
  const staffPw = String(p.staff_password ?? "");
  if (!name || !staffPw) return json({ ok: false, error: "missing_fields" });
  const id = name.replace(/\s+/g, "_");
  const hash = await hashPassword(staffPw);
  const { error } = await supabase.from("branches").insert({ id, name, staff_password_hash: hash });
  if (error) return json({ ok: false, error: error.message });
  await logAdmin("addBranch", { id, name });
  const { data } = await supabase.from("branches").select("id, name").order("name");
  return json({ ok: true, branches: data ?? [] });
}

async function handleUpdateBranch(p: Record<string, unknown>) {
  if (!(await checkAdminPassword(String(p.password ?? "")))) return json({ ok: false });
  const id = String(p.id ?? "");
  const update: Record<string, unknown> = {};
  if (p.name) update.name = String(p.name).trim();
  if (p.staff_password) update.staff_password_hash = await hashPassword(String(p.staff_password));
  const { error } = await supabase.from("branches").update(update).eq("id", id);
  if (error) return json({ ok: false, error: error.message });
  await logAdmin("updateBranch", { id });
  return json({ ok: true });
}

async function handleDeleteBranch(p: Record<string, unknown>) {
  if (!(await checkAdminPassword(String(p.password ?? "")))) return json({ ok: false });
  const id = String(p.id ?? "");
  const { error } = await supabase.from("branches").delete().eq("id", id);
  if (error) return json({ ok: false, error: error.message });
  await logAdmin("deleteBranch", { id });
  return json({ ok: true });
}

async function handleChangeAdminPassword(p: Record<string, unknown>) {
  const current = String(p.password ?? "");
  const next = String(p.new_password ?? "");
  if (!next) return json({ ok: false, error: "missing_new_password" });
  const existingHash = await getSetting<string | null>(ADMIN_PW_KEY, null);
  // Allow setting the very first admin password when none exists yet.
  if (existingHash && !(await checkPassword(existingHash, current))) return json({ ok: false });
  await setSetting(ADMIN_PW_KEY, await hashPassword(next));
  await logAdmin("changeAdminPassword", {});
  return json({ ok: true });
}

// ---- Items ----

function rowIsCentral(branchId: string | null) { return branchId === null || branchId === ""; }

async function handleListItems(p: Record<string, unknown>) {
  const branchId = String(p.branch_id ?? "");
  const { data: central } = await supabase.from("items").select("*").is("branch_id", null).eq("active", true);
  const { data: branchItems } = branchId
    ? await supabase.from("items").select("*").eq("branch_id", branchId).eq("active", true)
    : { data: [] as Record<string, unknown>[] };
  const byKey = new Map<string, Record<string, unknown>>();
  for (const it of central ?? []) byKey.set(`${it.category}||${it.name}`, it);
  for (const it of branchItems ?? []) byKey.set(`${it.category}||${it.name}`, it); // branch row overrides central
  const items = [...byKey.values()].sort((a, b) => (a.sort_order as number) - (b.sort_order as number));
  return json({ ok: true, items });
}

async function handleListItemsAdmin(p: Record<string, unknown>) {
  if (!(await checkAdminPassword(String(p.password ?? "")))) return json({ ok: false });
  const scope = String(p.scope ?? "");
  const q = supabase.from("items").select("*").eq("active", true).order("sort_order");
  const { data } = rowIsCentral(scope) ? await q.is("branch_id", null) : await q.eq("branch_id", scope);
  return json({ ok: true, items: data ?? [] });
}

async function handleSaveItem(p: Record<string, unknown>) {
  if (!(await checkAdminPassword(String(p.password ?? "")))) return json({ ok: false });
  if (p.id) {
    // Partial update (e.g. just sort_order from the reorder buttons).
    const update: Record<string, unknown> = {};
    for (const k of ["category", "name", "unit", "is_header", "sort_order"] as const) {
      if (p[k] !== undefined) update[k] = k === "is_header" ? String(p[k]).toUpperCase() === "TRUE" : p[k];
    }
    const { data, error } = await supabase.from("items").update(update).eq("id", p.id).select().maybeSingle();
    if (error) return json({ ok: false, error: error.message });
    return json({ ok: true, item: data });
  }
  const branchId = p.branch_id ? String(p.branch_id) : null;
  const row = {
    branch_id: rowIsCentral(branchId ?? "") ? null : branchId,
    category: String(p.category ?? ""),
    name: String(p.name ?? ""),
    unit: String(p.unit ?? ""),
    is_header: String(p.is_header ?? "FALSE").toUpperCase() === "TRUE",
    sort_order: Number(p.sort_order ?? 0),
  };
  const { data, error } = await supabase.from("items").insert(row).select().maybeSingle();
  if (error) return json({ ok: false, error: error.message });
  await logAdmin("saveItem", { name: row.name, branch_id: row.branch_id });
  return json({ ok: true, item: data });
}

async function handleDeleteItem(p: Record<string, unknown>) {
  if (!(await checkAdminPassword(String(p.password ?? "")))) return json({ ok: false });
  const id = String(p.id ?? "");
  const { error } = await supabase.from("items").update({ active: false }).eq("id", id); // soft delete
  if (error) return json({ ok: false, error: error.message });
  await logAdmin("deleteItem", { id });
  return json({ ok: true });
}

async function handleBulkSeedItems(p: Record<string, unknown>) {
  if (!(await checkAdminPassword(String(p.password ?? "")))) return json({ ok: false });
  const branchId = p.branch_id ? String(p.branch_id) : null;
  let items: Array<Record<string, unknown>> = [];
  try { items = JSON.parse(String(p.items ?? "[]")); } catch { return json({ ok: false, error: "bad_items_json" }); }

  const scopedBranchId = rowIsCentral(branchId ?? "") ? null : branchId;
  // Dedupe against ACTIVE rows only (the partial unique index already enforces this
  // at the DB level, but checking first lets us report an accurate `added` count
  // instead of relying on insert failures).
  const q = supabase.from("items").select("category, name").eq("active", true);
  const { data: existing } = scopedBranchId === null ? await q.is("branch_id", null) : await q.eq("branch_id", scopedBranchId);
  const existingKeys = new Set((existing ?? []).map((r: { category: string; name: string }) => `${r.category}||${r.name}`));

  const rows = items
    .filter((it) => !existingKeys.has(`${it.category}||${it.name}`))
    .map((it, idx) => ({
      branch_id: scopedBranchId,
      category: String(it.category ?? ""),
      name: String(it.name ?? ""),
      unit: String(it.unit ?? ""),
      is_header: String(it.is_header ?? "FALSE").toUpperCase() === "TRUE",
      sort_order: idx,
    }));
  if (!rows.length) { await logAdmin("bulkSeedItems", { branchId, added: 0 }); return json({ ok: true, added: 0 }); }

  const { error } = await supabase.from("items").insert(rows);
  if (error) { await logAdmin("bulkSeedItems", { branchId, added: 0, error: error.message }); return json({ ok: false, error: error.message }); }
  await logAdmin("bulkSeedItems", { branchId, added: rows.length });
  return json({ ok: true, added: rows.length });
}

// ---- Buffer / unit config (key-value settings) ----

async function handleGetConfig(p: Record<string, unknown>, key: string) {
  if (!(await checkAdminPassword(String(p.password ?? "")))) return json({ ok: false });
  const config = await getSetting<Record<string, unknown> | null>(key, null);
  return config ? json({ ok: true, config }) : json({ ok: false });
}
async function handleSaveConfig(p: Record<string, unknown>, key: string) {
  if (!(await checkAdminPassword(String(p.password ?? "")))) return json({ ok: false });
  let config: unknown;
  try { config = JSON.parse(String(p.config ?? "{}")); } catch { return json({ ok: false, error: "bad_config_json" }); }
  await setSetting(key, config);
  return json({ ok: true });
}

// ---- Check-in / movement records ----

async function handleCreate(p: Record<string, unknown>) {
  const branchId = String(p.branch_id ?? "");
  const category = String(p.category ?? "");
  let items: Array<Record<string, unknown>> = [];
  try { items = JSON.parse(String(p.items ?? "[]")); } catch { /* ignore, saved as empty */ }

  const { data: record, error } = await supabase
    .from("check_records")
    .insert({
      branch_id: branchId,
      category,
      checker_name: p.checker_name ?? null,
      date: p.date ?? new Date().toISOString(),
      line_text: p.line_text ?? null,
    })
    .select()
    .single();
  if (error) return json({ ok: false, error: error.message });

  if (items.length) {
    await supabase.from("check_record_items").insert(
      items.map((it) => ({
        record_id: record.id,
        item_name: String(it.name ?? ""),
        quantity: Number(it.quantity ?? 0),
        quantity_base: it.quantity_base !== undefined ? Number(it.quantity_base) : null,
        unit: it.unit ?? null,
        note: it.note ?? null,
        waste_qty: it.waste_qty !== undefined ? Number(it.waste_qty) : null,
      })),
    );
  }

  if (p.line_text) await sendLine(String(p.line_text));
  // Phase 3 (deferred): reorder-alert computation + LINE push goes here once
  // getReorderConfig/saveReorderConfig land.

  return json({ ok: true, id: record.id });
}

async function handleCreateMovement(p: Record<string, unknown>) {
  const branchId = String(p.branch_id ?? "");
  let entries: Array<Record<string, unknown>> = [];
  try { entries = JSON.parse(String(p.entries ?? "[]")); } catch { /* ignore */ }
  // Client sends `entries` as an array directly (not a JSON string) at the call
  // site — handle both shapes defensively since postNoCors serializes the whole
  // payload as JSON already.
  if (!entries.length && Array.isArray(p.entries)) entries = p.entries as Array<Record<string, unknown>>;

  const { data: movement, error } = await supabase
    .from("stock_movements")
    .insert({
      branch_id: branchId,
      checker_name: p.checker_name ?? null,
      date: p.date ?? new Date().toISOString(),
      line_text: p.line_text ?? null,
    })
    .select()
    .single();
  if (error) return json({ ok: false, error: error.message });

  if (entries.length) {
    await supabase.from("stock_movement_lines").insert(
      entries.map((en) => ({
        movement_id: movement.id,
        item_name: String(en.name ?? ""),
        direction: String(en.direction ?? "adjust"),
        quantity: Number(en.quantity ?? 0),
        unit: en.unit ?? null,
      })),
    );
  }

  if (p.line_text) await sendLine(String(p.line_text));
  return json({ ok: true, id: movement.id });
}

async function handleList(p: Record<string, unknown>) {
  const branchId = String(p.branch_id ?? "");
  const { data: checks } = await supabase
    .from("check_records")
    .select("*, check_record_items(*)")
    .eq("branch_id", branchId);
  const { data: movements } = await supabase
    .from("stock_movements")
    .select("*, stock_movement_lines(*)")
    .eq("branch_id", branchId);

  const records = [
    ...(checks ?? []).map((r: any) => ({
      id: r.id,
      branch_id: r.branch_id,
      type: "check",
      category: r.category,
      checker_name: r.checker_name,
      date: r.date,
      items: JSON.stringify(
        (r.check_record_items ?? []).map((it: Record<string, unknown>) => ({
          name: it.item_name, quantity: it.quantity, quantity_base: it.quantity_base,
          unit: it.unit, note: it.note, waste_qty: it.waste_qty,
        })),
      ),
    })),
    ...(movements ?? []).map((r: any) => ({
      id: r.id,
      branch_id: r.branch_id,
      type: "movement",
      category: "ปรับสต็อค",
      checker_name: r.checker_name,
      date: r.date,
      items: JSON.stringify(
        (r.stock_movement_lines ?? []).map((it: Record<string, unknown>) => ({
          name: it.item_name, direction: it.direction, quantity: it.quantity, unit: it.unit,
        })),
      ),
    })),
  ];
  return json({ ok: true, records });
}

async function handleUpdateItemInRecord(p: Record<string, unknown>) {
  if (!(await checkAdminPassword(String(p.password ?? "")))) return json({ ok: false });
  const kind = String(p.kind ?? "check");
  const recordId = String(p.record_id ?? "");
  const itemName = String(p.item_name ?? "");
  const quantity = Number(p.quantity ?? 0);
  if (kind === "movement") {
    const { error } = await supabase.from("stock_movement_lines").update({ quantity })
      .eq("movement_id", recordId).eq("item_name", itemName);
    if (error) return json({ ok: false, error: error.message });
  } else {
    const { error } = await supabase.from("check_record_items").update({ quantity, quantity_base: quantity })
      .eq("record_id", recordId).eq("item_name", itemName);
    if (error) return json({ ok: false, error: error.message });
    // Append to edit_history (jsonb array) via Postgres's `||` concat operator so the
    // read-modify-write happens atomically in the DB, not as a separate fetch here.
    await supabase.rpc("append_edit_history", {
      p_record_id: recordId,
      p_entry: { item_name: itemName, quantity, editor: p.editor_name ?? null, at: new Date().toISOString() },
    });
  }
  await logAdmin("updateItemInRecord", { kind, recordId, itemName, quantity, editor: p.editor_name });
  return json({ ok: true });
}

async function handleGetCurrentStockLevels(p: Record<string, unknown>) {
  const branchId = String(p.branch_id ?? "");
  const { data, error } = await supabase.rpc("get_current_stock_levels", { p_branch_id: branchId });
  if (error) return json({ ok: false, error: error.message });
  const levels: Record<string, unknown> = {};
  for (const row of data ?? []) {
    levels[row.item_name] = { qty: row.qty, unit: row.unit, category: row.category, hasBaseline: row.has_baseline };
  }
  return json({ ok: true, levels });
}

// ============================================================
// Phase 2: Gemini-backed translation + AI item import
// ============================================================

const GEMINI_MODEL = "gemini-2.5-flash";

async function callGemini(parts: unknown[], opts: { jsonMode?: boolean } = {}): Promise<string> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");
  const body: Record<string, unknown> = { contents: [{ parts }] };
  if (opts.jsonMode) body.generationConfig = { responseMimeType: "application/json" };
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `gemini_http_${res.status}`);
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("gemini_empty_response");
  return text;
}

// Same fixed UI label set as UI_TH in index.html (Thai source strings, keyed by the
// same keys the client's t() function looks up) — duplicated here since translateAll
// has no other way to know what the UI even says without the client sending it.
const UI_TH: Record<string, string> = {
  dailyCheck: "เช็คสต็อกประจำวัน", history: "ประวัติ", boatFrontDesc: "เช็คสต็อกวัตถุดิบหน้าเรือ",
  customFoodDesc: "เช็คสต็อกวัตถุดิบอาหารตามสั่ง", staffChildDesc: "เช็คสต็อกอุปกรณ์เด็กเสิร์ฟ",
  backHome: "กลับหน้าหลัก", staffName: "ผู้เช็คสต็อก", enterName: "กรุณากรอกชื่อผู้ทำการเช็คสต็อก",
  fullName: "ชื่อ-นามสกุล", startChecking: "เริ่มเช็คสต็อก", item: "รายการ", quantity: "จำนวน", unit: "หน่วย",
  note: "หมายเหตุ", waste: "ของเสีย", save: "บันทึกข้อมูล", historyTitle: "ประวัติการเช็คสต็อก", selectDate: "เลือกวันที่",
  category: "หมวดหมู่", all: "ทั้งหมด", staffChecker: "ผู้เช็คสต็อก:", date: "วันที่:", date2: "วันที่",
  noHistory: "ไม่พบประวัติการเช็คสต็อก", saved: "บันทึกข้อมูลสำเร็จ!", error: "เกิดข้อผิดพลาด กรุณาลองใหม่",
  fullLimit: "ไม่สามารถบันทึกได้ ข้อมูลเต็มแล้ว", enterName2: "กรุณากรอกชื่อ", back: "กลับ", backHistory: "กลับหน้าประวัติ",
  compared: "เปรียบเทียบกับ", increased: "เพิ่มขึ้น", decreased: "ลดลง", noChange: "ไม่เปลี่ยนแปลง",
  changeLabel: "เปลี่ยนแปลง", changePctLabel: "เทียบเป็น %", noPrevious: "ไม่มีรอบก่อนหน้า", invalidQty: "รูปแบบจำนวนไม่ถูกต้อง",
  selectBranch: "เลือกสาขา", loginPrompt: "กรอกรหัสผ่านเพื่อเข้าใช้งาน", loginPasswordLabel: "รหัสผ่าน", login: "เข้าสู่ระบบ",
  logout: "ออกจากระบบ", switchBranch: "สลับสาขา", setupFirstBranch: "ยังไม่มีสาขาในระบบ ตั้งค่าสาขาแรก (ใช้รหัสผ่านแอดมิน)",
  branchNameLabel: "ชื่อสาขา", branchPasswordLabel: "รหัสผ่านประจำสาขา (ให้พนักงานใช้)", createBranch: "สร้างสาขา",
  scopeGlobal: "ส่วนกลาง (ทุกสาขา)", scopeLabel: "ขอบเขต",
  movement: "ปรับสต็อค", movementDesc: "บันทึกรับเข้า / เบิกออก / ปรับยอด",
  movementIn: "รับเข้า", movementOut: "เบิกออก", movementAdjust: "ปรับยอด", reason: "เหตุผล/หมายเหตุ",
  admin: "แอดมิน", adminPasswordPrompt: "กรอกรหัสผ่านแอดมิน", remaining: "คงเหลือ", currentlyRemaining: "ตอนนี้คงเหลือ",
  reviewAndSave: "รายการ — ตรวจทาน/บันทึก", reviewBeforeSave: "ตรวจทานก่อนบันทึก",
  wrongPassword: "รหัสผ่านไม่ถูกต้อง", manageItems: "จัดการรายการสินค้า", manageBranches: "จัดการสาขา",
  manageTranslations: "จัดการคำแปล", addItem: "เพิ่มรายการสินค้า", edit: "แก้ไข", delete: "ลบ",
  confirmDelete: "ยืนยันการลบรายการนี้?", addBranch: "เพิ่มสาขา", branchName: "ชื่อสาขา",
  refreshTranslation: "อัปเดตคำแปลด้วย AI", translating: "กำลังแปล...", editRecord: "แก้ไขรายการนี้",
  saveEdit: "บันทึกการแก้ไข", cancel: "ยกเลิก", saveOk: "บันทึกสำเร็จ",
  movementType: "ประเภท", movementHistory: "รายการปรับสต็อค", editedNote: "แก้ไขล่าสุดโดย",
  noCategoriesYet: "ยังไม่มีหมวดหมู่สินค้า กรุณาไปเพิ่มรายการสินค้าในหน้าแอดมินก่อน",
  checkStockGeneric: "เช็คสต็อกวัตถุดิบในหมวดนี้",
  shopTitle: "ระบบเช็คสต็อกสินค้า", loading: "กำลังโหลด...", fillAllQty: "กรุณากรอกจำนวนให้ครบทุกช่อง",
  fillBranchNameAndPassword: "กรอกชื่อสาขาและรหัสผ่านสาขา", firstBranchNameHint: "ชื่อสาขา เช่น สาขาหลัก",
  adminPasswordShort: "รหัสผ่านแอดมิน", enterNamePlaceholder: "กรอกชื่อของคุณ",
  mvQuickSearchPlaceholder: "ค้นหาด่วน: พิมพ์ชื่อสินค้าที่จะปรับ...", qtyInputHint: "* ช่อง \"จำนวน\" ใส่ได้เฉพาะ 0-9 และสัญลักษณ์ . / + -",
  lockedTooltip: "ยืนยันแล้ว กดอีกครั้งเพื่อแก้ไข", lockTooltip: "กดยืนยัน/ล็อครายการนี้",
  newVersionAvailable: "มีเวอร์ชันใหม่ กดเพื่ออัปเดต",
};

const LANG_NAMES: Record<string, string> = {
  en: "English", my: "Burmese (Myanmar language)", lo: "Lao", km: "Khmer", vi: "Vietnamese",
};

function identityMap(values: string[]): Record<string, string> {
  return Object.fromEntries(values.map((v) => [v, v]));
}

// Keeps the model's translation when present and non-empty, falls back to the Thai
// source otherwise — a partial/malformed Gemini response degrades to "untranslated"
// instead of breaking the whole dict.
function mergeWithFallback(source: Record<string, string>, result: unknown): Record<string, string> {
  const r = (result && typeof result === "object") ? result as Record<string, unknown> : {};
  const out: Record<string, string> = {};
  for (const k of Object.keys(source)) {
    const v = r[k];
    out[k] = (typeof v === "string" && v.trim()) ? v : source[k];
  }
  return out;
}

async function handleTranslateAll(p: Record<string, unknown>) {
  if (!(await checkAdminPassword(String(p.password ?? "")))) return json({ ok: false });
  const lang = String(p.lang ?? "");
  const langName = LANG_NAMES[lang];
  if (!langName) return json({ ok: false, error: "unsupported_lang" });

  const { data: itemsData } = await supabase.from("items").select("name, unit, category").eq("active", true);
  const items = (itemsData ?? []) as Array<{ name: string; unit: string; category: string }>;
  const itemsSource = identityMap([...new Set(items.map((i) => i.name).filter(Boolean))]);
  const unitsSource = identityMap([...new Set(items.map((i) => i.unit).filter(Boolean))]);
  const categoriesSource = identityMap([...new Set(items.map((i) => i.category).filter(Boolean))]);

  const prompt = `Translate the values in each of these JSON objects from Thai into ${langName}, keeping every key exactly as given (do not translate keys, only values). This is UI text and item/unit/category names for a Thai restaurant stock-checking app — keep translations short and natural for restaurant staff. Return ONLY a single JSON object of the exact shape {"ui": {...}, "items": {...}, "units": {...}, "categories": {...}}, with no other text.

ui: ${JSON.stringify(UI_TH)}
items: ${JSON.stringify(itemsSource)}
units: ${JSON.stringify(unitsSource)}
categories: ${JSON.stringify(categoriesSource)}`;

  let parsed: unknown;
  try {
    const text = await callGemini([{ text: prompt }], { jsonMode: true });
    parsed = JSON.parse(text);
  } catch (e) {
    return json({ ok: false, error: "translate_failed: " + String((e as Error).message ?? e) });
  }
  const p2 = (parsed && typeof parsed === "object") ? parsed as Record<string, unknown> : {};
  const dict = {
    ui: mergeWithFallback(UI_TH, p2.ui),
    items: mergeWithFallback(itemsSource, p2.items),
    units: mergeWithFallback(unitsSource, p2.units),
    categories: mergeWithFallback(categoriesSource, p2.categories),
  };

  await supabase.from("translation_cache").upsert({ lang, dict, updated_at: new Date().toISOString() });
  await logAdmin("translateAll", { lang });
  return json({ ok: true, dict });
}

async function handleGetDictionary(p: Record<string, unknown>) {
  const lang = String(p.lang ?? "");
  const { data } = await supabase.from("translation_cache").select("dict").eq("lang", lang).maybeSingle();
  return json({ ok: true, dict: data?.dict ?? { ui: {}, items: {}, units: {}, categories: {} } });
}

async function handleTranslateNote(p: Record<string, unknown>) {
  const text = String(p.text ?? "").trim();
  if (!text) return json({ ok: false, error: "empty_text" });
  const targetLang = String(p.target_lang ?? "th");
  const langName = targetLang === "th" ? "Thai" : (LANG_NAMES[targetLang] ?? targetLang);
  try {
    const prompt = `Translate this short note from a restaurant stock-check app into ${langName}. Reply with ONLY the translated text, no quotes, no explanation:\n\n${text}`;
    const translated = (await callGemini([{ text: prompt }])).trim();
    return json({ ok: true, translated });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message ?? e) });
  }
}

async function runParseItemsAI(
  type: string,
  content: string,
  mimeType: string,
  existingCategories: string[],
): Promise<Array<{ category: string; name: string; unit: string }>> {
  const instructions = `You are reading a raw-material / stock list for a Thai restaurant. Extract every row as {"category": "...", "name": "...", "unit": "..."}, all in Thai. Reuse one of these existing categories when a row clearly fits one, otherwise propose a short new Thai category name: ${JSON.stringify(existingCategories)}. Skip rows that are not actual stock items (totals, section titles, blank rows). Return ONLY a JSON object of shape {"items": [{"category":"...","name":"...","unit":"..."}, ...]}.`;

  const parts: unknown[] = type === "media"
    ? [{ text: instructions }, { inlineData: { mimeType: mimeType || "application/pdf", data: content } }]
    : [{ text: instructions + "\n\nSource data (CSV):\n" + content }];

  const text = await callGemini(parts, { jsonMode: true });
  const parsed = JSON.parse(text);
  const items = Array.isArray((parsed as Record<string, unknown>)?.items) ? (parsed as { items: unknown[] }).items : [];
  return items
    .map((it) => {
      const r = it as Record<string, unknown>;
      return { category: String(r.category ?? "").trim(), name: String(r.name ?? "").trim(), unit: String(r.unit ?? "").trim() };
    })
    .filter((it) => it.name);
}

async function handleParseItemsAI(p: Record<string, unknown>) {
  if (!(await checkAdminPassword(String(p.password ?? "")))) return json({ ok: false });
  const jobId = String(p.jobId ?? "");
  if (!jobId) return json({ ok: false, error: "missing_jobId" });
  const type = String(p.type ?? "text");
  const content = String(p.content ?? "");
  const mimeType = String(p.mimeType ?? "");
  let existingCategories: string[] = [];
  if (Array.isArray(p.existingCategories)) existingCategories = p.existingCategories as string[];
  else { try { existingCategories = JSON.parse(String(p.existingCategories ?? "[]")); } catch { /* ignore */ } }

  await supabase.from("ai_import_jobs").upsert({ job_id: jobId, status: "pending", items: null, error: null });

  // Runs after the response is sent — parsing (especially a PDF/image via Gemini) can
  // take well past the client's own request timeout, so the job is polled separately
  // via getAiImportResult rather than awaited on this request.
  const task = runParseItemsAI(type, content, mimeType, existingCategories)
    .then((items) => supabase.from("ai_import_jobs").update({ status: "done", items }).eq("job_id", jobId))
    .catch((e) => supabase.from("ai_import_jobs").update({ status: "error", error: String(e?.message ?? e) }).eq("job_id", jobId));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(task); else await task;

  return json({ ok: true, jobId });
}

async function handleGetAiImportResult(p: Record<string, unknown>) {
  if (!(await checkAdminPassword(String(p.password ?? "")))) return json({ ok: false });
  const jobId = String(p.jobId ?? "");
  const { data } = await supabase.from("ai_import_jobs").select("status, items, error").eq("job_id", jobId).maybeSingle();
  if (!data) return json({ ok: true, status: "pending", items: [] });
  return json({ ok: true, status: data.status, items: data.items ?? [], error: data.error ?? undefined });
}

// ============================================================
// Dispatch
// ============================================================

const ACTIONS: Record<string, (p: Record<string, unknown>) => Promise<Response>> = {
  unlock: handleUnlock,
  hasBranches: handleHasBranches,
  listBranches: handleListBranches,
  addBranch: handleAddBranch,
  updateBranch: handleUpdateBranch,
  deleteBranch: handleDeleteBranch,
  changeAdminPassword: handleChangeAdminPassword,
  listItems: handleListItems,
  listItemsAdmin: handleListItemsAdmin,
  saveItem: handleSaveItem,
  deleteItem: handleDeleteItem,
  bulkSeedItems: handleBulkSeedItems,
  getBufferConfig: (p) => handleGetConfig(p, "buffer_config"),
  saveBufferConfig: (p) => handleSaveConfig(p, "buffer_config"),
  getUnitConfig: (p) => handleGetConfig(p, "unit_config"),
  saveUnitConfig: (p) => handleSaveConfig(p, "unit_config"),
  create: handleCreate,
  createMovement: handleCreateMovement,
  list: handleList,
  updateItemInRecord: handleUpdateItemInRecord,
  getCurrentStockLevels: handleGetCurrentStockLevels,
  translateAll: handleTranslateAll,
  getDictionary: handleGetDictionary,
  translateNote: handleTranslateNote,
  parseItemsAI: handleParseItemsAI,
  getAiImportResult: handleGetAiImportResult,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  try {
    const params: Record<string, unknown> = req.method === "GET"
      ? Object.fromEntries(new URL(req.url).searchParams)
      : await req.json();
    const action = String(params.action ?? "");
    const handler = ACTIONS[action];
    if (!handler) return json({ ok: false, error: "unknown_action: " + action }, 404);
    return await handler(params);
  } catch (e) {
    console.error("dispatch error", e);
    return json({ ok: false, error: String(e) }, 500);
  }
});
