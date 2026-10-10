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
  if (p.hidden_categories !== undefined) {
    try {
      const parsed = JSON.parse(String(p.hidden_categories));
      if (Array.isArray(parsed)) update.hidden_categories = parsed.map((c) => String(c));
    } catch { /* malformed — leave hidden_categories untouched rather than wipe it */ }
  }
  const { error } = await supabase.from("branches").update(update).eq("id", id);
  if (error) return json({ ok: false, error: error.message });
  await logAdmin("updateBranch", { id });
  const { data } = await supabase.from("branches").select("id, name").order("name");
  return json({ ok: true, branches: data ?? [] });
}

// Category names come from items (central + this branch's own, active only) rather than a
// separate categories table — there isn't one; "category" is just a free-text column on items.
async function handleGetBranchCategories(p: Record<string, unknown>) {
  if (!(await checkAdminPassword(String(p.password ?? "")))) return json({ ok: false });
  const branchId = String(p.branch_id ?? "");
  if (!branchId) return json({ ok: false, error: "missing_branch_id" });
  const { data: central } = await supabase.from("items").select("category").is("branch_id", null).eq("active", true);
  const { data: branchItems } = await supabase.from("items").select("category").eq("branch_id", branchId).eq("active", true);
  const categories = [...new Set(
    [...(central ?? []), ...(branchItems ?? [])].map((it) => it.category as string),
  )].sort();
  const { data: branch } = await supabase.from("branches").select("hidden_categories").eq("id", branchId).maybeSingle();
  const hidden = (branch?.hidden_categories as string[] | null) ?? [];
  return json({ ok: true, categories, hidden });
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
  const centralOrder = new Map<string, number>();
  for (const it of central ?? []) {
    const key = `${it.category}||${it.name}`;
    byKey.set(key, it);
    centralOrder.set(key, it.sort_order as number);
  }
  for (const it of branchItems ?? []) byKey.set(`${it.category}||${it.name}`, it); // branch row overrides central

  let hiddenCategories: string[] = [];
  if (branchId) {
    const { data: branch } = await supabase.from("branches").select("hidden_categories").eq("id", branchId).maybeSingle();
    hiddenCategories = (branch?.hidden_categories as string[] | null) ?? [];
  }
  const items = [...byKey.values()]
    .filter((it) => !hiddenCategories.includes(it.category as string))
    .sort((a, b) => {
      // A branch override keeps the CENTRAL item's position when one exists, so a branch missing
      // some items still shows the rest in the same relative order as every other branch — only
      // an item with no central counterpart at all falls back to its own (branch-local) order.
      const keyA = `${a.category}||${a.name}`, keyB = `${b.category}||${b.name}`;
      const oa = centralOrder.get(keyA) ?? (a.sort_order as number);
      const ob = centralOrder.get(keyB) ?? (b.sort_order as number);
      // created_at (insertion order) as a tiebreaker — not name: items are deliberately grouped
      // into physical/work zones by drag-reorder, not alphabetically, and most share sort_order 0
      // (the default for anything added one at a time) without ever having been dragged. Insertion
      // order stays stable across requests without imposing an ordering nobody asked for.
      return oa - ob || String(a.created_at).localeCompare(String(b.created_at));
    });
  return json({ ok: true, items });
}

async function handleListItemsAdmin(p: Record<string, unknown>) {
  if (!(await checkAdminPassword(String(p.password ?? "")))) return json({ ok: false });
  const scope = String(p.scope ?? "");
  // Secondary sort by created_at (insertion order) breaks ties deterministically — a lot of items
  // share the same sort_order (0, the default for anything added one at a time instead of via
  // bulk-seed), and without a tiebreaker Postgres doesn't guarantee the same order across
  // requests, so the list visibly reshuffled on every reload even when nothing changed. Insertion
  // order rather than name, since items are grouped into zones by drag-reorder, not alphabetized.
  const q = supabase.from("items").select("*").eq("active", true).order("sort_order").order("created_at");
  const { data } = rowIsCentral(scope) ? await q.is("branch_id", null) : await q.eq("branch_id", scope);
  return json({ ok: true, items: data ?? [] });
}

async function handleSaveItem(p: Record<string, unknown>) {
  if (!(await checkAdminPassword(String(p.password ?? "")))) return json({ ok: false });
  if (p.id) {
    const { data: before } = await supabase.from("items").select("name, category").eq("id", p.id).maybeSingle();
    // Partial update (e.g. just sort_order from the reorder buttons).
    const update: Record<string, unknown> = {};
    for (const k of ["category", "name", "unit", "sku", "is_header", "sort_order"] as const) {
      if (p[k] !== undefined) update[k] = k === "is_header" ? String(p[k]).toUpperCase() === "TRUE" : p[k];
    }
    const { data, error } = await supabase.from("items").update(update).eq("id", p.id).select().maybeSingle();
    if (error) {
      // Postgres unique_violation on items_scope_key_active — another active item already
      // has this category+name in this scope. Surface a code the client can show a plain
      // message for, instead of the raw constraint-name error text.
      if (error.code === "23505") return json({ ok: false, error: "duplicate_name" });
      return json({ ok: false, error: error.message });
    }
    const newName = typeof update.name === "string" ? update.name : null;
    if (before && newName && newName !== before.name) {
      try { await cascadeItemRename(before.name, before.category, newName); }
      catch (e) { console.error("cascadeItemRename failed", e); }
    }
    return json({ ok: true, item: data });
  }
  const branchId = p.branch_id ? String(p.branch_id) : null;
  const row = {
    branch_id: rowIsCentral(branchId ?? "") ? null : branchId,
    category: String(p.category ?? ""),
    name: String(p.name ?? ""),
    unit: String(p.unit ?? ""),
    sku: p.sku ? String(p.sku).trim() : null,
    is_header: String(p.is_header ?? "FALSE").toUpperCase() === "TRUE",
    sort_order: Number(p.sort_order ?? 0),
  };
  const { data, error } = await supabase.from("items").insert(row).select().maybeSingle();
  if (error) return json({ ok: false, error: error.message });
  await logAdmin("saveItem", { name: row.name, branch_id: row.branch_id });
  return json({ ok: true, item: data });
}

