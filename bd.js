// db.js — адреса/телефоны/корзина + порядок меню (MenuOrder)

import mongoose from 'mongoose';
import crypto from 'crypto';

const MONGO_URL = 'mongodb://127.0.0.1:27017/pizza25';
const DB = { ready: false, Address: null, Phone: null, Cart: null, MenuOrder: null };

export async function dbInit() {
    if (DB.ready) return true;
    try {
        await mongoose.connect(MONGO_URL, { dbName: 'pizza25', serverSelectionTimeoutMS: 1500 });

        const AddressSchema = new mongoose.Schema({
            userId:      { type: Number, index: true, required: true },
            addressFull: { type: String, required: true },
            addressJSON: { type: mongoose.Schema.Types.Mixed, required: true },
            createdAt:   { type: Date, default: Date.now }
        }, { versionKey: false });
        AddressSchema.index({ userId: 1, addressFull: 1 }, { unique: true });

        const PhoneSchema = new mongoose.Schema({
            userId:    { type: Number, index: true, required: true },
            phone:     { type: String, required: true },
            isPrimary: { type: Boolean, default: false },
            createdAt: { type: Date, default: Date.now }
        }, { versionKey: false });
        PhoneSchema.index({ userId: 1, phone: 1 }, { unique: true });

        // Корзина: один документ на пользователя
        const CartSchema = new mongoose.Schema({
            userId:   { type: Number, index: true, required: true },
            items:    [{
                id:    { type: String, required: true },
                name:  { type: String, required: true },
                cost:  { type: Number, required: true },
                count: { type: Number, required: true }
            }],
            updatedAt: { type: Date, default: Date.now }
        }, { versionKey: false });
        CartSchema.index({ userId: 1 }, { unique: true });

        // Порядок и скрытие категорий меню (глобально для всех)
        const MenuOrderSchema = new mongoose.Schema({
            parentId:   { type: String, index: true, default: null }, // null == корень
            orderedIds: { type: [String], default: [] },
            hiddenIds:  { type: [String], default: [] },
            updatedAt:  { type: Date, default: Date.now }
        }, { versionKey: false });
        MenuOrderSchema.index({ parentId: 1 }, { unique: true });

        DB.Address   = mongoose.model('TelegramAddress', AddressSchema);
        DB.Phone     = mongoose.model('TelegramPhone',   PhoneSchema);
        DB.Cart      = mongoose.model('TelegramCart',    CartSchema);
        DB.MenuOrder = mongoose.model('MenuOrder',       MenuOrderSchema);

        DB.ready = true;
        return true;
    } catch (e) {
        console.error('[DB] недоступна:', e?.message || e);
        DB.ready = false;
        return false;
    }
}

export async function dbGetAddresses(userId, limit = 6) {
    if (!await dbInit()) return [];
    return DB.Address.find({ userId }).sort({ createdAt: -1 }).limit(limit).lean().exec();
}

export async function dbSaveAddress(userId, addressFull, addressJSON) {
    if (!await dbInit()) return;
    try {
        await DB.Address.updateOne(
            { userId, addressFull },
            { $setOnInsert: { addressJSON, createdAt: new Date() } },
            { upsert: true }
        ).exec();
    } catch {}
}

export async function dbSavePhone(userId, phone, isPrimary = false) {
    if (!await dbInit()) return;
    try {
        await DB.Phone.updateOne(
            { userId, phone },
            { $setOnInsert: { isPrimary, createdAt: new Date() } },
            { upsert: true }
        ).exec();
        if (isPrimary) {
            await DB.Phone.updateMany(
                { userId, phone: { $ne: phone } },
                { $set: { isPrimary: false } }
            ).exec();
        }
    } catch {}
}

// ====== корзина ======
export async function dbLoadCart(userId) {
    if (!await dbInit()) return [];
    const doc = await DB.Cart.findOne({ userId }).lean().exec();
    return Array.isArray(doc?.items) ? doc.items : [];
}
export async function dbSaveCart(userId, items) {
    if (!await dbInit()) return;
    try {
        await DB.Cart.updateOne(
            { userId },
            { $set: { items: Array.isArray(items) ? items : [], updatedAt: new Date() } },
            { upsert: true }
        ).exec();
    } catch {}
}

// ====== порядок меню (глобально) ======
export async function dbLoadAllMenuOrders() {
    if (!await dbInit()) return [];
    return DB.MenuOrder.find({}).lean().exec();
}

/**
 * Сохраняем порядок и скрытые элементы для родителя
 * @param {string|null} parentId
 * @param {string[]} orderedIds
 * @param {string[]} hiddenIds
 */
export async function dbSaveMenuOrder(parentId, orderedIds = [], hiddenIds = []) {
    if (!await dbInit()) return;
    try {
        await DB.MenuOrder.updateOne(
            { parentId: parentId == null ? null : String(parentId) },
            {
                $set: {
                    orderedIds: orderedIds.map(String),
                    hiddenIds:  hiddenIds.map(String),
                    updatedAt:  new Date()
                }
            },
            { upsert: true }
        ).exec();
    } catch (e) {
        console.error('[DB] menuOrder save error:', e?.message || e);
    }
}

// ====== UUID v5 (как было) ======
export function generateStableUuid(name, namespace = '1b671a64-40d5-491e-99b0-da01ff1f3341') {
    const ns = namespace.replace(/-/g, '');
    const nsBytes = Buffer.from(ns, 'hex');
    const nameBytes = Buffer.from(String(name), 'utf8');
    const hash = crypto.createHash('sha1').update(nsBytes).update(nameBytes).digest();
    hash[6] = (hash[6] & 0x0f) | 0x50;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const b = hash.subarray(0, 16);
    const hex = b.toString('hex');
    return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}

// ====== Нормализация календаря Presto ======
export function normalizeCalendarIntervals(raw) {
    const out = new Set();

    const addIndex = (i) => {
        const n = Number(i);
        if (Number.isInteger(n) && n >= 0 && n <= 47) out.add(n);
    };

    const addRange = (a, b) => {
        let x = Number(a), y = Number(b);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const start = Math.max(0, Math.min(x, y));
        const end   = Math.min(47, Math.max(x, y));
        for (let i = start; i <= end; i++) addIndex(i);
    };

    const walk = (val) => {
        if (val == null) return;

        if (typeof val === 'number') { addIndex(val); return; }

        if (typeof val === 'string') {
            const s = val.trim();
            if (s.toLowerCase() === 'all') { addRange(0, 47); return; }
            const m = s.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
            if (m) { addRange(m[1], m[2]); return; }
            addIndex(s);
            return;
        }

        if (Array.isArray(val)) {
            if (val.length === 2 && val.every(x => Number.isFinite(Number(x)))) {
                addRange(val[0], val[1]);
            } else {
                for (const v of val) walk(v);
            }
            return;
        }

        if (typeof val === 'object') {
            for (const k of Object.keys(val)) walk(val[k]);
        }
    };

    walk(raw);
    return [...out].sort((a, b) => a - b);
}
