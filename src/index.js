import { createEngine } from './engine.js';

/**
 * Attach the Saby/Presto menu listener to a Telegraf bot.
 *
 * This function reads configuration parameters from environment variables. It accepts a storage adapter
 * that implements the necessary persistence operations (addresses, phone numbers, cart contents and
 * menu order). Once attached, it registers its own handlers on the provided bot instance and returns
 * the list of commands it exposes (e.g. `/menu`, `/cart`, `/delivery`, `/sort` for admins).
 *
 * @param {import('telegraf').Telegraf} bot The Telegraf bot instance.
 * @param {Object} storage An object implementing the storage interface (ready, getAddresses, saveAddress, savePhone, loadCart, saveCart, loadAllMenuOrders, saveMenuOrder).
 * @param {Object} [options] Reserved for future use.
 * @returns {Promise<Array<{command: string, description: string}>>} Commands registered by the menu.
 */
export default async function attachMenu(bot, storage = {}, options = {}) {
    // Build the Saby configuration from process.env; fall back to sensible defaults where appropriate.
    const saby = {
        clientId: process.env.SABY_CLIENT_ID,
        secretKey: process.env.SABY_SECRET_KEY,
        serviceKey: process.env.SABY_SERVICE_KEY,
        authUrl: process.env.SABY_AUTH_URL || 'https://online.sbis.ru/oauth/service/',
        apiBase: process.env.SABY_API_BASE || 'https://api.sbis.ru',
        fixedPriceListId: Number(process.env.SABY_PRICE_LIST_ID) || 64,
        fixedPriceListName: process.env.SABY_PRICE_LIST_NAME || 'Меню'
    };

    const business = {
        timeZone: process.env.BUSINESS_TZ || 'Asia/Vladivostok',
        slotOpenIdx: Number(process.env.SLOT_OPEN_IDX) || 20,
        slotCloseIdx: Number(process.env.SLOT_CLOSE_IDX) || 42,
        adminId: Number(process.env.ADMIN_ID) || 0
    };

    const shop = {
        shopURL: process.env.SHOP_URL || 'https://pizza25.ru',
        successURL: process.env.SHOP_SUCCESS_URL || 'https://pizza25.ru/pay/success',
        errorURL: process.env.SHOP_ERROR_URL || 'https://pizza25.ru/pay/error'
    };

    // Basic validation
    if (!saby.clientId || !saby.secretKey || !saby.serviceKey) {
        throw new Error('[menu listener] Missing Saby credentials: SABY_CLIENT_ID, SABY_SECRET_KEY, SABY_SERVICE_KEY');
    }
    if (!storage || typeof storage !== 'object') {
        throw new Error('[menu listener] A valid storage adapter must be provided');
    }

    // Initialise the engine with the provided configuration and storage. The debug flag can be tuned via env if needed.
    const engine = await createEngine({
        saby,
        business,
        shop,
        storage,
        debug: process.env.MENU_DEBUG ? Number(process.env.MENU_DEBUG) : 1
    });

    // Attach the engine's handlers to the bot
    await engine.attach(bot);

    // Return the commands array so the host application can merge it with its own commands
    return Array.isArray(engine.commands) ? engine.commands : [];
}

// Re-export createEngine for advanced use cases where consumers need direct access to the engine.
export { createEngine } from './engine.js';
