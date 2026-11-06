/** Shared vector representation and byte-budget helpers. */

/** Recognize legacy arrays and numeric typed arrays without rescanning coordinates. */
export function isVector(value) {
    return Boolean(value && typeof value.length === 'number' && value.length > 0
        && (Array.isArray(value) || ArrayBuffer.isView(value))
        && typeof value[0] !== 'bigint');
}

/** Validate coordinates once at the storage boundary and retain compact Float32 data. */
export function toFloat32Vector(value, { copy = false } = {}) {
    if (!isVector(value)) throw new TypeError('Expected a non-empty numeric vector.');
    // A short subarray can otherwise retain a multi-megabyte backing buffer
    // while the resident cache accounts only for its visible coordinates.
    const ownsBuffer = value instanceof Float32Array && value.byteOffset === 0
        && value.byteLength === value.buffer.byteLength;
    const result = ownsBuffer && !copy ? value : new Float32Array(value.length);
    for (let i = 0; i < value.length; i++) {
        if (!Number.isFinite(value[i])) throw new TypeError('Vector coordinates must be finite numbers.');
        if (result !== value) result[i] = value[i];
        if (!Number.isFinite(result[i])) throw new TypeError('Vector coordinate exceeds the Float32 range.');
    }
    return result;
}

/** Exact typed-array payload size; legacy array payload is a conservative double estimate. */
export function vectorByteLength(value) {
    if (!isVector(value)) return 0;
    return ArrayBuffer.isView(value) ? value.byteLength : value.length * 8;
}

/**
 * A hard byte-budget LRU. Values remain owned by callers; onEvict releases their
 * secondary references. Map bookkeeping and key strings are not payload bytes.
 */
export class ByteBudgetLRU {
    constructor({ maxBytes = 64 * 1024 * 1024, onEvict = null } = {}) {
        this.entries = new Map();
        this._bytes = 0;
        this._maxBytes = Math.max(0, Math.floor(Number(maxBytes) || 0));
        this.onEvict = typeof onEvict === 'function' ? onEvict : null;
    }

    get size() { return this.entries.size; }
    get bytes() { return this._bytes; }
    get byteLength() { return this._bytes; }
    get maxBytes() { return this._maxBytes; }
    get capacity() { return this._maxBytes; }
    set maxBytes(value) {
        this._maxBytes = Math.max(0, Math.floor(Number(value) || 0));
        this.trim();
    }

    has(key) { return this.entries.has(key); }
    peek(key) { return this.entries.get(key)?.value; }
    get(key) {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    /** Returns false when one value cannot fit, without retaining it. */
    set(key, value, bytes = vectorByteLength(value)) {
        const size = Math.max(0, Math.ceil(Number(bytes) || 0));
        if (size > this._maxBytes) return false;
        const previous = this.entries.get(key);
        if (previous) {
            this.entries.delete(key);
            this._bytes -= previous.bytes;
            if (previous.value !== value) this.onEvict?.(key, previous.value, 'replace');
        }
        this.entries.set(key, { value, bytes: size });
        this._bytes += size;
        this.trim();
        return this.entries.has(key);
    }

    delete(key, reason = 'delete') {
        const entry = this.entries.get(key);
        if (!entry) return false;
        this.entries.delete(key);
        this._bytes -= entry.bytes;
        this.onEvict?.(key, entry.value, reason);
        return true;
    }

    trim() {
        while (this._bytes > this._maxBytes && this.entries.size) {
            this.delete(this.entries.keys().next().value, 'budget');
        }
    }

    clear() {
        for (const key of this.entries.keys()) this.delete(key, 'clear');
    }
}