// Client sends a compressed JPEG as base64 (resized/compressed in-browser before upload, so this
// is always a small payload) — uploaded via the service-role key, which bypasses storage RLS the
// same way it bypasses table RLS, so the bucket needs no policies, just `public: true` for reads.
async function handleUploadItemImage(p: Record<string, unknown>) {
  if (!(await checkAdminPassword(String(p.password ?? "")))) return json({ ok: false });
  const id = String(p.id ?? "");
  const imageBase64 = String(p.image_base64 ?? "");
  if (!id || !imageBase64) return json({ ok: false, error: "missing_fields" });

  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(imageBase64), (c) => c.charCodeAt(0));
  } catch {
    return json({ ok: false, error: "bad_image_data" });
  }

  const path = `${id}.jpg`;
  const { error: uploadError } = await supabase.storage.from("item-images").upload(path, bytes, {
    contentType: "image/jpeg",
    upsert: true,
  });
  if (uploadError) return json({ ok: false, error: uploadError.message });

  const { data: urlData } = supabase.storage.from("item-images").getPublicUrl(path);
  // Cache-bust so the <img> actually re-fetches after a re-upload replaces the same path —
  // browsers otherwise keep showing the old cached image at that URL indefinitely.
  const imageUrl = `${urlData.publicUrl}?v=${Date.now()}`;
  const { error: updateError } = await supabase.from("items").update({ image_url: imageUrl }).eq("id", id);
  if (updateError) return json({ ok: false, error: updateError.message });

  await logAdmin("uploadItemImage", { id });
  return json({ ok: true, image_url: imageUrl });
}

// Item names are the join key across historical records and name-keyed config (not the
// item's uuid), so a rename has to carry those references forward too, or stock-level
// continuity and unit/buffer overrides silently break the moment the name changes.
async function cascadeItemRename(oldName: string, category: string, newName: string) {
  // check_record_items has no category of its own — scope the rename to records of the
  // SAME category this item belonged to, so a same-named item in a different category
  // (a different item) is never touched.
  const { data: recordsInCat } = await supabase.from("check_records").select("id").eq("category", category);
  const recordIds = (recordsInCat ?? []).map((r: { id: string }) => r.id);
  if (recordIds.length) {
    await supabase.from("check_record_items").update({ item_name: newName }).eq("item_name", oldName).in("record_id", recordIds);
  }
  // Stock movements aren't category-scoped, so match by name directly.
  await supabase.from("stock_movement_lines").update({ item_name: newName }).eq("item_name", oldName);

  for (const key of ["buffer_config", "unit_config"] as const) {
    const config = await getSetting<Record<string, unknown> | null>(key, null);
    if (!config) continue;
    let changed = false;
    if (key === "buffer_config") {
      for (const sub of ["itemOverride", "itemPredictOverride"] as const) {
        const map = config[sub] as Record<string, unknown> | undefined;
        if (map && Object.prototype.hasOwnProperty.call(map, oldName)) {
          map[newName] = map[oldName];
          delete map[oldName];
          changed = true;
        }
      }
    } else if (Object.prototype.hasOwnProperty.call(config, oldName)) {
      config[newName] = config[oldName];
      delete config[oldName];
      changed = true;
    }
    if (changed) await setSetting(key, config);
  }
}

async function handleDeleteItem(p: Record<string, unknown>) {
  if (!(await checkAdminPassword(String(p.password ?? "")))) return json({ ok: false });
  const id = String(p.id ?? "");
  const { error } = await supabase.from("items").update({ active: false }).eq("id", id); // soft delete
  if (error) return json({ ok: false, error: error.message });
  await logAdmin("deleteItem", { id });
  return json({ ok: true });
}

// Soft-deletes every active item in one category, within one scope (central when `scope` is
// empty/central, otherwise one branch). Replaces the old "delete everything in this scope" button
// with a narrower, per-category action — much harder to fat-finger into wiping an entire scope.
async function handleDeleteCategoryInScope(p: Record<string, unknown>) {
  if (!(await checkAdminPassword(String(p.password ?? "")))) return json({ ok: false });
  const scope = String(p.scope ?? "");
  const category = String(p.category ?? "");
  if (!category) return json({ ok: false, error: "missing_category" });
  const base = supabase.from("items").update({ active: false }).eq("category", category).eq("active", true);
  const { data, error } = rowIsCentral(scope)
    ? await base.is("branch_id", null).select("id")
    : await base.eq("branch_id", scope).select("id");
  if (error) return json({ ok: false, error: error.message });
  const deleted = (data ?? []).length;
  await logAdmin("deleteCategoryInScope", { scope, category, deleted });
  return json({ ok: true, deleted });
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

  // Snapshot low-stock flags BEFORE inserting this check — get_current_stock_levels only
  // sees data already committed, so "predicted" here means "right before this check landed".
  const reorderConfig = await getSetting<Record<string, unknown> | null>("reorder_config", null);
  let flaggedThisCategory: string[] = [];
  if (reorderConfig?.enabled) {
    try { flaggedThisCategory = await computeLowStockFlags(branchId, category, items); }
    catch (e) { console.error("computeLowStockFlags failed", e); }
  }

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

  // Never let a bug in the reorder-alert bookkeeping break an otherwise-successful save.
  if (reorderConfig?.enabled) {
    try { await advanceReorderRound(branchId, category, flaggedThisCategory, reorderConfig); }
    catch (e) { console.error("advanceReorderRound failed", e); }
  }

  return json({ ok: true, id: record.id });
}

