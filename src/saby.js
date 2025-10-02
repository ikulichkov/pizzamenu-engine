// Обёртка над Saby API. Взято по форме из 4 и 3: auth, pickPointId, getPriceLists, getNomenclature, suggestedAddress, deliveryCost…
// Здесь ровно то, что нужно движку. Без лишнего.

import { /* short */ } from './shared.js';

export function createSabyClient({
                                     clientId, secretKey, serviceKey,
                                     authUrl = 'https://online.sbis.ru/oauth/service/',
                                     apiBase = 'https://api.sbis.ru'
                                 }) {
    const RETAIL_BASE = `${apiBase}/retail`;
    const SABY = { token: null, sid: null };

    async function auth() {
        const res = await fetch(authUrl, {
            method: 'POST',
            headers: { 'Content-Type':'application/json; charset=utf-8', 'Accept':'application/json' },
            body: JSON.stringify({ app_client_id: clientId, app_secret: secretKey, secret_key: serviceKey })
        });
        if (!res.ok) throw new Error(`Saby auth failed: ${res.status}`);
        const data = await res.json();
        SABY.token = data.token; SABY.sid = data.sid;
    }
    function headers() {
        const h = { 'Accept':'application/json' };
        if (SABY.token) h['X-SBISAccessToken'] = SABY.token;
        if (SABY.sid)   h['Cookie'] = `sid=${SABY.sid}`;
        return h;
    }
    async function call(url, opts = {}, retry = true) {
        const res = await fetch(url, { method: opts.method || 'GET', headers: { ...headers(), ...(opts.headers || {}) }, body: opts.body });
        const text = await res.text().catch(() => '');
        if (res.status === 401 && retry) { await auth(); return call(url, opts, false); }
        if (!res.ok) throw new Error(`${url} → ${res.status} ${text}`);
        try { return text ? JSON.parse(text) : {}; } catch { return { raw:text }; }
    }

    const getPoints = () => call(`${RETAIL_BASE}/point/list`);
    function pickPointId(pointsResp) {
        const list = Array.isArray(pointsResp?.salesPoints) ? pointsResp.salesPoints
            : Array.isArray(pointsResp?.records) ? pointsResp.records
                : Array.isArray(pointsResp) ? pointsResp : [];
        return list[0]?.id ?? null;
    }
    const getPriceLists = (pointId, actualDate = new Date()) => {
        const url = new URL(`${RETAIL_BASE}/nomenclature/price-list`);
        url.searchParams.set('pointId', String(pointId));
        url.searchParams.set('actualDate', `${actualDate.toLocaleDateString('ru-RU')} ${actualDate.toLocaleTimeString('ru-RU')}`);
        url.searchParams.set('pageSize', '1000');
        return call(url.toString());
    };
    const getNomenclature = (pointId, priceListId, page = 0, pageSize = 1000) => {
        const url = new URL(`${RETAIL_BASE}/nomenclature/list`);
        url.searchParams.set('pointId', String(pointId));
        url.searchParams.set('priceListId', String(priceListId));
        url.searchParams.set('page', String(page));
        url.searchParams.set('pageSize', String(pageSize));
        return call(url.toString());
    };

    const suggestedAddress = (addressLine) => {
        const url = new URL(`${RETAIL_BASE}/delivery/suggested-address`);
        url.searchParams.set('address', addressLine);
        return call(url.toString());
    };

    // Остальные вызовы (deliveryCost, deliveryCalendar, createOrder, paymentLink и т.д.) добавим при подключении онлайн-оплаты.
    return { getPoints, pickPointId, getPriceLists, getNomenclature, suggestedAddress };
}
