/** Parse current and historical SillyTavern message timestamps. */
export function timestampMs(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
        const n = Number(value);
        return n >= 0 && Number.isFinite(new Date(n).getTime()) ? n : null;
    }
    if (typeof value === 'string') {
        // Historical ST humanized timestamps represent UTC, including the spaced form.
        const match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s?@(\d{1,2})h\s?(\d{1,2})m\s?(\d{1,2})s(?:\s?(\d{1,3})ms)?$/);
        if (match) {
            const [, y, mo, d, h, mi, s, ms = '0'] = match;
            value = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi.padStart(2, '0')}:${s.padStart(2, '0')}.${ms.padStart(3, '0')}Z`;
        } else {
            // Historical meridiem timestamps have local calendar semantics in the host.
            value = value.replace(/(\d{1,2}:\d{1,2})(am|pm)$/i, '$1 $2');
        }
    }
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
}

/** A date input is a local calendar day; increment using calendar arithmetic for DST. */
export function localDateBoundary(value, nextDay = false) {
    const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const [, y, m, d] = match.map(Number);
    const date = new Date(y, m - 1, d);
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
    if (nextDay) date.setDate(date.getDate() + 1);
    return date.getTime();
}
