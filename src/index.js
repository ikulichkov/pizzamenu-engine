// Единственный экспорт: фабрика движка. База — вариант 4, с алиасами из 2/3.
// Источник идей API: 4.md (attach/sendStartUi/commands), совместимость: 2.md (register/startContent) и 3.md (getStartPayload).
import { createEngine } from './engine.js';

/**
 * @param {Object} config
 * @param {Object} config.saby {clientId, secretKey, serviceKey, authUrl?, apiBase?, fixedPriceListId?, fixedPriceListName?}
 * @param {Object} config.business { timeZone?, slotOpenIdx?, slotCloseIdx?, adminId? }
 * @param {Object} config.shop { shopURL?, successURL?, errorURL? }
 * @param {Object} [config.storage]  Пользовательский адаптер хранилища (см. storage/types.js)
 * @param {Object} [config.mongo]    Если хочешь встроенный mongoose-адаптер: { url, dbName, connect?: boolean }
 * @param {number} [config.debug=1]
 * @returns {Promise<{
 *   attach: (bot: import('telegraf').Telegraf) => Promise<void>,
 *   register: (bot: import('telegraf').Telegraf) => Promise<void>,
 *   sendStartUi: (ctx: any) => Promise<void>,
 *   getStartPayload: (chatIdOrCtx: number|any) => Promise<{text:string, extra?:object}>,
 *   commands: Array<{command:string, description:string}>
 * }>}
 */
export default async function createMenuEngine(config = {}) {
    const { saby, business = {}, shop = {}, storage, mongo, debug = 1 } = config;

    let storageImpl = storage || null;

    if (!storageImpl && mongo?.url) {
        // Динамически подгружаем mongoose-адаптер (вариант 4), НО коннект — только если connect === true
        const { createMongooseAdapter } = await import('./storage/mongoose.js');
        storageImpl = await createMongooseAdapter({
            mongoUrl: mongo.url,
            dbName: mongo.dbName || 'pizza25',
            connect: Boolean(mongo.connect),
            debug
        });
    }

    if (!saby?.clientId || !saby?.secretKey || !saby?.serviceKey) {
        throw new Error('[menu6] saby credentials are required (clientId, secretKey, serviceKey)');
    }
    if (!storageImpl) {
        throw new Error('[menu6] storage adapter is required (custom storage or mongo.url with connect flag)');
    }

    const engine = await createEngine({ saby, business, shop, storage: storageImpl, debug });

    // Совместимые алиасы под варианты 2/3:
    engine.register = engine.attach;                   // 2.md register(bot)
    engine.getStartPayload = engine.__getStartPayload; // 3.md getStartPayload(...)
    return engine;
}

export { default as createMenuEngine } from './index.js';