// ============================================================
// Phase 3: reorder-alert computation
// ============================================================

// Same low-stock-flag logic as index.html's effectiveBufferPct_/computeFlag_, so the
// reorder alert flags exactly the items that would show 🔽/⚠️ on the check-in screen
// itself — no separate "reorder point" concept exists anywhere else in this app.
const REORDER_CRITICAL_RATIO = 0.5;

function isPredictionEnabled(itemName: string, category: string, bufferConfig: Record<string, unknown>): boolean {
  const itemPredictOverride = bufferConfig.itemPredictOverride as Record<string, boolean | null> | undefined;
  const io = itemPredictOverride?.[itemName];
  if (io === true || io === false) return io;
  const categoryPredict = bufferConfig.categoryPredict as Record<string, boolean> | undefined;
  return !!categoryPredict?.[category];
}
function effectiveBufferPct(itemName: string, category: string, bufferConfig: Record<string, unknown>): number {
  const itemOverride = bufferConfig.itemOverride as Record<string, number | null> | undefined;
  const io = itemOverride?.[itemName];
  if (io !== undefined && io !== null) return Number(io);
  const categoryDefault = bufferConfig.categoryDefault as Record<string, number> | undefined;
  return Number(categoryDefault?.[category] ?? 5);
}
function isLowFlag(actual: number, predicted: number | null, bufferPct: number): boolean {
  if (predicted === null || predicted === undefined || !isFinite(predicted) || predicted === 0) return false;
  if (!isFinite(actual)) return false;
  const diffPct = ((actual - predicted) / predicted) * 100;
  if (diffPct >= 0) return false; // at/above expected — not low
  return Math.abs(diffPct) / 100 >= REORDER_CRITICAL_RATIO || Math.abs(diffPct) > bufferPct;
}

async function computeLowStockFlags(branchId: string, category: string, items: Array<Record<string, unknown>>): Promise<string[]> {
  const bufferConfig = await getSetting<Record<string, unknown> | null>("buffer_config", null);
  if (!bufferConfig) return [];
  const { data: levels } = await supabase.rpc("get_current_stock_levels", { p_branch_id: branchId });
  const predictedByName = new Map<string, number | null>();
  for (const row of (levels ?? []) as Array<{ item_name: string; category: string; qty: number; has_baseline: boolean }>) {
    if (row.category === category) predictedByName.set(row.item_name, row.has_baseline ? Number(row.qty) : null);
  }
  const flagged: string[] = [];
  for (const it of items) {
    const name = String(it.name ?? "");
    if (!name || !isPredictionEnabled(name, category, bufferConfig)) continue;
    const predicted = predictedByName.has(name) ? predictedByName.get(name)! : null;
    const actual = Number(it.quantity_base ?? it.quantity ?? NaN);
    const bufferPct = effectiveBufferPct(name, category, bufferConfig);
    if (isLowFlag(actual, predicted, bufferPct)) flagged.push(name);
  }
  return flagged;
}

