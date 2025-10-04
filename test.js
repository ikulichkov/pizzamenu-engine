// test.js — Telegram-бот на Saby Presto
// ES-модули. Reply keyboard для верхних разделов. Inline — для позиций и навигации.
// Навигация по каталогам:
//  • Если в разделе нет товаров, но есть подпапки → автопроваливание в первую подпапку по заданному админом порядку.
//  • В конце списка товаров показываем навигационную строку: ← предыдущий | Назад | следующий →
//    - «Назад» ведёт на уровень родителя; если мы на верхнем уровне — не показываем «Назад» вовсе.
// Режим сортировки для супер-админа (tgId 674870519): /sort. Храним порядок и скрытость в Mongo.

import { DateTime } from 'luxon';
import {
    dbInit,
    dbGetAddresses,
    dbSaveAddress,
    dbSavePhone,
    dbLoadCart,
    dbSaveCart,
    dbLoadAllMenuOrders,
    dbSaveMenuOrder,
    generateStableUuid,
    normalizeCalendarIntervals
} from './bd.js';

// ====== КОНФИГ ======
const CLIENT_ID   = "0872375115278704";
const SECRET_KEY  = "UOAOFCJHX5VSEUHOYUJUUTDS";
const SERVICE_KEY = "LOc3JFMCazGkz3EaEtFcQV9FpEfodaDoDMGkTkFw6TROVtzWYApoPj37eJ1cVP5nS5xm8hlHJsq6e5YXee4MDsFCDyiVZ628lUi92oJn4WQWBKMrfdNmuW";

const AUTH_URL    = "https://online.sbis.ru/oauth/service/";
const API_BASE    = "https://api.sbis.ru";
const RETAIL_BASE = `${API_BASE}/retail`;

const BOT_API     = "7561802884:AAF8mh3OGofmDbnrVfDdYLeJrFT6j_aZf4s";

// ====== DEBUG ======
const DEBUG = 2;
const dbg  = (...a) => { if (DEBUG >= 1) console.log("[DBG]", ...a); };
const vdbg = (...a) => { if (DEBUG >= 2) console.log("[DBG2]", ...a); };
const short = (obj, max = 400) => { try { const s = JSON.stringify(obj); return s.length > max ? s.slice(0, max) + "…" : s; } catch { return String(obj); } };

// ====== МЕНЮ/ВИТРИНА ======
const FIXED_PRICE_LIST_ID = 64;               // Бар основной
const FIXED_PRICE_LIST_NAME = "Бар основной";
const DEFAULT_MENU_PAGE_SIZE = 12;
const ADMIN_ID = 674870519;

const SHOP_URL    = "https://pizza25.ru";
const SUCCESS_URL = "https://pizza25.ru/pay/success";
const ERROR_URL   = "https://pizza25.ru/pay/error";

// ====== СЛОТЫ ДОСТАВКИ ======
const BUSINESS_TZ    = 'Asia/Vladivostok';
const SLOT_OPEN_IDX  = 20;
const SLOT_CLOSE_IDX = 42;

// ====== TELEGRAM API ======
const TG_API = `https://api.telegram.org/bot${BOT_API}`;
let UPDATE_OFFSET = 0;

// ====== STATE ======
const STATE = new Map(); // chatId -> user session

// Глобальные контексты
const SABY = { token: null, sid: null };
let POINT_ID = null;
let PRICE_LISTS = [];
let CATALOG = null;

// Порядок категорий: Map<parentId|null, {order:string[], hidden:Set<string>}>
const CATEGORY_ORDER = new Map();

// ====== helpers ======
const encId = id => Buffer.from(String(id), "utf8").toString("base64url");
const decId = s  => { try { return Buffer.from(String(s), "base64url").toString("utf8"); } catch { return String(s); } };

function getState(chatId) {
    if (!STATE.has(chatId)) STATE.set(chatId, { cart: [], cartLoaded: false });
    const st = STATE.get(chatId);
    if (!Array.isArray(st.cart)) st.cart = [];
    if (typeof st.cartLoaded !== 'boolean') st.cartLoaded = false;
    if (!st.currentPriceListId) st.currentPriceListId = FIXED_PRICE_LIST_ID;
    if (!st.currentPriceListName) st.currentPriceListName = FIXED_PRICE_LIST_NAME;
    return st;
}
async function ensureCartLoaded(chatId) {
    const st = getState(chatId);
    if (st.cartLoaded) return st;
    try {
        const items = await dbLoadCart(chatId);
        if (Array.isArray(items) && items.length) {
            st.cart = items.map(x => ({ ...x, id: String(x.id) }));
        }
    } catch {}
    st.cartLoaded = true;
    return st;
}
function cartSummary(st, previewLimit = 3) {
    const total = st.cart.reduce((s, r) => s + r.cost * r.count, 0);
    const count = st.cart.reduce((s, r) => s + r.count, 0);
    const lines = st.cart.map(r => `• ${r.name} × ${r.count} = ${priceLabel(r.cost * r.count)}`);
    const preview = lines.slice(0, previewLimit);
    if (lines.length > previewLimit) preview.push(`… ещё ${lines.length - previewLimit}`);
    return { total, count, lines, preview };
}
const priceLabel = v => `${(Number(v) || 0).toFixed(0)} ₽`;

const rk = rows => ({ reply_markup: JSON.stringify({ keyboard: rows, resize_keyboard: true, one_time_keyboard: false }) });
const ik = rows => ({ reply_markup: JSON.stringify({ inline_keyboard: rows }) });

