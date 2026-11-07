/**
 * A persistent IndexedDB stand-in for Node tests. Records survive clearIndex() the
 * way real records survive a page reload, and are cloned on the way in and out.
 * The returned state exposes the stores and hooks to hold or fail transactions.
 */
export function installFakeIndexedDB({ schedule = queueMicrotask } = {}) {
    const fake = {
        stores: new Map(),
        indexes: new Map(),
        version: 0,
        requestedVersions: [],
        upgrades: [],
        unavailable: false,
        blocked: false,
        holdWrites: false,
        holdReads: false,
        held: [],
        transactions: [],
        writeTransactions: 0,
        activeWrites: 0,
        peakWrites: 0,
        puts: new Map(),
        onRead: null,
        reset() {
            for (const store of this.stores.values()) store.clear();
            this.transactions = []; this.writeTransactions = 0; this.activeWrites = 0; this.peakWrites = 0;
            this.puts = new Map(); this.onRead = null; this.unavailable = false; this.holdWrites = false; this.holdReads = false;
            this.release();
        },
        release() {
            const held = this.held;
            this.held = [];
            for (const complete of held) complete();
        },
        store(name) {
            if (!this.stores.has(name)) throw new Error(`No object store named ${name}`);
            return this.stores.get(name);
        },
    };

    const database = {
        objectStoreNames: { contains: name => fake.stores.has(name) },
        createObjectStore(name) {
            fake.stores.set(name, new Map());
            fake.upgrades.push(name);
            return { createIndex(indexName, keyPath) { fake.indexes.set(`${name}/${indexName}`, keyPath); } };
        },
        deleteObjectStore(name) { fake.stores.delete(name); fake.upgrades.push(`-${name}`); },
        close() {},
        transaction(names, mode = 'readonly') {
            if (fake.unavailable) throw new Error('Storage blocked');
            const scope = Array.isArray(names) ? names : [names];
            fake.transactions.push({ names: scope, mode });
            if (mode === 'readwrite') {
                fake.writeTransactions++;
                fake.peakWrites = Math.max(fake.peakWrites, ++fake.activeWrites);
            }
            let pending = 0;
            let scheduled = false;
            const tx = {};
            const complete = () => {
                if (mode === 'readwrite') fake.activeWrites--;
                tx.oncomplete?.();
            };
            const settle = () => {
                if (scheduled || pending) return;
                scheduled = true;
                const hold = mode === 'readwrite' ? fake.holdWrites : fake.holdReads;
                if (hold) fake.held.push(complete);
                else schedule(complete);
            };
            const request = produce => {
                const req = {};
                pending++;
                schedule(() => {
                    req.result = structuredClone(produce());
                    req.onsuccess?.();
                    pending--;
                    settle();
                });
                return req;
            };
            tx.objectStore = name => {
                if (!scope.includes(name)) throw new Error(`Store ${name} is outside this transaction`);
                const data = fake.store(name);
                return {
                    get(key) { fake.onRead?.(name, key); return request(() => data.get(key)); },
                    getAll() { return request(() => [...data.values()]); },
                    put(record) {
                        data.set(record.key, structuredClone(record));
                        fake.puts.set(name, (fake.puts.get(name) || 0) + 1);
                    },
                    delete(key) { data.delete(key); },
                    index(indexName) {
                        const keyPath = fake.indexes.get(`${name}/${indexName}`);
                        return { getAll(value) {
                            fake.onRead?.(name, value);
                            return request(() => [...data.values()].filter(record => record[keyPath] === value));
                        } };
                    },
                };
            };
            schedule(settle);
            return tx;
        },
    };

    globalThis.indexedDB = { open(_name, version) {
        fake.requestedVersions.push(version);
        const request = {};
        schedule(() => {
            if (fake.blocked) { request.onblocked?.(); return; }
            if (fake.version < version) {
                request.onupgradeneeded?.({ oldVersion: fake.version, target: { result: database } });
                fake.version = version;
            }
            request.onsuccess?.({ target: { result: database } });
        });
        return request;
    } };
    return fake;
}
