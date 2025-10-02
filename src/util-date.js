// Время и слоты: только Intl API. Источник подхода: варианты 3/4. (без luxon)
function toTZParts(date, timeZone) {
    const fmt = new Intl.DateTimeFormat('ru-RU', {
        timeZone, year:'numeric', month:'2-digit', day:'2-digit',
        hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
    });
    const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
    return {
        y: +parts.year, m:+parts.month, d:+parts.day,
        H:+parts.hour, M:+parts.minute, S:+parts.second
    };
}

export function nowTZMinutesSinceMidnight(timeZone) {
    const p = toTZParts(new Date(), timeZone);
    return p.H * 60 + p.M;
}

export function slotLabel(halfHourIndex) {
    const idx = Number(halfHourIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx > 47) return '—';
    const start = 30 + idx * 30;
    const h = Math.floor(start / 60), m = start % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

export function toLocalPrestoDate(dateStr, halfHourIndex) {
    const idx = Number(halfHourIndex);
    const base = 30 + (Number.isInteger(idx) ? idx * 30 : 0);
    const h = Math.floor(base / 60), m = base % 60;
    return `${dateStr} ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`;
}

export function isTodayInTZ(isoYYYYMMDD, timeZone) {
    const p = toTZParts(new Date(), timeZone);
    const s = `${String(p.y).padStart(4,'0')}-${String(p.m).padStart(2,'0')}-${String(p.d).padStart(2,'0')}`;
    return s === isoYYYYMMDD;
}

export function humanDateShort(isoYYYYMMDD, timeZone) {
    const [Y,M,D] = isoYYYYMMDD.split('-').map(Number);
    const dt = new Date(Date.UTC(Y, M - 1, D));
    return new Intl.DateTimeFormat('ru-RU', { timeZone, day:'2-digit', month:'2-digit', weekday:'short' })
        .format(dt).replace(',', '');
}