function toLocalPrestoDate(dateStr, halfHourIndex) {
    const idx = Number(halfHourIndex);
    const base = 30 + (Number.isInteger(idx) ? idx * 30 : 0);
    const h = Math.floor(base / 60), m = base % 60;
    return `${dateStr} ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
}
function slotLabel(halfHourIndex) {
    const idx = Number(halfHourIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx > 47) return "—";
    const startMinutes = 30 + idx * 30;
    const h = Math.floor(startMinutes / 60);
    const m = startMinutes % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function normalizePhone(s) {
    if (!s) return null;
    let p = String(s).replace(/[^\d+]/g, "");
    if (/^8\d{10}$/.test(p)) return `+7${p.slice(1)}`;
    if (/^\+7\d{10}$/.test(p)) return p;
    if (/^7\d{10}$/.test(p)) return `+${p}`;
    return null;
}

// ====== SABY CALLS ======
async function sabyAuth() {
    const res = await fetch(AUTH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8", "Accept": "application/json" },
        body: JSON.stringify({ app_client_id: CLIENT_ID, app_secret: SECRET_KEY, secret_key: SERVICE_KEY })
    });
    if (!res.ok) throw new Error(`Saby auth failed: ${res.status}`);
    const data = await res.json();
    SABY.token = data.token; SABY.sid = data.sid;
}
function sabyHeaders() {
    const h = { "X-SBISAccessToken": SABY.token };
    if (SABY.sid) h["Cookie"] = `sid=${SABY.sid}`;
    return h;
}
async function sabyFetch(url, opts = {}) {
    const finalUrl = url instanceof URL ? url.toString() : String(url);
    const res = await fetch(finalUrl, {
        method: opts.method || "GET",
        headers: { "Accept": "application/json", ...(opts.headers || {}), ...sabyHeaders() },
        body: opts.body
    });

    if (res.status === 401) {
        await sabyAuth();
        return sabyFetch(url, opts);
    }

    const text = await res.text().catch(() => "");
    if (!res.ok) {
        throw new Error(`${finalUrl} → ${res.status} ${text}`);
    }

    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (data && typeof data === "object" && data.error) {
        throw new Error(`${finalUrl} → RPC error ${short(data.error)}`);
    }
    return data;
}
async function sabyGetPoints() { return sabyFetch(`${RETAIL_BASE}/point/list`); }
async function sabyGetPriceLists(pointId, actualDate = new Date()) {
    const url = new URL(`${RETAIL_BASE}/nomenclature/price-list`);
    url.searchParams.set("pointId", String(pointId));
    url.searchParams.set("actualDate", `${actualDate.toLocaleDateString("ru-RU")} ${actualDate.toLocaleTimeString("ru-RU")}`);
    url.searchParams.set("pageSize", "1000");
    return sabyFetch(url);
}
async function sabyGetNomenclature(pointId, priceListId, page = 0, pageSize = 1000) {
    const url = new URL(`${RETAIL_BASE}/nomenclature/list`);
    url.searchParams.set("pointId", String(pointId));
    url.searchParams.set("priceListId", String(priceListId));
    url.searchParams.set("page", String(page));
    url.searchParams.set("pageSize", String(pageSize));
    return sabyFetch(url);
}
async function sabySuggestedAddress(addressLine) {
    const url = new URL(`${RETAIL_BASE}/delivery/suggested-address`);
    url.searchParams.set("address", addressLine);
    return sabyFetch(url);
}
async function sabyDeliveryCost(pointId, addressJSONorString) {
    const url = new URL(`${RETAIL_BASE}/delivery/cost`);
    url.searchParams.set("pointId", String(pointId));
    url.searchParams.set("address", typeof addressJSONorString === "string" ? addressJSONorString : JSON.stringify(addressJSONorString));
    return sabyFetch(url);
}
async function sabyDeliveryCalendar(pointId, page = 0, pageSize = 7) {
    const url = new URL(`${RETAIL_BASE}/delivery/calendar`);
    url.searchParams.set("pointId", String(pointId));
    url.searchParams.set("page", String(page));
    url.searchParams.set("pageSize", String(pageSize));
    return sabyFetch(url);
}
async function sabyCreateOrder(payload) {
    return sabyFetch(`${RETAIL_BASE}/order/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload)
    });
}
async function sabyPaymentLink(externalId, { shopURL, successURL, errorURL } = { shopURL: SHOP_URL, successURL: SUCCESS_URL, errorURL: ERROR_URL }) {
    const ext = String(externalId);
    const url = new URL(`${RETAIL_BASE}/order/${encodeURIComponent(ext)}/payment-link`);
    url.searchParams.set("externalId", ext);
    url.searchParams.set("shopURL", shopURL);
    if (successURL) url.searchParams.set("successURL", successURL);
    if (errorURL)   url.searchParams.set("errorURL", errorURL);

    const data = await sabyFetch(url, { method: "GET" });
    if (!data || typeof data.link !== "string" || !data.link) {
        throw new Error(`payment-link: неожиданный ответ ${short(data)}`);
    }
    return data; // { link }
}
async function sabyOrderState(externalId) {
    const ext = encodeURIComponent(String(externalId));
    const url = `${RETAIL_BASE}/order/${ext}/state`;
    try {
        return await sabyFetch(url);
    } catch (e) {
        const info = await sabyOrderInfo(externalId).catch(() => null);
        if (!info) throw e;
        const out = { state: Number(info?.state ?? info?.orderState ?? info?.status ?? NaN) };
        if (Array.isArray(info?.payments)) out.payments = info.payments;
        return out;
    }
}
async function sabyOrderInfo(externalId) {
    const ext = encodeURIComponent(String(externalId));
    return sabyFetch(`${RETAIL_BASE}/order/${ext}`);
}
async function sabyRegisterPayment(externalId, {
    cashSum = 0, bankSum = 0, salarySum = 0,
    retailPlace = SHOP_URL, paymentType = "full", nonFiscal = false
} = {}) {
    const ext = encodeURIComponent(String(externalId));
    const url = new URL(`${RETAIL_BASE}/order/${ext}/register-payment`);
    url.searchParams.set("cashSum", String(cashSum));
    url.searchParams.set("bankSum", String(bankSum));
    url.searchParams.set("salarySum", String(salarySum));
    url.searchParams.set("retailPlace", retailPlace);
    url.searchParams.set("paymentType", paymentType);
    if (nonFiscal) url.searchParams.set("nonFiscal", "true");
    return sabyFetch(url, { method: "GET" });
}
async function sabyCancelOrder(externalId) {
    const ext = encodeURIComponent(String(externalId));
    return sabyFetch(`${RETAIL_BASE}/order/${ext}/cancel`, { method: "PUT" });
}

// ====== КАТАЛОГ ======
function hasAnySeparator(s) { return /[./\\-]/.test(s || ""); }
function normHierId(h) { if (h == null) return null; const s = String(h); return s.replace(/[\/\\\-]+/g, ".").replace(/\.+/g, ".").replace(/^\.+|\.+$/g, ""); }
function splitHierId(h) { const n = normHierId(h); return n ? n.split(".").filter(Boolean) : []; }

function guessSegmentSize(rawHierList) {
    const clean = rawHierList.map(x => String(x || "").trim()).filter(Boolean);
    if (!clean.length) return null;
    if (clean.some(hasAnySeparator)) return null;
    let bestS = null, bestScore = -1;
    for (let s = 2; s <= 6; s++) {
        let parentCounts = Object.create(null);
        let depthSum = 0, depthCnt = 0;
        for (const h of clean) {
            const depth = Math.floor(h.length / s);
            if (depth >= 2) {
                depthSum += depth; depthCnt++;
                const parent = h.slice(0, (depth - 1) * s);
                parentCounts[parent] = (parentCounts[parent] || 0) + 1;
            }
        }
        const multiParents = Object.values(parentCounts).filter(x => x >= 2).length;
        const avgDepth = depthCnt ? depthSum / depthCnt : 0;
        const score = multiParents * 10 + avgDepth;
        if (score > bestScore) { bestScore = score; bestS = multiParents ? s : bestS; }
    }
    return bestS;
}

// ====== ДИАГНОСТИКА НОМЕНКЛАТУРЫ/КАТАЛОГА ======
function catDbg(...a){ if (DEBUG>=1) console.log("[CAT]", ...a); }
function catVDbg(...a){ if (DEBUG>=2) console.log("[CAT2]", ...a); }

function analyzeRawNomenclature(records) {
    const stats = {
        total: records.length,
        withId: 0, withoutId: 0,
        priceNum: 0, noPrice: 0,
        withImages: 0,
        hierWithSep: 0, hierNoSep: 0, hierNull: 0,
        parentRawPresent: 0,
        typeHintsFolder: 0
    };
    const sampleFields = new Set();
    const typesSet = new Set();

    for (const x of records) {
        const id = x.id ?? x.externalId ?? x.nomNumber ?? x.nomenclatureId ?? x.key ?? null;
        if (id==null) stats.withoutId++; else stats.withId++;

        const costNum = Number(x.cost ?? x.price ?? x.priceWithDiscount ?? x.amount);
        if (Number.isFinite(costNum)) stats.priceNum++; else stats.noPrice++;

        if (Array.isArray(x.images) && x.images.length) stats.withImages++;

        const hierRaw = x.hierarchicalId ?? x.hierarchyId ?? x.hid ?? x.path ?? null;
        if (hierRaw==null) stats.hierNull++;
        else if (/[./\\-]/.test(String(hierRaw))) stats.hierWithSep++;
        else stats.hierNoSep++;

        if (x.hierarchicalParent!=null) stats.parentRawPresent++;

        const typeStr = String(x.type ?? x.nomenclatureType ?? "").toLowerCase();
        if (/(group|folder|category)/.test(typeStr) || x.isParent || x.isGroup || x.isFolder || x.isCategory || x.hasChildren || (x.childrenCount>0)) {
            stats.typeHintsFolder++;
        }
        Object.keys(x).forEach(k => sampleFields.add(k));
        if (typeStr) typesSet.add(typeStr);
    }
    return { stats, sampleFields: [...sampleFields].slice(0,30), types: [...typesSet].slice(0,20) };
}

