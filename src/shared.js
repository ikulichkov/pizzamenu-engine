// Общие утилиты: stable UUID, нормализация календаря, цена, b64id, телефон.
import crypto from 'crypto';

export const priceLabel = v => `${(Number(v) || 0).toFixed(0)} ₽`;
export const encId = id => Buffer.from(String(id), 'utf8').toString('base64url');
export const decId = s  => { try { return Buffer.from(String(s), 'base64url').toString('utf8'); } catch { return String(s); } };

export function normalizePhone(s) {
    if (!s) return null;
    let p = String(s).replace(/[^\d+]/g, '');
    if (/^8\d{10}$/.test(p)) return `+7${p.slice(1)}`;
    if (/^\+7\d{10}$/.test(p)) return p;
    if (/^7\d{10}$/.test(p)) return `+${p}`;
    return null;
}

export function generateStableUuid(name, namespace='1b671a64-40d5-491e-99b0-da01ff1f3341') {
    const ns = namespace.replace(/-/g,''); const nsBytes = Buffer.from(ns,'hex');
    const nameBytes = Buffer.from(String(name),'utf8');
    const hash = crypto.createHash('sha1').update(nsBytes).update(nameBytes).digest();
    hash[6] = (hash[6] & 0x0f) | 0x50; hash[8] = (hash[8] & 0x3f) | 0x80;
    const b = hash.subarray(0,16); const hex = b.toString('hex');
    return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}

// Нормализация календаря Presto (0..47)
export function normalizeCalendarIntervals(raw) {
    const out = new Set();
    const add = i => { const n = Number(i); if (Number.isInteger(n) && n>=0 && n<=47) out.add(n); };
    const addRange = (a,b) => { let x=+a,y=+b; if (!Number.isFinite(x)||!Number.isFinite(y)) return;
        const s=Math.max(0,Math.min(x,y)), e=Math.min(47,Math.max(x,y)); for (let i=s;i<=e;i++) add(i); };
    const walk = v => {
        if (v==null) return;
        if (typeof v==='number') return add(v);
        if (typeof v==='string') { const s=v.trim(); const m=s.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/); if (m) return addRange(m[1],m[2]); if (s.toLowerCase()==='all') return addRange(0,47); return add(s); }
        if (Array.isArray(v)) { if (v.length===2 && v.every(x=>Number.isFinite(+x))) return addRange(v[0],v[1]); for (const x of v) walk(x); return; }
        if (typeof v==='object') for (const k of Object.keys(v)) walk(v[k]);
    };
    walk(raw);
    return [...out].sort((a,b)=>a-b);
}