// Asia/Bangkok is a fixed UTC+7 offset (no DST), so this is safe without a timezone library.
function bangkokToday(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function getBranchCategoryCount(branchId: string): Promise<number> {
  const { data: central } = await supabase.from("items").select("category").is("branch_id", null).eq("active", true).eq("is_header", false);
  const { data: branchSpecific } = await supabase.from("items").select("category").eq("branch_id", branchId).eq("active", true).eq("is_header", false);
  const set = new Set<string>();
  for (const r of (central ?? []) as Array<{ category: string }>) set.add(r.category);
  for (const r of (branchSpecific ?? []) as Array<{ category: string }>) set.add(r.category);
  return set.size;
}

async function upsertReorderState(
  branchId: string, trackingDate: string, categoriesChecked: string[], pendingItems: string[],
  roundsSinceAlert: number, readyForCombined: boolean,
) {
  await supabase.from("reorder_round_state").upsert({
    branch_id: branchId,
    tracking_date: trackingDate,
    categories_checked: categoriesChecked,
    pending_items: pendingItems,
    rounds_since_alert: roundsSinceAlert,
    ready_for_combined: readyForCombined,
    updated_at: new Date().toISOString(),
  });
}

async function sendReorderAlert(groups: Array<{ branchId: string; branchName?: string; items: string[] }>) {
  const nonEmpty = groups.filter((g) => g.items.length);
  if (!nonEmpty.length) return;
  if (nonEmpty.length === 1) {
    const g = nonEmpty[0];
    await sendLine(`🔔 แจ้งเตือนสั่งซื้อ - ${g.branchName ?? g.branchId}\nรายการที่ควรสั่งซื้อเพิ่ม (คงเหลือต่ำกว่าปกติ):\n` + g.items.map((n) => `- ${n}`).join("\n"));
    return;
  }
  const body = nonEmpty.map((g) => `${g.branchName ?? g.branchId}:\n` + g.items.map((n) => `- ${n}`).join("\n")).join("\n\n");
  await sendLine(`🔔 แจ้งเตือนสั่งซื้อ (ทุกสาขา)\n\n${body}`);
}

// Called after every successful check-in when reorder alerts are enabled. Tracks which
// categories have been checked "today" (Bangkok time) toward a complete round, accumulates
// low-stock items, and fires the configured trigger mode once a round completes. The
// 'schedule' trigger mode intentionally never fires from here — it needs a time-based
// Supabase cron job, which is separate infrastructure the admin sets up once, not code.
async function advanceReorderRound(
  branchId: string,
  category: string,
  flaggedItems: string[],
  reorderConfig: Record<string, unknown>,
) {
  const totalCategories = await getBranchCategoryCount(branchId);
  if (totalCategories === 0) return;

  const { data: existing } = await supabase.from("reorder_round_state").select("*").eq("branch_id", branchId).maybeSingle();
  const todayBkk = bangkokToday();
  const sameDay = existing?.tracking_date === todayBkk;
  let categoriesChecked: string[] = sameDay ? (existing?.categories_checked ?? []) : [];
  let pendingItems: string[] = existing?.pending_items ?? []; // accumulates across days until an alert actually sends
  let roundsSinceAlert: number = existing?.rounds_since_alert ?? 0;

  if (!categoriesChecked.includes(category)) categoriesChecked.push(category);
  for (const name of flaggedItems) if (!pendingItems.includes(name)) pendingItems.push(name);

  const roundComplete = categoriesChecked.length >= totalCategories;
  if (roundComplete) {
    roundsSinceAlert += 1;
    categoriesChecked = [];
  }

  const triggerMode = String(reorderConfig.triggerMode ?? "after_all_categories");
  const scopeMode = String(reorderConfig.scopeMode ?? "per_branch");
  const roundsTarget = Number(reorderConfig.roundsTarget ?? 3);
  const shouldFire = roundComplete && (
    triggerMode === "after_all_categories" ||
    (triggerMode === "after_n_rounds" && roundsSinceAlert >= roundsTarget)
  );

  if (!shouldFire) {
    await upsertReorderState(branchId, todayBkk, categoriesChecked, pendingItems, roundsSinceAlert, false);
    return;
  }

  if (scopeMode === "per_branch") {
    if (pendingItems.length) {
      const { data: b } = await supabase.from("branches").select("name").eq("id", branchId).maybeSingle();
      await sendReorderAlert([{ branchId, branchName: b?.name, items: pendingItems }]);
    }
    await upsertReorderState(branchId, todayBkk, categoriesChecked, [], 0, false);
    return;
  }

  // scopeMode === "combined": mark this branch ready and wait until every branch is ready
  // before sending one combined message — otherwise fast branches would alert long before
  // slower ones finish their first round of the day.
  await upsertReorderState(branchId, todayBkk, categoriesChecked, pendingItems, roundsSinceAlert, true);
  const { data: allBranches } = await supabase.from("branches").select("id, name");
  const { data: allStates } = await supabase.from("reorder_round_state").select("*");
  const stateByBranch = new Map((allStates ?? []).map((s: { branch_id: string }) => [s.branch_id, s]));
  const allReady = (allBranches ?? []).every((b: { id: string }) => {
    if (b.id === branchId) return true; // just marked ready above
    return !!(stateByBranch.get(b.id) as { ready_for_combined?: boolean } | undefined)?.ready_for_combined;
  });
  if (!allReady) return;

  const groups = (allBranches ?? []).map((b: { id: string; name: string }) => ({
    branchId: b.id,
    branchName: b.name,
    items: b.id === branchId ? pendingItems : ((stateByBranch.get(b.id) as { pending_items?: string[] } | undefined)?.pending_items ?? []),
  }));
  await sendReorderAlert(groups);
  for (const b of (allBranches ?? []) as Array<{ id: string }>) {
    await upsertReorderState(b.id, todayBkk, b.id === branchId ? categoriesChecked : ((stateByBranch.get(b.id) as { categories_checked?: string[] } | undefined)?.categories_checked ?? []), [], 0, false);
  }
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

// Admin dashboard: current qty per item (reusing the same RPC the reorder-alert system already
// relies on, so the numbers here always match what LINE alerts are based on) grouped by category,
// plus each category's most recent check date — not real-time (nothing cuts stock at sale time),
// same staleness as the LINE alerts, just viewable on demand instead of waiting for a push.
async function handleGetBranchOverview(p: Record<string, unknown>) {
  if (!(await checkAdminPassword(String(p.password ?? "")))) return json({ ok: false });
  const branchId = String(p.branch_id ?? "");
  if (!branchId) return json({ ok: false, error: "missing_branch_id" });

  const { data: levels, error } = await supabase.rpc("get_current_stock_levels", { p_branch_id: branchId });
  if (error) return json({ ok: false, error: error.message });

  const { data: checks } = await supabase
    .from("check_records").select("category, date").eq("branch_id", branchId).order("date", { ascending: false });
  const lastUpdatedByCategory = new Map<string, string>();
  for (const r of (checks ?? []) as Array<{ category: string; date: string }>) {
    if (!lastUpdatedByCategory.has(r.category)) lastUpdatedByCategory.set(r.category, r.date);
  }

  const byCategory = new Map<string, Array<{ name: string; qty: number | null; unit: string; hasBaseline: boolean }>>();
  for (const row of (levels ?? []) as Array<{ item_name: string; category: string; unit: string; qty: number; has_baseline: boolean }>) {
    if (!byCategory.has(row.category)) byCategory.set(row.category, []);
    byCategory.get(row.category)!.push({
      name: row.item_name, qty: row.has_baseline ? Number(row.qty) : null, unit: row.unit, hasBaseline: row.has_baseline,
    });
  }
  const categories = [...byCategory.entries()]
    .map(([category, items]) => ({
      category,
      itemCount: items.length,
      lastUpdated: lastUpdatedByCategory.get(category) ?? null,
      items: items.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
  return json({ ok: true, categories });
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
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    45000,
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
// Phase 4: purchase/expense sync from the external ledger Google Sheet
// ============================================================

const RAW_OCR_SHEET = "RAW_OCR";
const RAW_OCR_DATA_RANGE = `${RAW_OCR_SHEET}!A2:P`;
// 0-based column indexes within each RAW_OCR row:
// A slipDate, B fileId, C fileName, D itemName, E amount, F Main Category, G Subcategory,
// H qty, I rawItemLine, J rawPriceLine, K matchPreview, L pairStatus, M timestamp, N pushed,
// O (unlabeled review flag), P stockSynced
const COL = {
  slipDate: 0, itemName: 3, mainCategory: 5, subCategory: 6,
  qty: 7, pairStatus: 11, stockSynced: 15,
} as const;

// Deno's fetch has no default timeout — if Google's endpoints ever hang or drip data
// slowly, an un-timed-out fetch stalls forever, which (for a call inside a background
// job) leaves that job stuck at "pending" with no error ever surfacing. Every Google API
// call below goes through this instead of bare fetch().
async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 20000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw new Error(`request_timed_out_after_${timeoutMs}ms: ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function base64url(bytes: Uint8Array | string): string {
  const arr = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let cachedGoogleToken: { token: string; exp: number } | null = null;

// Exchanges the service-account key for a short-lived OAuth token (JWT bearer flow) —
// Deno's edge runtime has no googleapis SDK, so this talks to the token/Sheets REST
// endpoints directly, signing with Web Crypto instead of a Node crypto library.
async function getGoogleAccessToken(): Promise<string> {
  if (cachedGoogleToken && cachedGoogleToken.exp > Date.now() / 1000 + 60) return cachedGoogleToken.token;
  const raw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not configured");
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const signInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const pemBody = String(sa.private_key)
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", der.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signInput));
  const jwt = `${signInput}.${base64url(new Uint8Array(sig))}`;

  const res = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error_description || data?.error || `google_token_http_${res.status}`);
  cachedGoogleToken = { token: data.access_token, exp: now + (data.expires_in ?? 3600) };
  console.log("getGoogleAccessToken: obtained token, expires in", data.expires_in ?? 3600, "s");
  return data.access_token as string;
}

function purchaseSheetId(): string {
  const id = Deno.env.get("PURCHASE_SHEET_ID");
  if (!id) throw new Error("PURCHASE_SHEET_ID not configured");
  return id;
}

async function sheetsGetValues(range: string): Promise<string[][]> {
  const token = await getGoogleAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${purchaseSheetId()}/values/${encodeURIComponent(range)}`;
  console.log("sheetsGetValues: fetching", range);
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } }, 30000);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `sheets_get_http_${res.status}`);
  console.log("sheetsGetValues: got", (data.values ?? []).length, "rows");
  return data.values ?? [];
}

async function sheetsSetCell(range: string, value: string): Promise<void> {
  const token = await getGoogleAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${purchaseSheetId()}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const res = await fetchWithTimeout(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [[value]] }),
  }, 20000);
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data?.error?.message || `sheets_set_http_${res.status}`);
  }
}