function dumpTreePreview(CATALOG, maxFolders=12, maxItemsPerFolder=5) {
    const root = CATALOG.ROOT;
    const roots = (CATALOG.foldersByParent.get(root)||[]).slice(0, maxFolders);
    const lines = [];
    lines.push(`ROOT folders: ${ (CATALOG.foldersByParent.get(root)||[]).length }, items: ${ (CATALOG.itemsByParent.get(root)||[]).length }`);
    for (const fid of roots) {
        const name = CATALOG.byId.get(fid)?.name || "Каталог";
        const subF = (CATALOG.foldersByParent.get(fid)||[]).length;
        const subI = (CATALOG.itemsByParent.get(fid)||[]).length;
        lines.push(`• ${name} — папок: ${subF}, товаров: ${subI}`);
        const samp = (CATALOG.itemsByParent.get(fid)||[]).slice(0, maxItemsPerFolder);
        for (const iid of samp) {
            const it = CATALOG.byId.get(iid);
            lines.push(`   - ${it?.name || it?.id} • ${Number.isFinite(it?.cost)? `${(it.cost).toFixed(0)} ₽`: "—"}`);
        }
    }
    return lines.join("\n");
}

// ====== Инструментированная сборка индексов каталога ======
function buildCatalogIndexes(records) {
    const { stats:rawStats, sampleFields, types } = analyzeRawNomenclature(records);
    catDbg("[raw] total:", rawStats.total, "| ids:", rawStats.withId, "/", rawStats.total, "| price:", rawStats.priceNum, "/", rawStats.total);
    catVDbg("[raw] fields:", sampleFields.join(", "));
    catVDbg("[raw] type strings sample:", types.join(", "));

    const prepared = records.map((x, idx) => {
        const name = x.name ?? x.title ?? x.caption ?? "Позиция";
        const costNum = Number(x.cost ?? x.price ?? x.priceWithDiscount ?? x.amount);
        const hasCost = Number.isFinite(costNum);
        const hierRaw = x.hierarchicalId ?? x.hierarchyId ?? x.hid ?? x.path ?? null;
        const hierParentRaw = x.hierarchicalParent ?? null;
        const indexNumber = Number.isFinite(Number(x.indexNumber)) ? Number(x.indexNumber) : null;
        const idCandidate = x.id ?? x.externalId ?? x.nomNumber ?? x.nomenclatureId ?? x.key ?? null;
        const id = idCandidate != null ? String(idCandidate) : null;

        const typeStr = String(x.type ?? x.nomenclatureType ?? "").toLowerCase();
        const isFolderFlag = !!(x.isParent || x.isGroup || x.isFolder || x.isCategory || x.hasChildren || x.childrenCount > 0
            || /(group|folder|category)/.test(typeStr) || !hasCost);

        return {
            raw: x, id, name,
            hasCost, costNum,
            hierRaw, hierParentRaw,
            orderIdx: indexNumber ?? idx,
            isFolder: isFolderFlag,
            images: Array.isArray(x.images) ? x.images.map(q => `https://api.sbis.ru/retail${q}`) : []
        };
    });

    // Сегментация (если нет разделителей)
    const rawHiers = prepared.map(p => p.hierRaw).filter(Boolean);
    const forcedSeg = Number(process.env.FORCE_SEGMENT_SIZE || NaN);
    const guessedSeg = Number.isInteger(forcedSeg) ? forcedSeg : guessSegmentSize(rawHiers);
    catDbg(`[seg] FORCE=${Number.isInteger(forcedSeg)? forcedSeg : "—"}, guessed=${guessedSeg || "—"}`);

    for (const p of prepared) {
        let hierNorm = normHierId(p.hierRaw);
        if (guessedSeg && hierNorm && !/[./\\-]/.test(hierNorm)) {
            const parts = []; const s = String(hierNorm); for (let i = 0; i < s.length; i += guessedSeg) parts.push(s.slice(i, i + guessedSeg));
            hierNorm = parts.join(".");
        }
        p.hierNorm = hierNorm;
    }

    const ROOT = null;
    const byId = new Map();
    const parentById = new Map();
    const foldersByParent = new Map();
    const itemsByParent = new Map();
    const folderIdByExactPath = new Map();
    const folderIdByHierRaw  = new Map();

    function ensureFolder(node) { byId.set(node.id, node); }
    function push(map, key, val) { const arr = map.get(key) || []; arr.push(val); map.set(key, arr); }

    const path2ids = new Map(); // для ловли конфликтов

    // Папки
    for (const p of prepared.filter(p => p.isFolder)) {
        let id = p.id;
        if (!id) {
            const norm = p.hierNorm ?? String(p.hierRaw ?? "");
            if (!norm) continue; // папка без id и пути — пропуск
            id = `__cat__:${norm}`;
        }
        id = String(id);
        const node = { id, name: p.name, cost: NaN, images: p.images, hier: p.hierNorm, folder: true, raw: p.raw, orderIdx: p.orderIdx };
        ensureFolder(node);

        if (p.hierNorm) {
            folderIdByExactPath.set(p.hierNorm, id);
            const arr = path2ids.get(p.hierNorm) || [];
            arr.push(id); path2ids.set(p.hierNorm, arr);
        }
        if (p.hierRaw  != null) folderIdByHierRaw.set(String(p.hierRaw), id);

        let pid = null;
        if (p.hierParentRaw != null) pid = folderIdByHierRaw.get(String(p.hierParentRaw)) ?? null;
        if (!pid && p.hierNorm) {
            const parts = splitHierId(p.hierNorm);
            pid = parts.length > 1 ? folderIdByExactPath.get(parts.slice(0, -1).join(".")) ?? ROOT : ROOT;
        }
        parentById.set(id, pid ?? ROOT);
    }

    // Товары
    for (const p of prepared.filter(p => !p.isFolder)) {
        if (!p.id) continue; // товар без id — пропуск
        const node = { id: String(p.id), name: p.name, cost: p.hasCost ? p.costNum : NaN, images: p.images, hier: p.hierNorm, folder: false, raw: p.raw, orderIdx: p.orderIdx };
        byId.set(node.id, node);

        let pid = null;
        if (p.hierParentRaw != null) pid = folderIdByHierRaw.get(String(p.hierParentRaw)) ?? null;
        if (!pid && p.hierNorm) {
            const parts = splitHierId(p.hierNorm);
            if (parts.length) {
                const exact = folderIdByExactPath.get(parts.join("."));
                pid = exact ?? (parts.length > 1 ? folderIdByExactPath.get(parts.slice(0, -1).join(".")) ?? ROOT : ROOT);
            }
        }
        parentById.set(node.id, pid ?? ROOT);
    }

    // Списки по родителям
    for (const [id, pid] of parentById.entries()) {
        const n = byId.get(id); if (!n) continue;
        if (n.folder) push(foldersByParent, pid ?? ROOT, id);
        else          push(itemsByParent,   pid ?? ROOT, id);
    }

    // Сортировка
    const ord = id => byId.get(id)?.orderIdx ?? Number.MAX_SAFE_INTEGER;
    const nameOf = id => (byId.get(id)?.name || "").toString().toLowerCase();
    for (const [k, arr] of foldersByParent.entries()) arr.sort((a, b) => (ord(a) - ord(b)) || nameOf(a).localeCompare(nameOf(b)));
    for (const [k, arr] of itemsByParent.entries())   arr.sort((a, b) => (ord(a) - ord(b)) || nameOf(a).localeCompare(nameOf(b)));

    // ===== Проверки & отчёт =====
    // Конфликты путей (несколько ид для одного и того же path)
    const pathConflicts = [...path2ids.entries()].filter(([, ids]) => ids.length > 1);
    if (pathConflicts.length) {
        catDbg(`[conflict] ${pathConflicts.length} конфликт(а) path->ids`);
        for (const [p, ids] of pathConflicts.slice(0, 10)) catVDbg("  path", p, "ids", ids);
    }

    // Осиротевшие элементы
    let orphans = 0;
    for (const [id, pid] of parentById.entries()) {
        const node = byId.get(id);
        if (!node) continue;
        if (node.hier) {
            const depth = splitHierId(node.hier).length;
            if (depth > 1 && (pid === ROOT || pid == null)) {
                orphans++;
                if (orphans <= 15) catVDbg("[orphan]", node.folder? "folder":"item", id, node.name, "hier:", node.hier);
            }
        }
    }
    if (orphans) catDbg(`[orphans] найдено проблем: ${orphans}`);

    // Сводка
    const foldersCnt = [...byId.values()].filter(n => n.folder).length;
    const itemsCnt   = [...byId.values()].filter(n => !n.folder).length;
    catDbg(`[built] nodes: ${foldersCnt} папок + ${itemsCnt} товаров`);
    catVDbg("\n" + dumpTreePreview({byId, parentById, foldersByParent, itemsByParent, ROOT}));

    return { byId, parentById, foldersByParent, itemsByParent, ROOT };
}

