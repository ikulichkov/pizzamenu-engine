// src/engine.js
// Ядро движка. Пространство callback-данных: только "m:*", как в варианте 1 (безопасность).
// Команды: из 4 (+ /sort для админа, паритет с A из 2). /start сосуществует с чужим, см. ctx.state.handled.
// TZ: Intl.* без luxon.

import { createSabyClient } from './saby.js';
import { nowTZMinutesSinceMidnight, slotLabel } from './util-date.js';
import { priceLabel, encId, decId } from './shared.js';

const MENU_PREFIX = 'm:'; // всё, что не начинается с m:, — не наше и игнорим. (вариант 1)

const DEFAULTS = {
    business: { timeZone: 'Asia/Vladivostok', slotOpenIdx: 20, slotCloseIdx: 42, adminId: 0 },
    saby: { fixedPriceListId: 64, fixedPriceListName: 'Бар основной' },
    shop: { shopURL: 'https://pizza25.ru', successURL: 'https://pizza25.ru/pay/success', errorURL: 'https://pizza25.ru/pay/error' },
    ui: { pageSize: 12 }
};

/** @typedef {{ready:()=>Promise<boolean>, getAddresses:(userId:number,limit?:number)=>Promise<any[]>, saveAddress:(userId:number,full:string,json:any)=>Promise<void>, savePhone:(userId:number,phone:string,isPrimary?:boolean)=>Promise<void>, loadCart:(userId:number)=>Promise<any[]>, saveCart:(userId:number,items:any[])=>Promise<void>, loadAllMenuOrders:()=>Promise<Array<{parentId:string|null, orderedIds:string[], hiddenIds:string[]}>>, saveMenuOrder:(parentId:string|null, orderedIds:string[], hiddenIds:string[])=>Promise<void>}} Storage */

/**
 * Создает движок меню.
 * @param {{saby:object,business?:object,shop?:object,storage:Storage,debug?:number}} params
 */