// Ledger dates are written D/M/YYYY (e.g. "6/1/2026"); returns a comparable ISO date
// string, or null if it doesn't parse cleanly (OCR typos like "30/4/0206" land here).
function parseLedgerDate(s: string): string | null {
  const trimmed = s.trim();
  // D/M/YYYY or D-M-YYYY, optionally followed by a time component (e.g. "9/9/2026 14:30:00").
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s|$)/.exec(trimmed);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // Already ISO (YYYY-MM-DD), in case the sheet cell is a real date value Sheets rendered that way.
  const m2 = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s|$)/.exec(trimmed);
  if (m2) {
    const [, y, mo, d] = m2;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return null;
}

// Thai text pulled from the Google Sheet can carry a different Unicode normalization form
// (or a stray invisible character) than the literal string written in this source file, so a
// plain === comparison silently treats "the same word" as two different categories. Normalizing
// both sides to NFC before comparing/deduping fixes that without needing to touch the sheet data.
function normCat(s: string): string {
  return s.trim().normalize("NFC");
}

// The live ledger has real typo'd Main Category variants (e.g. "วัตถิบ" instead of
// "วัตถุดิบ") — a few characters short, not just a different Unicode encoding. Matching by this
// substring instead of the full word tolerates that without needing to know every misspelling.
const RAW_MATERIAL_HINT = "วัตถ";

function normalizeRawName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

async function createReceiveMovement(
  branchId: string, itemName: string, qty: number, unit: string | null, dateIso: string | null, note: string,
) {
  const { data: movement, error } = await supabase
    .from("stock_movements")
    .insert({ branch_id: branchId, checker_name: note, date: dateIso ?? new Date().toISOString(), line_text: null })
    .select()
    .single();
  if (error) throw new Error(error.message);
  await supabase.from("stock_movement_lines").insert({
    movement_id: movement.id, item_name: itemName, direction: "in", quantity: qty, unit,
  });
}

async function loadCatalog(branchId: string): Promise<Array<{ name: string; unit: string | null }>> {
  const { data: central } = await supabase.from("items").select("name, unit").is("branch_id", null).eq("active", true);
  const { data: branchItems } = await supabase.from("items").select("name, unit").eq("branch_id", branchId).eq("active", true);
  return [...(central ?? []), ...(branchItems ?? [])];
}

async function loadMatchMemory(): Promise<Map<string, string>> {
  const { data } = await supabase.from("purchase_match_memory").select("raw_name, item_name");
  return new Map((data ?? []).map((r) => [r.raw_name as string, r.item_name as string]));
}