// ====== Порядок категорий ======
function loadOrdersToMap(ordersArr) {
    CATEGORY_ORDER.clear();
    for (const doc of ordersArr) {
        const pid = doc.parentId == null ? null : String(doc.parentId);
        const order = Array.isArray(doc.orderedIds) ? doc.orderedIds.map(String) : [];
        const hidden = new Set(Array.isArray(doc.hiddenIds) ? doc.hiddenIds.map(String) : []);
        CATEGORY_ORDER.set(pid, { order, hidden });
    }
}
// для пользователей: порядок + фильтр скрытых
function applyOrder(ids, parentId) {
    const cfg = CATEGORY_ORDER.get(parentId == null ? null : String(parentId));
    if (!cfg) return ids.slice();
    const { order, hidden } = cfg;
    const set = new Set(ids.map(String));
    const inOrder = order.filter(id => set.has(String(id)));
    const leftovers = ids.filter(id => !inOrder.includes(String(id)));
    const res = [...inOrder, ...leftovers];
    return res.filter(id => !hidden.has(String(id)));
}
// для UI сортировки: порядок без фильтра скрытых
function getOrderedAll(idsBase, parentId) {
    const cfg = CATEGORY_ORDER.get(parentId == null ? null : String(parentId));
    if (!cfg) return idsBase.slice();
    const { order } = cfg;
    const set = new Set(idsBase.map(String));
    const inOrder = order.filter(id => set.has(String(id)));
    const leftovers = idsBase.filter(id => !inOrder.includes(String(id)));
    return [...inOrder, ...leftovers];
}
async function saveOrder(parentId, orderedIds) {
    const pid = parentId == null ? null : String(parentId);
    const prev = CATEGORY_ORDER.get(pid) || { order: [], hidden: new Set() };
    const hiddenArr = [...prev.hidden];
    await dbSaveMenuOrder(pid, orderedIds.map(String), hiddenArr);
    CATEGORY_ORDER.set(pid, { order: orderedIds.map(String), hidden: new Set(hiddenArr) });
}

