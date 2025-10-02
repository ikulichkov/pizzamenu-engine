import mongoosePkg from 'mongoose';

export async function createMongooseAdapter({ mongoUrl, dbName = 'pizza25', connect = false, debug = 0, mongoose = null }) {
    const m = mongoose || mongoosePkg;

    if (connect) {
        if (m.connection.readyState === 0) {
            await m.connect(mongoUrl, { dbName, serverSelectionTimeoutMS: 1500 }).catch(() => {});
        }
    }
    const ready = async () => m?.connection?.readyState === 1;

    const AddressSchema = new m.Schema({
        userId: { type:Number, index:true, required:true },
        addressFull: { type:String, required:true },
        addressJSON: { type:m.Schema.Types.Mixed, required:true },
        createdAt: { type:Date, default:Date.now }
    }, { versionKey:false });
    AddressSchema.index({ userId:1, addressFull:1 }, { unique:true });

    const PhoneSchema = new m.Schema({
        userId: { type:Number, index:true, required:true },
        phone: { type:String, required:true },
        isPrimary: { type:Boolean, default:false },
        createdAt: { type:Date, default:Date.now }
    }, { versionKey:false });
    PhoneSchema.index({ userId:1, phone:1 }, { unique:true });

    const CartSchema = new m.Schema({
        userId: { type:Number, index:true, required:true },
        items: [{
            id: { type:String, required:true },
            name:{ type:String, required:true },
            cost:{ type:Number, required:true },
            count:{ type:Number, required:true }
        }],
        updatedAt: { type:Date, default:Date.now }
    }, { versionKey:false });
    CartSchema.index({ userId:1 }, { unique:true });

    const MenuOrderSchema = new m.Schema({
        parentId:   { type:String, index:true, default:null },
        orderedIds: { type:[String], default:[] },
        hiddenIds:  { type:[String], default:[] },
        updatedAt:  { type:Date, default:Date.now }
    }, { versionKey:false });
    MenuOrderSchema.index({ parentId:1 }, { unique:true });

    const models = m.connection.models;
    const Address   = models.TelegramAddress || m.model('TelegramAddress', AddressSchema);
    const Phone     = models.TelegramPhone   || m.model('TelegramPhone',   PhoneSchema);
    const Cart      = models.TelegramCart    || m.model('TelegramCart',    CartSchema);
    const MenuOrder = models.MenuOrder       || m.model('MenuOrder',       MenuOrderSchema);

    return {
        ready,
        async getAddresses(userId, limit = 6) {
            if (!await ready()) return [];
            return Address.find({ userId }).sort({ createdAt:-1 }).limit(limit).lean().exec();
        },
        async saveAddress(userId, addressFull, addressJSON) {
            if (!await ready()) return;
            await Address.updateOne({ userId, addressFull }, { $setOnInsert: { addressJSON, createdAt:new Date() } }, { upsert:true }).exec().catch(()=>{});
        },
        async savePhone(userId, phone, isPrimary=false) {
            if (!await ready()) return;
            await Phone.updateOne({ userId, phone }, { $setOnInsert: { isPrimary, createdAt:new Date() } }, { upsert:true }).exec().catch(()=>{});
            if (isPrimary) await Phone.updateMany({ userId, phone: { $ne: phone } }, { $set: { isPrimary:false } }).exec().catch(()=>{});
        },
        async loadCart(userId) {
            if (!await ready()) return [];
            const doc = await Cart.findOne({ userId }).lean().exec();
            return Array.isArray(doc?.items) ? doc.items : [];
        },
        async saveCart(userId, items) {
            if (!await ready()) return;
            await Cart.updateOne({ userId }, { $set: { items: Array.isArray(items) ? items : [], updatedAt:new Date() } }, { upsert:true }).exec().catch(()=>{});
        },
        async loadAllMenuOrders() {
            if (!await ready()) return [];
            return MenuOrder.find({}).lean().exec();
        },
        async saveMenuOrder(parentId, orderedIds=[], hiddenIds=[]) {
            if (!await ready()) return;
            await MenuOrder.updateOne({ parentId: parentId == null ? null : String(parentId) },
                { $set: { orderedIds: orderedIds.map(String), hiddenIds: hiddenIds.map(String), updatedAt:new Date() } },
                { upsert:true }).exec().catch(()=>{});
        }
    };
}