function matchCatalogItem(
  catalog: Array<{ name: string; unit: string | null }>, memory: Map<string, string>, rawName: string,
): { name: string; unit: string | null } | null {
  const norm = normalizeRawName(rawName);
  const exact = catalog.find((it) => normalizeRawName(it.name) === norm);
  if (exact) return { name: exact.name, unit: exact.unit ?? null };
  const rememberedName = memory.get(norm);
  if (rememberedName) {
    const found = catalog.find((it) => it.name === rememberedName);
    if (found) return { name: found.name, unit: found.unit ?? null };
  }
  return null;
}

async function suggestCatalogMatch(rawName: string, catalogNames: string[]): Promise<string | null> {
  if (!catalogNames.length) return null;
  try {
    const prompt = `รายการนี้จากใบเสร็จ: "${rawName}"\n\nรายชื่อสินค้าที่มีอยู่ในระบบ:\n${catalogNames.join("\n")}\n\n` +
      `ตอบชื่อสินค้าที่ตรงกับรายการนี้มากที่สุดจากรายชื่อด้านบนเท่านั้น (คัดลอกชื่อมาตรงๆ ห้ามแก้) ` +
      `ถ้าไม่มีรายการไหนใกล้เคียงพอ ให้ตอบว่า null เท่านั้น ห้ามอธิบายเพิ่ม`;
    const text = await callGemini([{ text: prompt }]);
    const guess = text.trim().replace(/^"|"$/g, "");
    if (!guess || guess.toLowerCase() === "null") return null;
    return catalogNames.includes(guess) ? guess : null;
  } catch (e) {
    console.error("suggestCatalogMatch failed", e);
    return null;
  }
}

type PurchaseExcludeConfig = { excludeMain: string[]; excludeSub: string[] };

async function handleGetPurchaseExcludeSettings(p: Record<string, unknown>) {
  if (!(await checkAdminPassword(String(p.password ?? "")))) return json({ ok: false });
  let rows: string[][];
  try { rows = await sheetsGetValues(RAW_OCR_DATA_RANGE); }
  catch (e) { return json({ ok: false, error: String((e as Error)?.message ?? e) }); }

  const mainSet = new Set<string>();
  const subSet = new Set<string>();
  for (const row of rows) {
    const main = normCat(row[COL.mainCategory] ?? "");
    const sub = normCat(row[COL.subCategory] ?? "");
    if (main) mainSet.add(main);
    if (sub) subSet.add(sub);
  }
  const mainCategories = [...mainSet].sort();
  const subCategories = [...subSet].sort();

  const saved = await getSetting<PurchaseExcludeConfig | null>("purchase_exclude_config", null);
  // First-ever use: default to only "วัตถุดิบ"-ish (raw material) rows feeding stock —
  // everything else (utilities, labor, equipment, ...) starts excluded until the admin adjusts it.
  // Matched by substring, not exact equality — the live ledger has real typo'd variants
  // (e.g. "วัตถิบ") that an exact match would wrongly treat as a different category.
  const excludeMain = saved?.excludeMain ?? mainCategories.filter((c) => !c.includes(RAW_MATERIAL_HINT));
  const excludeSub = saved?.excludeSub ?? [];

  return json({ ok: true, mainCategories, subCategories, excludeMain, excludeSub });
}