// ====== TELEGRAM API ======
async function tg(method, payload) {
    const res = await fetch(`${TG_API}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`TG ${method} failed: ${res.status} ${t}`);
    }
    return res.json();
}
const __ACKED = new Set();
async function answerCbSafe(cb, text = null, showAlert = false) {
    if (!cb || !cb.id || __ACKED.has(cb.id)) return;
    try {
        const payload = { callback_query_id: cb.id };
        if (text) payload.text = text;
        if (showAlert) payload.show_alert = true;
        await tg("answerCallbackQuery", payload);
    } catch {
    } finally {
        __ACKED.add(cb.id);
    }
}

// ====== UI построители ======
function buildMainCategories() {
    const root = CATALOG.ROOT;
    const base = (CATALOG.foldersByParent.get(root) || []).slice();
    const ordered = applyOrder(base, null);
    return ordered.map(fid => {
        const n = CATALOG.byId.get(fid);
        return { id: fid, name: n?.name || "Каталог" };
    });
}
function buildMainReplyKeyboard(mainCategories) {
    const rows = [];
    let buf = [];
    for (const cat of mainCategories) {
        buf.push({ text: cat.name });
        if (buf.length === 3) { rows.push(buf); buf = []; }
    }
    if (buf.length) rows.push(buf);
    rows.push([{ text: "📋 Меню" }, { text: "🧺 Корзина" }, { text: "🚚 Доставка" }]);
    return rk(rows);
}
function siblingNavRow(currentFolderId) {
    const parentId = CATALOG.parentById.get(currentFolderId) ?? CATALOG.ROOT;

    const siblingsBase = (CATALOG.foldersByParent.get(parentId) || []).slice();
    const siblings = applyOrder(siblingsBase, parentId == null ? null : parentId);
    const idx = siblings.findIndex(x => String(x) === String(currentFolderId));
    if (idx < 0) return null;

    const prev = idx > 0 ? siblings[idx - 1] : null;
    const next = idx < siblings.length - 1 ? siblings[idx + 1] : null;

    const row = [];

    if (prev) {
        row.push({
            text: `← ${CATALOG.byId.get(prev)?.name || "Предыдущий"}`,
            callback_data: `cat:${encId(prev)}:0`
        });
    }

    // Центральная кнопка «назад» — с названием родителя
    const parentItems = CATALOG.itemsByParent.get(parentId);
    const hasItemsInParent = Array.isArray(parentItems) && parentItems.length > 0;

    if (parentId != null && hasItemsInParent) {
        const parentName = (CATALOG.byId.get(parentId)?.name || "").trim();
        const shortName = parentName.length > 6 ? parentName.slice(0, 6) + "…" : parentName;
        const backLabel = shortName ? `⇦ ${shortName}` : "⇦ Назад";

        row.push({
            text: backLabel,
            callback_data: `back:${encId(parentId)}`
        });
    }

    if (next) {
        row.push({
            text: `${CATALOG.byId.get(next)?.name || "Следующий"} →`,
            callback_data: `cat:${encId(next)}:0`
        });
    }

    return row.length ? row : null;
}

// ====== ТОВАРЫ/МЕНЮ ======
async function addToCart(chatId, itemId) {
    await ensureCartLoaded(chatId);

    const key = String(itemId);
    const node = CATALOG?.byId?.get(key);
    if (!node || node.folder) return { added: false };

    const st = getState(chatId);
    const cost = Number.isFinite(node.cost) ? node.cost : 0;
    const row = st.cart.find(r => String(r.id) === key);

    if (row) row.count += 1;
    else st.cart.push({ id: key, name: node.name, cost, count: 1 });

    await dbSaveCart(chatId, st.cart).catch(() => {});
    const sum = cartSummary(st);
    return { added: true, name: node.name, total: sum.total, count: sum.count };
}
async function changeCartQty(chatId, itemId, delta) {
    const st = await ensureCartLoaded(chatId);
    const idx = st.cart.findIndex(r => String(r.id) === String(itemId));
    if (idx < 0) return;
    st.cart[idx].count = Math.max(1, Number(st.cart[idx].count || 1) + delta);
    await dbSaveCart(chatId, st.cart).catch(() => {});
}
async function deleteCartItem(chatId, itemId) {
    const st = await ensureCartLoaded(chatId);
    const before = st.cart.length;
    st.cart = st.cart.filter(r => String(r.id) !== String(itemId));
    if (st.cart.length !== before) await dbSaveCart(chatId, st.cart).catch(() => {});
}
async function showCart(chatId) {
    const st = await ensureCartLoaded(chatId);
    if (!st.cart.length) {
        await tg("sendMessage", { chat_id: chatId, text: "Корзина пуста." });
        return;
    }

    const total = st.cart.reduce((s, r) => s + r.cost * r.count, 0);
    const rows = st.cart.map(r => ([
        { text: "−",                     callback_data: `cart:dec:${r.id}` },
        { text: `${r.name} ×${r.count}`, callback_data: "noop" },
        { text: "+",                     callback_data: `cart:inc:${r.id}` },
        { text: "✖",                     callback_data: `cart:del:${r.id}` }
    ]));
    rows.push([{ text: "Очистить", callback_data: "cart:clear" }, { text: "🚚 Оформить доставку", callback_data: "order:start" }]);

    await tg("sendMessage", {
        chat_id: chatId,
        text: `🧺 Корзина:\n${st.cart.map(r => `• ${r.name} × ${r.count} = ${priceLabel(r.cost * r.count)}`).join("\n")}\n\nИтого: ${priceLabel(total)}`,
        ...ik(rows)
    });
}

// Показываем содержимое каталога: если нет товаров и есть подпапки — автопроваливание
async function sendCategoryItems(chatId, catId, page = 0) {
    const st = getState(chatId);
    st.catId = catId ?? null;

    const parentKey = catId ?? CATALOG.ROOT;
    const foldersIdsBase = CATALOG.foldersByParent.get(parentKey) || [];
    const foldersIds = applyOrder(foldersIdsBase, catId ?? null);
    const itemsIdsAll = CATALOG.itemsByParent.get(parentKey) || [];

    // Автопроваливание
    if (!itemsIdsAll.length && foldersIds.length) {
        const first = foldersIds[0];
        await sendCategoryItems(chatId, first, 0);
        return;
    }

    const pageSize = DEFAULT_MENU_PAGE_SIZE;
    const start = page * pageSize;
    const itemsIds = itemsIdsAll.slice(start, start + pageSize);

    const rows = [];

    // Сначала подпапки (если есть и товары, и папки)
    if (foldersIds.length && itemsIdsAll.length) {
        for (const fid of foldersIds) {
            const f = CATALOG.byId.get(fid);
            rows.push([{ text: `📂 ${f?.name || "Каталог"}`, callback_data: `cat:${encId(fid)}:0` }]);
        }
    }

    // Товары
    for (const iid of itemsIds) {
        const it = CATALOG.byId.get(iid);
        const price = Number.isFinite(it.cost) ? priceLabel(it.cost) : "—";
        rows.push([{ text: `${it.name} • ${price}`, callback_data: `add:${it.id}` }]);
    }

    // Пагинация (числовая, максимум 5 кнопок)
    const totalPages = Math.ceil(itemsIdsAll.length / pageSize);
    if (totalPages > 1) {
        const navRow = [];
        const currentPage = page;

        const range = [];
        for (let i = currentPage - 2; i <= currentPage + 2; i++) {
            if (i >= 0 && i < totalPages) range.push(i);
        }

        for (const p of range) {
            const isCurrent = p === currentPage;
            const text = isCurrent ? `👁 ${p + 1}` : `${p + 1}`;
            navRow.push({ text, callback_data: `ipage:${encId(catId ?? "root")}:${p}` });
        }

        rows.push(navRow);
    }

    // Навигация по соседям / Назад
    if (catId != null) {
        const srow = siblingNavRow(catId);
        if (srow) rows.push(srow);
    }

    // Корзина и оформление
    const cs = cartSummary(st);
    rows.push([
        { text: `🧺 Корзина (${cs.count} | ${priceLabel(cs.total)})`, callback_data: "cart:show" },
        { text: "🚚 Оформить доставку", callback_data: "order:start" }
    ]);

    // Заголовок
    const title = catId === null
        ? `Меню: ${st.currentPriceListName || ""}`
        : `Меню: ${st.currentPriceListName || ""} / ${CATALOG.byId.get(catId)?.name || ""}`;

    // Подвал с корзиной
    const footer = cs.count
        ? `\n\n🧺 Сейчас в корзине: ${cs.count} • Итого: ${priceLabel(cs.total)}\n${cs.preview.join("\n")}`
        : `\n\n🧺 Корзина пуста`;

    await tg("sendMessage", {
        chat_id: chatId,
        text: title + footer,
        ...ik(rows)
    });
}

// ====== ОФОРМЛЕНИЕ, АДРЕСА, СЛОТЫ, ОПЛАТА ======
async function askAddress(chatId) {
    const st = getState(chatId);
    st.flow = "address_wait";

    let rows = [];
    try {
        const prev = await dbGetAddresses(chatId, 6);
        if (prev.length) {
            st.addrPrev = prev;
            for (let i = 0; i < prev.length; i++) rows.push([{ text: prev[i].addressFull, callback_data: `addrprev:${i}` }]);
            rows.push([{ text: "➕ Ввести новый адрес", callback_data: "addr:new" }]);
            await tg("sendMessage", { chat_id: chatId, text: "Выбери один из сохранённых адресов или введи новый:", ...ik(rows) });
            return;
        }
    } catch {}

    await tg("sendMessage", { chat_id: chatId, text: "Введи адрес в формате: город, улица, дом (кв/подъезд/этаж можно потом)." });
}
async function handleAddressInput(chatId, text) {
    const st = getState(chatId);
    const sug = await sabySuggestedAddress(text);
    const list = Array.isArray(sug?.addresses) ? sug.addresses.slice(0, 10) : [];
    if (!list.length) {
        await tg("sendMessage", { chat_id: chatId, text: "Не нашла похожих адресов. Введи точнее." });
        return;
    }
    st.addrOptions = list;
    const rows = list.map((a, i) => [{ text: a.addressFull, callback_data: `addrpick:${i}` }]);
    await tg("sendMessage", { chat_id: chatId, text: "Выбери адрес:", ...ik(rows) });
}
async function afterAddressPicked(chatId) {
    const st = getState(chatId);
    const cost = await sabyDeliveryCost(POINT_ID, st.addressJSON);
    st.deliveryCost = cost;
    dbSaveAddress(chatId, st.addressFull, st.addressJSON).catch(() => {});

    const c = Number(cost?.cost ?? 0);
    const min = Number(cost?.minDeliverySum ?? 0);
    const freeFrom = Number(cost?.costForFreeDelivery ?? 0);
    const note =
        `Адрес: ${st.addressFull}\n` +
        `Доставка: ${priceLabel(c)}${freeFrom ? `, бесплатно от ${priceLabel(freeFrom)}` : ""}\n` +
        `${min ? `Мин. сумма заказа: ${priceLabel(min)}` : ""}`;

    const cal = await sabyDeliveryCalendar(POINT_ID, 0, 7);
    const dates = Array.isArray(cal?.dates) ? cal.dates : [];

    const now = DateTime.now().setZone(BUSINESS_TZ);
    const prepared = [];
    for (const d of dates) {
        const dateStr = d.Date ?? d.date;
        if (!dateStr) continue;
        const indices = normalizeCalendarIntervals(d.Intervals ?? d.intervals).filter(i => i >= SLOT_OPEN_IDX && i <= SLOT_CLOSE_IDX);
        if (!indices.length) continue;

        const dateISO = DateTime.fromISO(`${dateStr}T00:00:00`, { zone: BUSINESS_TZ });
        const isToday = dateISO.hasSame(now, 'day');
        let cutoffIdx = SLOT_OPEN_IDX;
        if (isToday) {
            const minutesSinceMidnight = now.hour * 60 + now.minute;
            const k = Math.ceil(Math.max(0, minutesSinceMidnight - 30) / 30);
            cutoffIdx = Math.max(SLOT_OPEN_IDX, k);
        }
        prepared.push({
            dateStr,
            human: DateTime.fromISO(dateStr, { zone: BUSINESS_TZ }).toFormat('dd.LL (ccc)'),
            indices, cutoffIdx, isToday
        });
        if (prepared.length === 4) break;
    }

    if (!prepared.length) {
        await tg("sendMessage", { chat_id: chatId, text: `Нет доступных слотов.\n${note}` });
        return;
    }

    const rows = [];
    rows.push(prepared.map(col => ({ text: col.human, callback_data: "noop" })));

    for (let idx = SLOT_OPEN_IDX; idx <= SLOT_CLOSE_IDX; idx++) {
        const row = [];
        for (const col of prepared) {
            if ((col.isToday && idx < col.cutoffIdx) || !col.indices.includes(idx)) {
                row.push({ text: "—", callback_data: "noop" });
            } else {
                row.push({ text: slotLabel(idx), callback_data: `slot:${col.dateStr}:${idx}` });
            }
        }
        rows.push(row);
    }
    rows.push([{ text: "Изменить адрес", callback_data: "order:address" }]);

    await tg("sendMessage", { chat_id: chatId, text: `Выбери дату и время.\n${note}`, ...ik(rows) });
}
async function askPayment(chatId) {
    const st = getState(chatId);
    st.flow = "payment_wait";
    const rows = [
        // [{ text: "💳 Онлайн оплата", callback_data: "pay:online" }],
        [{ text: "💵 Наличные при получении", callback_data: "pay:cash" }],
        [{ text: "🤝 Перевод при получении", callback_data: "pay:transfer" }]
    ];
    await tg("sendMessage", { chat_id: chatId, text: "Выбери способ оплаты:", ...ik(rows) });
}
async function waitForPaymentAndFinalize(chatId, externalId, total, {timeoutMs = 15 * 60 * 1000, pollMs = 4000} = {}) {
    const started = Date.now();
    let notifiedTick = 0;
    while (Date.now() - started < timeoutMs) {
        await new Promise(r => setTimeout(r, pollMs));
        try {
            const s = await sabyOrderState(externalId);
            const paid = Array.isArray(s?.payments) && s.payments.some(p => p?.isClosed === true);
            if (paid) {
                try { await sabyRegisterPayment(externalId, { bankSum: Number(total) || 0, retailPlace: SHOP_URL, paymentType: "full" }); } catch (e) {}
                await tg("sendMessage", { chat_id: chatId, text: "✅ Оплата получена. Заказ передан на точку и фискализирован." });
                return true;
            }
            notifiedTick++;
            if (notifiedTick % Math.ceil(60_000 / pollMs) === 0) {
                await tg("sendMessage", { chat_id: chatId, text: "Жду оплату, как кошка — рыбу. Ссылка выше всё ещё действует." }).catch(() => {});
            }
        } catch {}
    }
    try { await sabyCancelOrder(externalId); } catch {}
    await tg("sendMessage", { chat_id: chatId, text: "⏳ Время ожидания оплаты истекло. Заказ отменён. Если деньги всё-таки списались, они откатятся автоматически или свяжемся вручную." });
    return false;
}
async function askPhone(chatId) {
    const st = getState(chatId);
    st.flow = "phone_wait";
    const replyMarkup = {
        keyboard: [[{ text: "📱 Отправить телефон", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true
    };
    await tg("sendMessage", { chat_id: chatId, text: "Нужен телефон для связи. Нажми кнопку ниже.", reply_markup: JSON.stringify(replyMarkup) });
}
async function createOrder(chatId) {
    const st = getState(chatId);
    const customerName = st.customer?.name || "Гость";
    const customerPhone = normalizePhone(st.customer?.phone || "") || null;

    if (!st.cart?.length) { await tg("sendMessage", { chat_id: chatId, text: "Корзина пуста. Сначала выбери позиции из меню." }); return; }
    if (!st.addressJSON || !st.slot) { await tg("sendMessage", { chat_id: chatId, text: "Нужны адрес и слот доставки." }); return; }
    if (!customerPhone) { await tg("sendMessage", { chat_id: chatId, text: "Нет корректного телефона. Повтори ввод." }); return askPhone(chatId); }

    const datetimeISO = toLocalPrestoDate(st.slot.date, st.slot.halfHourIndex);
    const priceListId = Number.parseInt(String(FIXED_PRICE_LIST_ID), 10);
    if (!Number.isFinite(priceListId)) { await tg("sendMessage", { chat_id: chatId, text: "Не удалось определить прайс-лист. Попробуй позже." }); return; }

    const nomenclatures = st.cart.map(r => {
        const idNum = Number.parseInt(String(r.id), 10);
        const base = { count: Number.isFinite(Number(r.count)) ? Number(r.count) : 1, priceListId };
        if (Number.isFinite(idNum)) base.id = idNum; else base.nomNumber = String(r.id);
        const costNum = Number(r.cost); if (Number.isFinite(costNum)) base.cost = costNum;
        base.name = r.name; return base;
    });
    const addressJSONString = typeof st.addressJSON === "string" ? st.addressJSON : JSON.stringify(st.addressJSON);

    const pm = (st.paymentMethod === "cash" || st.paymentMethod === "transfer" || st.paymentMethod === "online") ? st.paymentMethod : "online";
    const delivery = {
        isPickup: false,
        addressJSON: addressJSONString,
        addressFull: st.addressFull || undefined,
        shopURL: SHOP_URL, successURL: SUCCESS_URL, errorURL: ERROR_URL,
        paymentType: pm === "online" ? "online" : "cash"
    };
    const payNote = pm === "online" ? "Оплата: онлайн" : (pm === "cash" ? "Оплата: наличные" : "Оплата: перевод");

    const payload = {
        product: "delivery",
        pointId: Number(POINT_ID),
        comment: `Заказ из Telegram от ${customerName}. ${payNote} • Ожидает подтверждения оплаты.`,
        customer: { externalId: generateStableUuid(String(chatId)), name: customerName, phone: customerPhone },
        datetime: datetimeISO,
        nomenclatures, delivery
    };

    const created = await sabyCreateOrder(payload);
    const orderExternalId =
        created?.externalId ?? created?.orderExternalId ?? created?.result?.externalId ??
        created?.result?.orderExternalId ?? created?.id ?? created?.orderId ?? null;
    if (!orderExternalId) { await tg("sendMessage", { chat_id: chatId, text: "Saby не вернул идентификатор заказа. Попробуй позже." }); return; }

    let stateObj = null; try { stateObj = await sabyOrderState(orderExternalId); } catch {}
    if (!stateObj || !Number.isFinite(Number(stateObj.state))) {
        const total = st.cart.reduce((s, r) => s + (Number(r.cost) || 0) * (Number(r.count) || 1), 0);
        await tg("sendMessage", { chat_id: chatId, text: ["Не удалось подтвердить регистрацию заказа на стороне Saby.","Слот доставки не забронирован.",`Итого по корзине: ${priceLabel(total)}`].join("\n") });
        return;
    }

    st.lastExternalId = orderExternalId;
    const total = st.cart.reduce((s, r) => s + (Number(r.cost) || 0) * (Number(r.count) || 1), 0);

    await tg("sendMessage", { chat_id: chatId, text: `Заказ создан. Номер: ${orderExternalId}` });

    if (pm === "online") {
        try {
            const link = await sabyPaymentLink(orderExternalId, { shopURL: SHOP_URL, successURL: SUCCESS_URL, errorURL: ERROR_URL });
            await tg("sendMessage", { chat_id: chatId, text: ["Оплатить заказ до подтверждения:", `Итого к оплате: ${priceLabel(total)}`].join("\n"), ...ik([[{ text: "💳 Перейти к оплате", url: link.link }]]) });
            setTimeout(() => {}, 0);
            waitForPaymentAndFinalize(chatId, orderExternalId, total).catch(() => {});
        } catch {
            await tg("sendMessage", { chat_id: chatId, text: ["Онлайн-оплата сейчас недоступна.","Заказ создан, оплату можно будет внести при получении.",`Итого по заказу: ${priceLabel(total)}`].join("\n") });
        }
        return;
    }
    if (pm === "cash") {
        await tg("sendMessage", { chat_id: chatId, text: ["Оплата наличными при получении.", `Итого по заказу: ${priceLabel(total)}`].join("\n") });
    } else {
        await tg("sendMessage", { chat_id: chatId, text: ["Оплата переводом. Реквизиты уточнят по телефону при подтверждении.", `Итого по заказу: ${priceLabel(total)}`].join("\n") });
    }
}

// ====== РЕЖИМ СОРТИРОВКИ (для ADMIN_ID) ======
function renderSortKeyboard(parentId) {
    const base = (CATALOG.foldersByParent.get(parentId ?? CATALOG.ROOT) || []).slice();
    const ids = getOrderedAll(base, parentId ?? null); // показываем все, включая скрытые
    const cfg = CATEGORY_ORDER.get(parentId ?? null) || { hidden: new Set(), order: [] };

    const rows = ids.map(id => {
        const name = CATALOG.byId.get(id)?.name || "Каталог";
        const isHidden = cfg.hidden.has(String(id));
        const eye = isHidden ? "🚫" : "👁";
        return [
            { text: "↑", callback_data: `sort:up:${encId(parentId ?? "root")}:${encId(id)}` },
            { text: `${eye} ${name}`, callback_data: `sort:toggle:${encId(parentId ?? "root")}:${encId(id)}` },
            { text: "↓", callback_data: `sort:down:${encId(parentId ?? "root")}:${encId(id)}` }
        ];
    });

    // Навигация по дереву
    const navRow = [];
    if (parentId != null) {
        navRow.push({ text: "⬆️ Вверх", callback_data: `sort:open:${encId(CATALOG.parentById.get(parentId) ?? "root")}` });
    }
    for (const fid of base.slice(0, 3)) {
        navRow.push({ text: `📂 ${CATALOG.byId.get(fid)?.name || "Каталог"}`, callback_data: `sort:open:${encId(fid)}` });
    }
    if (navRow.length) rows.push(navRow);

    rows.push([{ text: "✅ Готово", callback_data: "sort:exit" }]);
    return { rows, ids };
}
async function showSortMenu(chatId, parentId = null) {
    const { rows } = renderSortKeyboard(parentId);
    const title = parentId == null ? "Сортировка: корень" : `Сортировка: ${CATALOG.byId.get(parentId)?.name || "Каталог"}`;
    await tg("sendMessage", { chat_id: chatId, text: title + "\nПервый сверху — автопроваливание.", ...ik(rows) });
}
async function moveInOrder(parentId, itemId, dir) {
    const base = (CATALOG.foldersByParent.get(parentId ?? CATALOG.ROOT) || []).slice();
    let ids = getOrderedAll(base, parentId ?? null); // без фильтра скрытых
    const i = ids.findIndex(x => String(x) === String(itemId));
    if (i < 0) return;
    const j = dir < 0 ? Math.max(0, i - 1) : Math.min(ids.length - 1, i + 1);
    if (i === j) return;
    const x = ids[i]; ids.splice(i, 1); ids.splice(j, 0, x);
    await saveOrder(parentId ?? null, ids);
}

// ====== ХЕНДЛЕРЫ ======
async function handleMessage(m) {
    const chatId = m.chat.id;
    const text = m.text?.trim() || "";
    const st = getState(chatId);

    if (text === "/start") {
        await ensureCartLoaded(chatId);

        const cs = cartSummary(st, 6);
        const hello = [
            "Привет. Это бот доставки.",
            cs.count ? `🧺 В корзине: ${cs.count} • Итого: ${priceLabel(cs.total)}` : "🧺 Корзина пуста",
            ...(cs.preview.length ? ["", ...cs.preview] : [])
        ].join("\n");

        const main = st.mainCategories?.length ? st.mainCategories : buildMainCategories();
        st.mainCategories = main;
        await tg("sendMessage", { chat_id: chatId, text: hello, ...buildMainReplyKeyboard(main) });

        if (m.from?.id === ADMIN_ID) {
            await tg("sendMessage", { chat_id: chatId, text: "Режим сортировки: команда /sort" });
        }
        return;
    }

    if (text === "/menu" || text === "📋 Меню") {
        const main = st.mainCategories?.length ? st.mainCategories : buildMainCategories();
        st.mainCategories = main;
        await tg("sendMessage", { chat_id: chatId, text: `Меню: ${st.currentPriceListName}`, ...buildMainReplyKeyboard(main) });
        return;
    }

    if (text === "/cart" || text === "🧺 Корзина") { await showCart(chatId); return; }
    if (text === "/order" || text === "🚚 Доставка") { await askAddress(chatId); return; }
    if (text === "/status") {
        if (!st.lastExternalId) { await tg("sendMessage", { chat_id: chatId, text: "Пока нет заказов." }); return; }
        const s = await sabyOrderState(st.lastExternalId);
        await tg("sendMessage", { chat_id: chatId, text: `Статус: ${JSON.stringify(s)}` });
        return;
    }

    // === админ: диагностика каталога ===
    if (text === "/diag" && m.from?.id === ADMIN_ID) {
        try {
            const msg = dumpTreePreview(CATALOG, 20, 3);
            await tg("sendMessage", { chat_id: chatId, text: "Диагностика каталога:\n" + msg });
        } catch(e) {
            await tg("sendMessage", { chat_id: chatId, text: "Диагностика недоступна: " + (e?.message || e) });
        }
        return;
    }

    if (text === "/sort" && m.from?.id === ADMIN_ID) {
        st.sortMode = { parentId: null };
        await showSortMenu(chatId, null);
        return;
    }

    // Нажатие на категорию в reply keyboard
    const hit = (st.mainCategories || []).find(c => c.name === text);
    if (hit) { await sendCategoryItems(chatId, hit.id, 0); return; }

    if (st.flow === "address_wait" && text) return handleAddressInput(chatId, text);

    if (st.flow === "phone_wait" && m.contact?.phone_number) {
        const norm = normalizePhone(m.contact.phone_number);
        st.customer = { ...(st.customer || {}), name: m.from?.first_name || "Гость", phone: norm };
        st.flow = null;
        dbSavePhone(chatId, norm, true).catch(() => {});
        await tg("sendMessage", { chat_id: chatId, text: `Спасибо, номер получен: ${norm}`, reply_markup: JSON.stringify({ remove_keyboard: true }) });
        return createOrder(chatId);
    }
    if (st.flow === "phone_wait" && text) {
        const norm = normalizePhone(text);
        if (!norm) return tg("sendMessage", { chat_id: chatId, text: "Не похоже на номер. Нажми кнопку «📱 Отправить телефон» или введи формат +79XXXXXXXXX." });
        st.customer = { ...(st.customer || {}), name: m.from?.first_name || "Гость", phone: norm };
        st.flow = null;
        dbSavePhone(chatId, norm, false).catch(() => {});
        return createOrder(chatId);
    }
}

async function handleCallback(cb) {
    const chatId = cb.message.chat.id;
    const data = cb.data || "";
    const st = getState(chatId);

    const isQuickToast =
        data.startsWith("add:") ||
        data === "cart:show" ||
        data === "cart:clear" ||
        data.startsWith("cart:dec:") ||
        data.startsWith("cart:inc:") ||
        data.startsWith("cart:del:");

    if (!isQuickToast) await answerCbSafe(cb);

    if (data === "noop") return;

    // Навигация по товарам страницами
    if (data.startsWith("ipage:")) {
        const [, enc, rawPage] = data.split(":");
        const decoded = decId(enc);
        const catId = decoded === "root" ? null : decoded;
        const page = Number(rawPage || 0);
        await sendCategoryItems(chatId, catId, page);
        return;
    }

    // Вход в каталог
    if (data.startsWith("cat:")) {
        const [, enc, rawPage] = data.split(":");
        const decoded = decId(enc);
        const catId = decoded === "root" ? null : decoded;
        const page = Number(rawPage || 0);
        await sendCategoryItems(chatId, catId, page);
        return;
    }

    // «Назад» строго на один уровень вверх
    if (data.startsWith("back:")) {
        const [, enc] = data.split(":");
        const decoded = decId(enc);
        const catId = decoded === "root" ? null : decoded;
        await sendCategoryItems(chatId, catId, 0);
        return;
    }

    // Добавление товара
    if (data.startsWith("add:")) {
        const id = data.split(":")[1];
        const res = await addToCart(chatId, id);
        const toast = res.added ? `+1 • ${res.name} | ${priceLabel(res.total)}` : "Не удалось";
        await answerCbSafe(cb, toast);
        return;
    }

    // Корзина показать/очистить/правки
    if (data === "cart:show") { await showCart(chatId); await answerCbSafe(cb); return; }
    if (data === "cart:clear") {
        const st2 = await ensureCartLoaded(chatId);
        st2.cart = [];
        await dbSaveCart(chatId, st2.cart).catch(() => {});
        await showCart(chatId);
        await answerCbSafe(cb, "Очищено");
        return;
    }
    if (data.startsWith("cart:dec:")) {
        const id = data.split(":")[2];
        await changeCartQty(chatId, id, -1);
        await showCart(chatId);
        await answerCbSafe(cb, "−1");
        return;
    }
    if (data.startsWith("cart:inc:")) {
        const id = data.split(":")[2];
        await changeCartQty(chatId, id, +1);
        await showCart(chatId);
        await answerCbSafe(cb, "+1");
        return;
    }
    if (data.startsWith("cart:del:")) {
        const id = data.split(":")[2];
        await deleteCartItem(chatId, id);
        await showCart(chatId);
        await answerCbSafe(cb, "Удалено");
        return;
    }

    // Оформление
    if (data === "order:start" || data === "order:address") { await askAddress(chatId); return; }
    if (data.startsWith("addrprev:")) {
        const idx = Number(data.split(":")[1] || 0);
        const opt = st.addrPrev?.[idx];
        if (!opt) { await answerCbSafe(cb, "Адрес не найден"); return; }
        st.addressFull = opt.addressFull; st.addressJSON = opt.addressJSON; st.addrPrev = null;
        await afterAddressPicked(chatId); return;
    }
    if (data === "addr:new") { st.addrPrev = null; await tg("sendMessage", { chat_id: chatId, text: "Ок, введи новый адрес:" }); return; }
    if (data.startsWith("addrpick:")) {
        const idx = Number(data.split(":")[1] || 0);
        const opt = st.addrOptions?.[idx];
        if (!opt) { await answerCbSafe(cb, "Адрес не найден"); return; }
        st.addressFull = opt.addressFull; st.addressJSON = opt.addressJSON; st.addrOptions = null;
        dbSaveAddress(chatId, st.addressFull, st.addressJSON).catch(() => {});
        await afterAddressPicked(chatId); return;
    }
    if (data.startsWith("slot:")) {
        const [, date, idx] = data.split(":");
        st.slot = { date, halfHourIndex: Number(idx) };
        await askPayment(chatId); return;
    }
    if (data.startsWith("pay:")) {
        const method = data.split(":")[1];
        if (!["online", "cash", "transfer"].includes(method)) { await answerCbSafe(cb, "Способ оплаты не поддерживается"); return; }
        st.paymentMethod = method; st.flow = null; await askPhone(chatId); return;
    }

    // === СОРТИРОВКА (только для админа) ===
    if (cb.from?.id === ADMIN_ID && data.startsWith("sort:")) {
        const parts = data.split(":"); // sort:<cmd>:<parentEnc or targetEnc>:<idEnc?>
        const cmd = parts[1];

        if (cmd === "up" || cmd === "down") {
            const parentDec = decId(parts[2]); const parentId = parentDec === "root" ? null : parentDec;
            const id = decId(parts[3]);
            await moveInOrder(parentId, id, cmd === "up" ? -1 : +1);
            await answerCbSafe(cb, cmd === "up" ? "↑" : "↓");
            await showSortMenu(chatId, parentId);
            return;
        }
        if (cmd === "open") {
            const targetDec = decId(parts[2]); // тут parts[2] — целевой id
            const target = targetDec === "root" ? null : targetDec;
            await showSortMenu(chatId, target);
            return;
        }
        if (cmd === "exit") {
            const st2 = getState(chatId);
            delete st2.sortMode;
            await tg("sendMessage", { chat_id: chatId, text: "Сортировка сохранена." });
            const main = buildMainCategories();
            st2.mainCategories = main;
            await tg("sendMessage", { chat_id: chatId, text: `Меню: ${st2.currentPriceListName}`, ...buildMainReplyKeyboard(main) });
            return;
        }
        if (cmd === "toggle") {
            // переключаем скрытость в БД, порядок не трогаем
            const parentDec = decId(parts[2]); const parentId = parentDec === "root" ? null : parentDec;
            const id = decId(parts[3]);
            const pid = parentId == null ? null : String(parentId);
            const cfg = CATEGORY_ORDER.get(pid) || { order: [], hidden: new Set() };
            const hidden = new Set(cfg.hidden);
            if (hidden.has(String(id))) hidden.delete(String(id));
            else hidden.add(String(id));
            await dbSaveMenuOrder(pid, cfg.order.map(String), [...hidden]);
            CATEGORY_ORDER.set(pid, { order: cfg.order.map(String), hidden });
            await answerCbSafe(cb, "👁 переключено");
            await showSortMenu(chatId, parentId);
            return;
        }
    }
}

// ====== СТАРТ ======
function pickPointId(pointsResp) {
    let list = Array.isArray(pointsResp?.salesPoints) ? pointsResp.salesPoints :
        Array.isArray(pointsResp?.records) ? pointsResp.records :
            Array.isArray(pointsResp) ? pointsResp : [];
    if (!list.length) return null;
    return list[0]?.id ?? null;
}

async function startup() {
    await dbInit();

    // Загружаем порядок категорий/скрытые
    const orders = await dbLoadAllMenuOrders().catch(() => []);
    loadOrdersToMap(orders);

    await sabyAuth();

    const pointsResp = await sabyGetPoints();
    POINT_ID = pickPointId(pointsResp);
    if (!POINT_ID) throw new Error("Не найдена ни одна точка продаж.");

    const priceListsResp = await sabyGetPriceLists(POINT_ID);
    PRICE_LISTS = (Array.isArray(priceListsResp?.records) ? priceListsResp.records :
        Array.isArray(priceListsResp?.result) ? priceListsResp.result :
            Array.isArray(priceListsResp) ? priceListsResp : []).map(x => ({
        id: x.id ?? x.priceListId ?? x.key,
        name: x.name ?? x.title ?? `Прайс #${x.id ?? x.priceListId ?? x.key}`
    })).filter(p => p.id);

    catDbg(`[menu] price-lists found: ${PRICE_LISTS.length}`);
    vdbg(`[menu] price-lists: ${PRICE_LISTS.map(p => `${p.id}:${p.name}`).join(" | ")}`);

    // Номенклатура из фиксированного прайса
    const nomenclatureResp = await sabyGetNomenclature(POINT_ID, FIXED_PRICE_LIST_ID, 0, 2000);
    const records = Array.isArray(nomenclatureResp?.nomenclatures) ? nomenclatureResp.nomenclatures :
        Array.isArray(nomenclatureResp?.records) ? nomenclatureResp.records :
            Array.isArray(nomenclatureResp?.result) ? nomenclatureResp.result :
                Array.isArray(nomenclatureResp) ? nomenclatureResp : [];
    catDbg("[menu] nomenclature typeof:", typeof nomenclatureResp);
    catDbg("[menu] nomenclature keys:", Object.keys(nomenclatureResp || {}));
    catDbg("[menu] records count:", records.length);

    CATALOG = buildCatalogIndexes(records);
    catDbg(`[menu] catalog refreshed, folders: ${(CATALOG.foldersByParent.get(CATALOG.ROOT)||[]).length}, items: ${(CATALOG.itemsByParent.get(CATALOG.ROOT)||[]).length}`);

    await tg("setMyCommands", {
        commands: [
            { command: "start", description: "Запуск" },
            { command: "menu", description: "Меню" },
            { command: "cart", description: "Корзина" },
            { command: "order", description: "Оформить доставку" },
            { command: "status", description: "Статус последнего заказа" },
            { command: "sort", description: "Режим сортировки (админ)" },
            { command: "diag", description: "Диагностика каталога (админ)" }
        ]
    });

    dbg(`Готово. Точка ${POINT_ID}, прайс 64 "${FIXED_PRICE_LIST_NAME}". Навигация: автопроваливание/стрелки/умный Назад. Сортировка для ${ADMIN_ID}.`);
}

// ====== ПОЛЛИНГ ======
(async () => {
    try {
        await startup();
        for (;;) {
            const res = await fetch(`${TG_API}/getUpdates`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ timeout: 25, offset: UPDATE_OFFSET + 1 })
            }).then(r => r.json()).catch(() => null);

            if (!res || !res.ok) continue;

            for (const up of res.result) {
                UPDATE_OFFSET = up.update_id;
                try {
                    if (up.message) await handleMessage(up.message);
                    if (up.callback_query) await handleCallback(up.callback_query);
                } catch (e) {
                    console.error("handler error", e);
                }
            }
        }
    } catch (e) {
        console.error("fatal:", e);
        process.exit(1);
    }
})();