export async function createEngine({ saby, business, shop, storage, debug = 1 }) {
    const cfg = {
        business: { ...DEFAULTS.business, ...business },
        saby: { ...DEFAULTS.saby, ...saby },
        shop: { ...DEFAULTS.shop, ...shop },
        ui: DEFAULTS.ui
    };

    // Saby клиент
    const SABY = createSabyClient({
        clientId: saby.clientId, secretKey: saby.secretKey, serviceKey: saby.serviceKey,
        authUrl: saby.authUrl, apiBase: saby.apiBase
    });

    // Runtime кэш каталога/прайса/порядка
    let POINT_ID = null;
    let CATALOG = { byId: new Map(), parentById: new Map(), foldersByParent: new Map(), itemsByParent: new Map(), ROOT: '__root__' };
    const CATEGORY_ORDER = new Map(); // parentId -> { orderedIds:string[], hiddenIds:string[] }
    const STATE = new Map(); // chatId -> { cart, cartLoaded, sortMode?:boolean, currentPriceListId, currentPriceListName, catId?:string|null }

    const commands = [
        { command: 'menu', description: 'Показать меню' },
        { command: 'cart', description: 'Корзина' },
        { command: 'delivery', description: 'Оформить доставку' }
    ];
    if (cfg.business.adminId) commands.push({ command: 'sort', description: 'Режим сортировки меню (admin)' });

    // ========= helpers =========
    const log = (...a) => { if (debug) console.log('[menu6]', ...a); };

    function getState(chatId) {
        if (!STATE.has(chatId)) STATE.set(chatId, {});
        const st = STATE.get(chatId);
        if (!Array.isArray(st.cart)) st.cart = [];
        if (!st.cartLoaded) st.cartLoaded = false;
        if (!st.currentPriceListId) st.currentPriceListId = cfg.saby.fixedPriceListId;
        if (!st.currentPriceListName) st.currentPriceListName = cfg.saby.fixedPriceListName;
        return st;
    }

    async function ensureCartLoaded(chatId) {
        const st = getState(chatId);
        if (st.cartLoaded) return st;
        try { st.cart = await storage.loadCart(chatId) || []; } catch {}
        st.cartLoaded = true; return st;
    }

    function applyOrderFor(parentId, ids) {
        const rec = CATEGORY_ORDER.get(parentId == null ? null : String(parentId));
        if (!rec) return ids.slice();
        const hidden = new Set(rec.hiddenIds || []);
        const order = Array.isArray(rec.orderedIds) ? rec.orderedIds.map(String) : [];
        const visible = ids.filter(x => !hidden.has(String(x)));
        const inOrder = order.filter(x => visible.includes(x));
        const rest = visible.filter(x => !inOrder.includes(x));
        return [...inOrder, ...rest];
    }

    // ========= каталог/прайс =========
    async function refreshCatalog() {
        if (!POINT_ID) {
            const pts = await SABY.getPoints();
            POINT_ID = SABY.pickPointId(pts) || null;
            if (!POINT_ID) throw new Error('No Saby pointId');
        }
        const pl = await SABY.getPriceLists(POINT_ID);
        const picked = Array.isArray(pl?.records) ? pl.records.find(r => Number(r.id) === Number(cfg.saby.fixedPriceListId)) : null;
        const pid = picked?.id ?? cfg.saby.fixedPriceListId;

        const all = await SABY.getNomenclature(POINT_ID, pid, 0, 1000);

        const byId = new Map(); const parentById = new Map();
        const foldersByParent = new Map(); const itemsByParent = new Map();
        const ROOT = '__root__';

        const items = Array.isArray(all?.items) ? all.items : Array.isArray(all?.records) ? all.records : [];
        for (const row of items) {
            const id = String(row.id);
            const parentId = row.parentId == null ? ROOT : String(row.parentId);
            const folder = !!row.group || !!row.folder;
            const cost = Number(row.price || row.cost || 0);

            byId.set(id, { id, name: String(row.name || row.title || 'Без названия'), folder, cost });
            parentById.set(id, parentId);

            const map = folder ? foldersByParent : itemsByParent;
            if (!map.has(parentId)) map.set(parentId, []);
            map.get(parentId).push(id);
        }

        CATALOG = { byId, parentById, foldersByParent, itemsByParent, ROOT };

        // порядок/скрытие из БД
        const rows = await storage.loadAllMenuOrders().catch(() => []);
        CATEGORY_ORDER.clear();
        for (const rec of rows) {
            CATEGORY_ORDER.set(rec.parentId == null ? null : String(rec.parentId), {
                orderedIds: (rec.orderedIds || []).map(String),
                hiddenIds:  (rec.hiddenIds  || []).map(String)
            });
        }
        log('catalog refreshed, items:', byId.size);
    }

    // ========= рендеры UI =========
    function mainCategories() {
        const base = (CATALOG.foldersByParent.get(CATALOG.ROOT) || []).slice();
        const ids = applyOrderFor(null, base);
        return ids.map(id => ({ id, name: CATALOG.byId.get(id)?.name || 'Каталог' }));
    }

    function replyKb(categories) {
        const rows = [];
        let row = [];
        for (const c of categories) {
            row.push({ text: c.name });
            if (row.length === 3) { rows.push(row); row = []; }
        }
        if (row.length) rows.push(row);
        rows.push([{ text: '📋 Меню' }, { text: '🧺 Корзина' }, { text: '🚚 Доставка' }]);
        return { reply_markup: { keyboard: rows, resize_keyboard: true, one_time_keyboard: false } };
    }

    async function __getStartPayload(chatIdOrCtx) {
        const chatId = typeof chatIdOrCtx === 'number' ? chatIdOrCtx : chatIdOrCtx?.chat?.id;
        const st = getState(chatId || 0);
        const cats = mainCategories();
        const text = `Меню: ${st.currentPriceListName}`;
        const extra = replyKb(cats);
        return { text, extra };
    }

    async function sendStartUi(ctx) {
        const { text, extra } = await __getStartPayload(ctx);
        await ctx.reply(text, extra);
    }

    async function sendCategory(ctx, catId = null, page = 0) {
        const st = getState(ctx.chat.id);
        st.catId = catId;

        const parentKey = catId ?? CATALOG.ROOT;
        const folders = applyOrderFor(catId, CATALOG.foldersByParent.get(parentKey) || []);
        const itemsAll = CATALOG.itemsByParent.get(parentKey) || [];

        // автопроваливание, если в папке нет товаров
        if (!itemsAll.length && folders.length) {
            return sendCategory(ctx, folders[0], 0);
        }

        const pageSize = cfg.ui.pageSize;
        const start = page * pageSize;
        const itemsPage = itemsAll.slice(start, start + pageSize);

        const rows = [];

        // подпапки
        if (folders.length && itemsAll.length) {
            for (const fid of folders) {
                rows.push([{ text: `📂 ${CATALOG.byId.get(fid)?.name || 'Каталог'}`, callback_data: `${MENU_PREFIX}cat:${encId(fid)}:0` }]);
            }
        }

        // товары
        for (const iid of itemsPage) {
            const it = CATALOG.byId.get(iid);
            rows.push([{ text: `${it.name} • ${priceLabel(it.cost)}`, callback_data: `${MENU_PREFIX}add:${it.id}` }]);
        }

        // пагинация
        const totalPages = Math.ceil(itemsAll.length / pageSize);
        if (totalPages > 1) {
            const nav = [];
            for (let p = Math.max(0, page - 2); p <= Math.min(totalPages - 1, page + 2); p++) {
                nav.push({ text: p === page ? `👁 ${p + 1}` : `${p + 1}`, callback_data: `${MENU_PREFIX}ipage:${encId(catId ?? 'root')}:${p}` });
            }
            rows.push(nav);
        }

        // корзина
        const stCart = await ensureCartLoaded(ctx.chat.id);
        const total = stCart.cart.reduce((s, r) => s + r.cost * r.count, 0);
        const count = stCart.cart.reduce((s, r) => s + r.count, 0);

        rows.push([
            { text: `🧺 Корзина (${count} | ${priceLabel(total)})`, callback_data: `${MENU_PREFIX}cart:show` },
            { text: '🚚 Оформить', callback_data: `${MENU_PREFIX}order:start` }
        ]);

        const title = catId ? `Меню: ${st.currentPriceListName} / ${CATALOG.byId.get(catId)?.name || ''}` : `Меню: ${st.currentPriceListName}`;
        await ctx.reply(title, { reply_markup: { inline_keyboard: rows } });
    }

    async function showCart(ctx) {
        const st = await ensureCartLoaded(ctx.chat.id);
        if (!st.cart.length) return ctx.reply('Корзина пуста.');
        const total = st.cart.reduce((s, r) => s + r.cost * r.count, 0);
        const rows = st.cart.map(r => ([
            { text: '−', callback_data: `${MENU_PREFIX}cart:dec:${r.id}` },
            { text: `${r.name} ×${r.count}`, callback_data: `${MENU_PREFIX}noop` },
            { text: '+', callback_data: `${MENU_PREFIX}cart:inc:${r.id}` },
            { text: '✖', callback_data: `${MENU_PREFIX}cart:del:${r.id}` }
        ]));
        rows.push([{ text: 'Очистить', callback_data: `${MENU_PREFIX}cart:clear` }, { text: '🚚 Оформить', callback_data: `${MENU_PREFIX}order:start` }]);
        await ctx.reply(
            `🧺 Корзина:\n${st.cart.map(r => `• ${r.name} × ${r.count} = ${priceLabel(r.cost * r.count)}`).join('\n')}\n\nИтого: ${priceLabel(total)}`,
            { reply_markup: { inline_keyboard: rows } }
        );
    }

    // ========= действия с корзиной =========
    async function addToCart(ctx, itemId) {
        const id = String(itemId);
        const node = CATALOG.byId.get(id);
        if (!node || node.folder) return;
        const st = await ensureCartLoaded(ctx.chat.id);
        const row = st.cart.find(r => r.id === id);
        if (row) row.count += 1;
        else st.cart.push({ id, name: node.name, cost: node.cost, count: 1 });
        await storage.saveCart(ctx.chat.id, st.cart).catch(() => {});
        await ctx.answerCbQuery(`${node.name} добавлен`);
    }
    async function changeQty(ctx, id, delta) {
        const st = await ensureCartLoaded(ctx.chat.id);
        const i = st.cart.findIndex(r => r.id === id);
        if (i < 0) return;
        st.cart[i].count = Math.max(1, (st.cart[i].count || 1) + delta);
        await storage.saveCart(ctx.chat.id, st.cart).catch(() => {});
    }
    async function delItem(ctx, id) {
        const st = await ensureCartLoaded(ctx.chat.id);
        const before = st.cart.length;
        st.cart = st.cart.filter(r => r.id !== id);
        if (st.cart.length !== before) await storage.saveCart(ctx.chat.id, st.cart).catch(() => {});
    }

    // ========= сортировка для админа =========
    function isAdmin(ctx) { return cfg.business.adminId && Number(ctx.from?.id) === Number(cfg.business.adminId); }

    async function toggleSortMode(ctx) {
        if (!isAdmin(ctx)) return ctx.reply('Команда доступна только админу.');
        const st = getState(ctx.chat.id);
        st.sortMode = !st.sortMode;
        await ctx.reply(st.sortMode ? 'Режим сортировки: ВКЛ' : 'Режим сортировки: ВЫКЛ');
    }

    // ========= delivery flow (минимально) =========
    async function startDelivery(ctx) {
        await ctx.reply('Введите адрес одной строкой (улица дом, квартира):');
        const st = getState(ctx.chat.id);
        st.flow = 'address';
    }

    async function onText(ctx) {
        const text = (ctx.message?.text || '').trim();

        // главные кнопки
        if (text === '📋 Меню') return sendCategory(ctx, null, 0);
        if (text === '🧺 Корзина') return showCart(ctx);
        if (text === '🚚 Доставка') return startDelivery(ctx);

        // клик по названию корневой категории
        const cat = mainCategories().find(c => c.name === text);
        if (cat) return sendCategory(ctx, cat.id, 0);

        // простейший шаг адреса
        const st = getState(ctx.chat.id);
        if (st.flow === 'address') {
            const sugg = await SABY.suggestedAddress(text).catch(()=>null);
            const best = Array.isArray(sugg?.records) ? sugg.records[0] : null;
            if (!best) return ctx.reply('Не удалось распознать адрес, попробуйте иначе.');
            await storage.saveAddress(ctx.from.id, best.fullAddress || text, best);
            st.flow = 'slot';
            await ctx.reply('Адрес сохранен. Выберите слот доставки:');
            const minutes = nowTZMinutesSinceMidnight(cfg.business.timeZone);
            const startIdx = Math.max(cfg.business.slotOpenIdx, Math.floor((minutes - 30) / 30));
            const endIdx = cfg.business.slotCloseIdx;
            const row = [];
            for (let idx = startIdx; idx <= Math.min(endIdx, startIdx + 5); idx++) {
                row.push({ text: slotLabel(idx), callback_data: `${MENU_PREFIX}slot:${idx}` });
            }
            return ctx.reply('Доступные времена:', { reply_markup: { inline_keyboard: [row] } });
        }
    }

    async function onAction(ctx) {
        const data = String(ctx.update?.callback_query?.data || '');
        if (!data.startsWith(MENU_PREFIX)) return; // чужие callback-и не трогаем (вариант 1)
        const cmd = data.slice(MENU_PREFIX.length);

        // навигация и корзина
        if (cmd.startsWith('cat:')) {
            const [, b64, pageStr] = cmd.split(':'); const id = decId(b64);
            return sendCategory(ctx, id === 'root' ? null : id, Number(pageStr || 0) || 0);
        }
        if (cmd.startsWith('ipage:')) {
            const [, b64, pageStr] = cmd.split(':'); const id = decId(b64);
            return sendCategory(ctx, id === 'root' ? null : id, Number(pageStr || 0) || 0);
        }
        if (cmd.startsWith('add:')) {
            const id = cmd.slice('add:'.length);
            await addToCart(ctx, id);
            return;
        }
        if (cmd === 'cart:show') return showCart(ctx);
        if (cmd.startsWith('cart:dec:')) { await changeQty(ctx, cmd.split(':')[2], -1); return showCart(ctx); }
        if (cmd.startsWith('cart:inc:')) { await changeQty(ctx, cmd.split(':')[2], +1); return showCart(ctx); }
        if (cmd.startsWith('cart:del:')) { await delItem(ctx, cmd.split(':')[2]); return showCart(ctx); }
        if (cmd === 'cart:clear') {
            const st = await ensureCartLoaded(ctx.chat.id);
            st.cart = []; await storage.saveCart(ctx.chat.id, []);
            return showCart(ctx);
        }

        // слоты
        if (cmd.startsWith('slot:')) {
            const slotIdx = Number(cmd.split(':')[1]);
            await ctx.answerCbQuery(`Слот ${slotLabel(slotIdx)} выбран. Завершение оплаты вынесено в TODO.`);
            return;
        }
    }

    // ========= публичный API =========
    async function attach(bot) {
        await refreshCatalog().catch(e => log('catalog init failed', e?.message || e));

        // наш «второй /start» — не перехватывает чужой, только дополняет
        bot.start(async (ctx, next) => {
            try {
                if (!ctx.state?.handled) await sendStartUi(ctx);
            } catch {}
            return next && next();
        });

        bot.command('menu', ctx => sendCategory(ctx, null, 0));
        bot.command('cart', ctx => showCart(ctx));
        bot.command('delivery', ctx => startDelivery(ctx));
        if (cfg.business.adminId) bot.command('sort', ctx => toggleSortMode(ctx));

        bot.on('text', onText);

        // только наши callback-и, начинающиеся с m:
        bot.action(/^m:/, onAction);
    }

    return {
        attach,
        sendStartUi,
        commands,
        __getStartPayload // для совместимости (getStartPayload)
    };
}