async function handleSavePurchaseExcludeSettings(p: Record<string, unknown>) {
  if (!(await checkAdminPassword(String(p.password ?? "")))) return json({ ok: false });
  const excludeMain = String(p.exclude_main ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const excludeSub = String(p.exclude_sub ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const config: PurchaseExcludeConfig = { excludeMain, excludeSub };
  await setSetting("purchase_exclude_config", config);
  return json({ ok: true });
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Background execution via EdgeRuntime.waitUntil turned out not to reliably run to
// completion on this project's plan — jobs sat at status "pending" forever, with
// neither the success nor the error branch ever firing to update the row. So instead
// of doing the whole sync in one (possibly long) background task, this does it in small
// synchronous chunks: each call to previewPurchaseSync does a bounded amount of work
// (the full sheet scan + all fast auto-matches on the first call, then a handful of
// Gemini lookups per call after that) and returns immediately with done:true/false.
// The client just keeps calling it with the same jobId until done:true — every single
// call completes well within a normal request, so nothing needs to survive past the
// response.
type PurchaseSyncState = {
  autoMatched: Array<{ rowId: number; itemName: string; qty: number }>;
  needsReview: Array<{ rowId: number; rawName: string; qty: number; unit: string; slipDate: string; suggested: string | null }>;
  skippedCount: number;
  pendingRaw: Array<{ sheetRow: number; rawName: string; qty: number; slipDate: string }>;
  catalogNames: string[];
  debug?: Record<string, unknown>;
};

const PURCHASE_SYNC_BATCH_SIZE = 4;

async function initPurchaseSyncState(branchId: string, sinceDate: string): Promise<PurchaseSyncState> {
  const rows = await sheetsGetValues(RAW_OCR_DATA_RANGE);

  const config = await getSetting<PurchaseExcludeConfig | null>("purchase_exclude_config", null);
  // Same "only วัตถุดิบ by default" rule as handleGetPurchaseExcludeSettings — if the admin never
  // opened the exclude-settings panel and hit save, there's no saved config yet, and without this
  // the sync would otherwise pull in every category (utilities, labor, equipment, ...), not just
  // raw materials.
  let excludeMain: Set<string>;
  if (config?.excludeMain) {
    excludeMain = new Set(config.excludeMain.map(normCat));
  } else {
    const seenMain = new Set<string>();
    for (const row of rows) {
      const m = normCat(row[COL.mainCategory] ?? "");
      if (m) seenMain.add(m);
    }
    // Substring match, not exact equality — see handleGetPurchaseExcludeSettings for why.
    excludeMain = new Set([...seenMain].filter((c) => !c.includes(RAW_MATERIAL_HINT)));
  }
  const excludeSub = new Set((config?.excludeSub ?? []).map(normCat));

  const catalog = await loadCatalog(branchId);
  const memory = await loadMatchMemory();
  const catalogNames = catalog.map((it) => it.name);

  const autoMatched: PurchaseSyncState["autoMatched"] = [];
  let skippedCount = 0;
  const pendingRaw: PurchaseSyncState["pendingRaw"] = [];

  // Funnel counters — logged once at the end so a future "why did I get 0 rows" question can be
  // answered from the Edge Function logs instead of guessing which filter ate everything.
  let cPairStatus = 0, cCategory = 0, cQty = 0, cDate = 0, cUnparseableDate = 0;
  // Samples kept only for the debug payload — small raw snippets of whatever is tripping up a
  // filter, so a future "why 0 rows" doesn't need another deploy-and-screenshot round trip.
  const unparseableDateSamples: Array<{ sheetRow: number; raw: string }> = [];
  const nearMatchCategorySamples = new Map<string, { length: number; codePoints: string[] }>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const sheetRow = i + 2; // row 1 is the header
    const mainCategory = normCat(row[COL.mainCategory] ?? "");
    const subCategory = normCat(row[COL.subCategory] ?? "");
    const pairStatus = (row[COL.pairStatus] ?? "").trim();
    const stockSynced = (row[COL.stockSynced] ?? "").trim().toLowerCase();
    const qtyRaw = (row[COL.qty] ?? "").trim();
    const rawName = (row[COL.itemName] ?? "").trim();
    const slipDate = (row[COL.slipDate] ?? "").trim();

    if (mainCategory.includes("วัตถ") && !nearMatchCategorySamples.has(mainCategory)) {
      nearMatchCategorySamples.set(mainCategory, {
        length: mainCategory.length,
        codePoints: [...mainCategory].map((ch) => ch.codePointAt(0)!.toString(16)),
      });
    }

    if (!rawName || !pairStatus) continue; // not yet paired/confirmed in the chat flow
    cPairStatus++;
    if (mainCategory && excludeMain.has(mainCategory)) continue;
    if (subCategory && excludeSub.has(subCategory)) continue;
    cCategory++;
    // Most ledger rows only record the amount paid, not a count — an empty qty cell defaults to
    // 1 (one purchase event) rather than silently dropping the row. A cell that has *something*
    // in it but isn't a valid positive number is still treated as bad data and skipped.
    const qty = qtyRaw ? Number(qtyRaw) : 1;
    if (!Number.isFinite(qty) || qty <= 0) continue;
    cQty++;
    const isoDate = parseLedgerDate(slipDate);
    if (!isoDate) {
      cUnparseableDate++;
      if (unparseableDateSamples.length < 8) unparseableDateSamples.push({ sheetRow, raw: slipDate });
    }
    // A row whose date we can't parse at all is excluded rather than silently let through —
    // letting it through was the quiet default before and it's indistinguishable from "fine,
    // just old" once it's sitting in the review list.
    if (sinceDate && (!isoDate || isoDate < sinceDate)) continue;
    cDate++;

    if (stockSynced === "true") { skippedCount++; continue; }

    try {
      const match = matchCatalogItem(catalog, memory, rawName);
      if (match) {
        await createReceiveMovement(branchId, match.name, qty, match.unit, isoDate, "ระบบ (ซิงค์จากชีตบัญชี)");
        await sheetsSetCell(`${RAW_OCR_SHEET}!P${sheetRow}`, "TRUE");
        autoMatched.push({ rowId: sheetRow, itemName: match.name, qty });
      } else {
        pendingRaw.push({ sheetRow, rawName, qty, slipDate });
      }
    } catch (e) {
      console.error("initPurchaseSyncState row failed", sheetRow, e);
    }
  }

  const debug = {
    totalRows: rows.length, sinceDate, excludeMain: [...excludeMain],
    afterPairStatus: cPairStatus, afterCategory: cCategory, afterQty: cQty,
    afterDate: cDate, unparseableDates: cUnparseableDate,
    autoMatched: autoMatched.length, pendingRaw: pendingRaw.length, skipped: skippedCount,
    unparseableDateSamples,
    categorySamples: Object.fromEntries(nearMatchCategorySamples),
  };
  console.log("initPurchaseSyncState funnel:", debug);
  return { autoMatched, needsReview: [], skippedCount, pendingRaw, catalogNames, debug };
}

async function handlePreviewPurchaseSync(p: Record<string, unknown>) {
  if (!(await checkAdminPassword(String(p.password ?? "")))) return json({ ok: false });
  const jobId = String(p.jobId ?? "");
  if (!jobId) return json({ ok: false, error: "missing_jobId" });

  const { data: existing } = await supabase.from("purchase_sync_jobs").select("status, result").eq("job_id", jobId).maybeSingle();

  try {
    let state: PurchaseSyncState;
    let isFreshState = false;
    if (!existing) {
      const branchId = String(p.branch_id ?? "");
      const sinceDate = String(p.since_date ?? "");
      if (!branchId) return json({ ok: false, error: "missing_branch_id" });
      state = await initPurchaseSyncState(branchId, sinceDate);
      isFreshState = true;
      await supabase.from("purchase_sync_jobs").upsert({ job_id: jobId, status: "pending", result: state, error: null });
    } else if (existing.status === "done") {
      const r = existing.result as PurchaseSyncState;
      return json({ ok: true, done: true, autoMatched: r.autoMatched, needsReview: r.needsReview, skippedCount: r.skippedCount, debug: r.debug });
    } else {
      state = existing.result as PurchaseSyncState;
    }

    // Surface the funnel breakdown straight in the response on the call that computed it (visible
    // in the Network tab's Preview, which has been the one reliably reachable debugging view so
    // far) instead of only in Edge Function logs.
    const debug = isFreshState ? state.debug : undefined;

    if (!state.pendingRaw.length) {
      await supabase.from("purchase_sync_jobs").update({ status: "done" }).eq("job_id", jobId);
      return json({ ok: true, done: true, autoMatched: state.autoMatched, needsReview: state.needsReview, skippedCount: state.skippedCount, debug });
    }

    const batch = state.pendingRaw.slice(0, PURCHASE_SYNC_BATCH_SIZE);
    const rest = state.pendingRaw.slice(PURCHASE_SYNC_BATCH_SIZE);
    const suggestions = await mapWithConcurrency(batch, PURCHASE_SYNC_BATCH_SIZE, (r) => suggestCatalogMatch(r.rawName, state.catalogNames));
    const newlyReviewed = batch.map((r, idx) => ({
      rowId: r.sheetRow, rawName: r.rawName, qty: r.qty, unit: "", slipDate: r.slipDate, suggested: suggestions[idx],
    }));
    const nextState: PurchaseSyncState = { ...state, needsReview: [...state.needsReview, ...newlyReviewed], pendingRaw: rest };
    const done = rest.length === 0;
    await supabase.from("purchase_sync_jobs").update({ result: nextState, status: done ? "done" : "pending" }).eq("job_id", jobId);
    return json({
      ok: true, done,
      autoMatched: nextState.autoMatched, needsReview: nextState.needsReview, skippedCount: nextState.skippedCount,
      progress: { remaining: rest.length }, debug,
    });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await supabase.from("purchase_sync_jobs").update({ status: "error", error: msg }).eq("job_id", jobId);
    return json({ ok: false, error: msg });
  }
}

async function handleConfirmPurchaseMatch(p: Record<string, unknown>) {
  if (!(await checkAdminPassword(String(p.password ?? "")))) return json({ ok: false });
  const branchId = String(p.branch_id ?? "");
  const rowId = Number(p.row_id ?? 0);
  if (!branchId || !rowId) return json({ ok: false, error: "missing_params" });

  try {
    if (String(p.skip ?? "") === "true") {
      await sheetsSetCell(`${RAW_OCR_SHEET}!P${rowId}`, "TRUE");
      return json({ ok: true });
    }
    const itemName = String(p.item_name ?? "");
    if (!itemName) return json({ ok: false, error: "missing_item_name" });

    const rows = await sheetsGetValues(`${RAW_OCR_SHEET}!A${rowId}:P${rowId}`);
    const row = rows[0] ?? [];
    const rawName = (row[COL.itemName] ?? "").trim();
    const qty = Number((row[COL.qty] ?? "").trim());
    const slipDate = (row[COL.slipDate] ?? "").trim();
    const isoDate = parseLedgerDate(slipDate);
    if (!rawName || !Number.isFinite(qty) || qty <= 0) return json({ ok: false, error: "row_no_longer_valid" });

    const { data: item } = await supabase.from("items").select("unit").eq("name", itemName).eq("active", true).maybeSingle();
    await createReceiveMovement(branchId, itemName, qty, item?.unit ?? null, isoDate, "ระบบ (ซิงค์จากชีตบัญชี)");
    await sheetsSetCell(`${RAW_OCR_SHEET}!P${rowId}`, "TRUE");
    await supabase.from("purchase_match_memory")
      .upsert({ raw_name: normalizeRawName(rawName), item_name: itemName, updated_at: new Date().toISOString() });
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) });
  }
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
  getBranchCategories: handleGetBranchCategories,
  changeAdminPassword: handleChangeAdminPassword,
  listItems: handleListItems,
  listItemsAdmin: handleListItemsAdmin,
  saveItem: handleSaveItem,
  deleteItem: handleDeleteItem,
  deleteCategoryInScope: handleDeleteCategoryInScope,
  uploadItemImage: handleUploadItemImage,
  bulkSeedItems: handleBulkSeedItems,
  getBufferConfig: (p) => handleGetConfig(p, "buffer_config"),
  saveBufferConfig: (p) => handleSaveConfig(p, "buffer_config"),
  getUnitConfig: (p) => handleGetConfig(p, "unit_config"),
  saveUnitConfig: (p) => handleSaveConfig(p, "unit_config"),
  getReorderConfig: (p) => handleGetConfig(p, "reorder_config"),
  saveReorderConfig: (p) => handleSaveConfig(p, "reorder_config"),
  create: handleCreate,
  createMovement: handleCreateMovement,
  list: handleList,
  updateItemInRecord: handleUpdateItemInRecord,
  getCurrentStockLevels: handleGetCurrentStockLevels,
  getBranchOverview: handleGetBranchOverview,
  translateAll: handleTranslateAll,
  getDictionary: handleGetDictionary,
  translateNote: handleTranslateNote,
  parseItemsAI: handleParseItemsAI,
  getAiImportResult: handleGetAiImportResult,
  previewPurchaseSync: handlePreviewPurchaseSync,
  confirmPurchaseMatch: handleConfirmPurchaseMatch,
  getPurchaseExcludeSettings: handleGetPurchaseExcludeSettings,
  savePurchaseExcludeSettings: handleSavePurchaseExcludeSettings,
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
