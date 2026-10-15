/**
 * Embedding Service — API dispatch, batching, cache, and settings glue.
 */

const MODULE_NAME = 'chat_manager';
const CACHE_DB_NAME = 'ChatManager_Embeddings';
const CACHE_META_KEY = '__cache_meta__';
const BATCH_SIZE = 100;
const OLLAMA_BATCH_SIZE = 50;

const PROVIDERS = /** @type {const} */ (['openrouter', 'openai', 'ollama']);
const COLOR_MODES = /** @type {const} */ (['structural', 'cluster', 'gradient']);
const EMBEDDING_LEVELS = /** @type {const} */ (['chat', 'message', 'query']);

const DEFAULT_EMBEDDING_SETTINGS = Object.freeze({
    enabled: false,
    provider: 'openrouter',
    apiKey: '',
    ollamaUrl: 'http://localhost:11434',
    model: '',
    dimensions: null,
    colorMode: 'cluster',
    embeddingLevels: {
        chat: false,
        message: false,
        query: false,
    },
    scopeMode: 'all',
    selectedChatsByAvatar: {},
});

function createDefaultEmbeddingSettings() {
    return {
        ...DEFAULT_EMBEDDING_SETTINGS,
        embeddingLevels: { ...DEFAULT_EMBEDDING_SETTINGS.embeddingLevels },
        selectedChatsByAvatar: {},
    };
}

const OPENAI_COMPAT_ENDPOINTS = Object.freeze({
    openrouter: 'https://openrouter.ai/api/v1/embeddings',
    openai: 'https://api.openai.com/v1/embeddings',
});

/** @type {import('localforage')|null} */
let embeddingCache = null;
let embeddingOperationEpoch = 0;
let activeConfigurationKey = null;
let cacheMutationTail = Promise.resolve();
const dimensionsInvalidatedListeners = new Set();

/** Subscribe to confirmed dimension drift, after cache/settings reset. */
export function onEmbeddingDimensionsInvalidated(callback) {
    if (typeof callback !== 'function') throw new TypeError('Dimension invalidation listener must be a function.');
    dimensionsInvalidatedListeners.add(callback);
    return () => dimensionsInvalidatedListeners.delete(callback);
}

function notifyEmbeddingDimensionsInvalidated() {
    for (const callback of dimensionsInvalidatedListeners) {
        try {
            callback();
        } catch (error) {
            console.warn('[chat_manager] Embedding dimension invalidation listener failed:', error);
        }
    }
}

class StaleEmbeddingOperationError extends Error {
    constructor(reason = 'superseded') {
        super('Embedding operation was superseded by a settings change or cache clear.');
        this.name = 'StaleEmbeddingOperationError';
        this.reason = reason;
    }
}

export function isStaleEmbeddingOperationError(error) {
    return error instanceof StaleEmbeddingOperationError;
}

/** Dimensions are learned from responses and must not change recipe identity. */
export function getEmbeddingRecipeKey(settings) {
    const provider = settings.provider;
    const endpoint = provider === 'ollama'
        ? String(settings.ollamaUrl || DEFAULT_EMBEDDING_SETTINGS.ollamaUrl).trim().replace(/\/+$/, '')
        : OPENAI_COMPAT_ENDPOINTS[provider] || '';
    return JSON.stringify([provider, String(settings.model || '').trim(), endpoint]);
}

function synchronizeEmbeddingConfiguration(settings) {
    const configurationKey = JSON.stringify([
        getEmbeddingRecipeKey(settings),
        settings.provider === 'ollama' ? '' : hashEmbeddingText(settings.apiKey || ''),
        settings.enabled === true,
        ...EMBEDDING_LEVELS.map(level => settings.embeddingLevels?.[level] === true),
    ]);
    if (activeConfigurationKey !== configurationKey) {
        activeConfigurationKey = configurationKey;
        embeddingOperationEpoch += 1;
    }
    return configurationKey;
}

export function invalidateEmbeddingOperations() {
    embeddingOperationEpoch += 1;
}

/** Capture before awaiting work; callers must guard transient vector attachments. */
export function captureEmbeddingOperation() {
    const current = ensureEmbeddingSettings();
    const configurationKey = synchronizeEmbeddingConfiguration(current);
    const settings = Object.freeze({
        ...current,
        model: current.model.trim(),
        ollamaUrl: current.ollamaUrl.trim().replace(/\/+$/, ''),
        embeddingLevels: Object.freeze({ ...current.embeddingLevels }),
    });
    return Object.freeze({
        epoch: embeddingOperationEpoch,
        recipeKey: getEmbeddingRecipeKey(settings),
        configurationKey,
        settings,
    });
}

export function isEmbeddingOperationCurrent(operation) {
    const configurationKey = synchronizeEmbeddingConfiguration(ensureEmbeddingSettings());
    return Boolean(operation && operation.epoch === embeddingOperationEpoch
        && operation.configurationKey === configurationKey);
}

function assertEmbeddingOperationCurrent(operation) {
    if (!isEmbeddingOperationCurrent(operation)) throw new StaleEmbeddingOperationError();
}

// A clear waits for writes already issued to IndexedDB. Epoch checks alone cannot
// stop an outstanding setItem from finishing after a concurrent clear.
function mutateEmbeddingCache(mutation) {
    const result = cacheMutationTail.catch(() => {}).then(mutation);
    cacheMutationTail = result.catch(() => {});
    return result;
}

function makeRecipeCacheKey(settings, text) {
    return `${hashEmbeddingText(getEmbeddingRecipeKey(settings))}:${makeTextCacheKey(text)}`;
}

class EmbeddingDimensionMismatchError extends Error {
    /**
     * @param {number} expected
     * @param {number} actual
     */
    constructor(expected, actual) {
        super(`Embedding dimensions mismatch. Expected ${expected}, got ${actual}.`);
        this.name = 'EmbeddingDimensionMismatchError';
        this.expected = expected;
        this.actual = actual;
    }
}

/**
 * Ensure extension settings has the embeddings schema.
 * @returns {typeof DEFAULT_EMBEDDING_SETTINGS}
 */
function ensureEmbeddingSettings() {
    const context = SillyTavern.getContext();
    const extensionSettings = context.extensionSettings;

    let changed = false;

    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = { metadata: {}, displayMode: 'panel' };
        changed = true;
    }

    const moduleSettings = extensionSettings[MODULE_NAME];
    if (!moduleSettings.embeddings || typeof moduleSettings.embeddings !== 'object') {
        moduleSettings.embeddings = createDefaultEmbeddingSettings();
        changed = true;
    }

    const embeddings = moduleSettings.embeddings;
    for (const [key, defaultValue] of Object.entries(DEFAULT_EMBEDDING_SETTINGS)) {
        if (embeddings[key] === undefined) {
            embeddings[key] = (defaultValue && typeof defaultValue === 'object' && !Array.isArray(defaultValue))
                ? { ...defaultValue }
                : defaultValue;
            changed = true;
        }
    }

    if (!PROVIDERS.includes(embeddings.provider)) {
        embeddings.provider = DEFAULT_EMBEDDING_SETTINGS.provider;
        changed = true;
    }

    if (!COLOR_MODES.includes(embeddings.colorMode)) {
        embeddings.colorMode = DEFAULT_EMBEDDING_SETTINGS.colorMode;
        changed = true;
    }
    if (!embeddings.embeddingLevels || typeof embeddings.embeddingLevels !== 'object') {
        embeddings.embeddingLevels = { ...DEFAULT_EMBEDDING_SETTINGS.embeddingLevels };
        changed = true;
    }
    for (const level of EMBEDDING_LEVELS) {
        if (typeof embeddings.embeddingLevels[level] !== 'boolean') {
            embeddings.embeddingLevels[level] = DEFAULT_EMBEDDING_SETTINGS.embeddingLevels[level];
            changed = true;
        }
    }
    if (embeddings.scopeMode !== 'all' && embeddings.scopeMode !== 'selected') {
        embeddings.scopeMode = DEFAULT_EMBEDDING_SETTINGS.scopeMode;
        changed = true;
    }
    if (!embeddings.selectedChatsByAvatar || typeof embeddings.selectedChatsByAvatar !== 'object' || Array.isArray(embeddings.selectedChatsByAvatar)) {
        embeddings.selectedChatsByAvatar = {};
        changed = true;
    }

    if (embeddings.dimensions != null) {
        const dims = Number(embeddings.dimensions);
        if (!Number.isInteger(dims) || dims <= 0) {
            embeddings.dimensions = null;
            changed = true;
        } else if (embeddings.dimensions !== dims) {
            embeddings.dimensions = dims;
            changed = true;
        }
    }

    if (typeof embeddings.model !== 'string') {
        embeddings.model = String(embeddings.model ?? '');
        changed = true;
    }

    if (typeof embeddings.apiKey !== 'string') {
        embeddings.apiKey = String(embeddings.apiKey ?? '');
        changed = true;
    }

    if (typeof embeddings.ollamaUrl !== 'string' || !embeddings.ollamaUrl.trim()) {
        embeddings.ollamaUrl = DEFAULT_EMBEDDING_SETTINGS.ollamaUrl;
        changed = true;
    }

    if (changed) {
        context.saveSettingsDebounced();
    }

    return embeddings;
}

function saveEmbeddingSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

/**
 * @param {unknown} level
 * @returns {level is 'chat'|'message'|'query'}
 */
function isValidEmbeddingLevel(level) {
    return typeof level === 'string' && EMBEDDING_LEVELS.includes(level);
}

/**
 * @param {'chat'|'message'|'query'} level
 * @returns {boolean}
 */
export function isEmbeddingLevelEnabled(level) {
    const settings = ensureEmbeddingSettings();
    if (!settings.enabled) return false;
    if (!isValidEmbeddingLevel(level)) return false;
    return settings.embeddingLevels[level] === true;
}

/**
 * @returns {boolean}
 */
export function hasAnyEmbeddingLevelEnabled() {
    const settings = ensureEmbeddingSettings();
    if (!settings.enabled) return false;
    return EMBEDDING_LEVELS.some(level => settings.embeddingLevels[level] === true);
}

/**
 * @returns {import('localforage')}
 */
function getEmbeddingCache() {
    if (embeddingCache) return embeddingCache;

    const localforage = SillyTavern.libs?.localforage;
    if (!localforage?.createInstance) {
        throw new Error('localforage is unavailable. Cannot use embedding cache.');
    }

    embeddingCache = localforage.createInstance({ name: CACHE_DB_NAME });
    return embeddingCache;
}

/**
 * FNV-1a 32-bit hash for stable content keys.
 * @param {string} input
 * @param {number} [seed]
 * @returns {string}
 */
function fnv1aHash32(input, seed = 0x811c9dc5) {
    let hash = seed >>> 0;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Build a cache key with two independent 32-bit hashes + length.
 * This sharply reduces collision risk compared with a single 32-bit hash.
 * @param {string} text
 * @returns {string}
 */
function makeTextCacheKey(text) {
    const normalized = String(text ?? '');
    const h1 = fnv1aHash32(normalized, 0x811c9dc5);
    const h2 = fnv1aHash32(normalized, 0x9e3779b1);
    return `txt_${h1}${h2}_${normalized.length.toString(16)}`;
}

/**
 * Exported content hash helper used by UI orchestration code.
 * @param {string} text
 * @returns {string}
 */
export function hashEmbeddingText(text) {
    return makeTextCacheKey(String(text ?? ''));
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function getVectorDimensions(value) {
    return Array.isArray(value) ? value.length : 0;
}

/**
 * @param {unknown} vector
 * @returns {number[]}
 */
function validateVector(vector) {
    if (!Array.isArray(vector) || vector.length === 0) {
        throw new Error('Embedding API returned an empty/invalid vector.');
    }
    for (let i = 0; i < vector.length; i++) {
        if (!Number.isFinite(vector[i])) {
            throw new Error('Embedding API returned non-numeric vector values.');
        }
    }
    return vector;
}

/**
 * @param {unknown} payload
 * @returns {string}
 */
function extractErrorMessage(payload) {
    if (!payload || typeof payload !== 'object') return '';
    if (typeof payload.message === 'string') return payload.message;
    if (payload.error && typeof payload.error === 'object' && typeof payload.error.message === 'string') {
        return payload.error.message;
    }
    return '';
}

/**
 * @param {string} url
 * @param {Object} body
 * @param {Object<string, string>} [extraHeaders]
 * @returns {Promise<any>}
 */
async function postJson(url, body, extraHeaders = {}) {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...extraHeaders,
        },
        body: JSON.stringify(body),
    });

    const raw = await response.text();
    let payload = null;
    if (raw) {
        try {
            payload = JSON.parse(raw);
        } catch {
            payload = null;
        }
    }

    if (!response.ok) {
        const detail = extractErrorMessage(payload) || raw.trim().slice(0, 200);
        const error = new Error(detail || `Embedding request failed (${response.status} ${response.statusText})`);
        error.status = response.status;
        throw error;
    }

    return payload;
}

/**
 * @param {'openrouter'|'openai'} provider
 * @param {typeof DEFAULT_EMBEDDING_SETTINGS} settings
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
async function embedOpenAICompatible(provider, settings, texts) {
    const endpoint = OPENAI_COMPAT_ENDPOINTS[provider];
    const payload = await postJson(
        endpoint,
        {
            model: settings.model,
            input: texts,
        },
        {
            Authorization: `Bearer ${settings.apiKey}`,
        },
    );

    if (!Array.isArray(payload?.data)) {
        throw new Error('Embedding API returned unexpected payload format.');
    }

    const ordered = payload.data
        .slice()
        .sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0))
        .map(item => validateVector(item?.embedding));

    if (ordered.length !== texts.length) {
        throw new Error(`Embedding API returned ${ordered.length} vectors for ${texts.length} texts.`);
    }

    return ordered;
}

/**
 * @param {typeof DEFAULT_EMBEDDING_SETTINGS} settings
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function embedOllamaSingle(settings, text) {
    const baseUrl = settings.ollamaUrl.replace(/\/+$/, '');
    const payload = await postJson(`${baseUrl}/api/embeddings`, {
        model: settings.model,
        prompt: text,
    });
    return validateVector(payload?.embedding);
}

/** Only explicit unsupported-route responses disable batching for an endpoint. */
const unsupportedOllamaBatchEndpoints = new Set();

function isUnsupportedOllamaBatchError(error) {
    if (error?.status === 405 || error?.status === 501) return true;
    // A missing model can also produce a 404; it does not identify an old server.
    return error?.status === 404 && /(?:404 page not found|unknown (?:route|endpoint)|(?:route|endpoint) (?:not found|not supported))/i.test(error.message);
}

function isTransientEmbeddingRequestError(error) {
    return error instanceof TypeError || error?.status === 408 || error?.status === 429 || error?.status >= 500;
}

/**
 * @param {typeof DEFAULT_EMBEDDING_SETTINGS} settings
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
async function embedOllamaBatch(settings, texts) {
    const baseUrl = settings.ollamaUrl.replace(/\/+$/, '');
    const payload = await postJson(`${baseUrl}/api/embed`, {
        model: settings.model,
        input: texts,
    });
    if (!Array.isArray(payload?.embeddings) || payload.embeddings.length !== texts.length) {
        throw new Error(`Ollama /api/embed returned ${payload?.embeddings?.length ?? 0} vectors for ${texts.length} texts.`);
    }
    return payload.embeddings.map(v => validateVector(v));
}

/**
 * @param {number} completed
 * @param {number} total
 * @param {(completed:number, total:number)=>void|undefined} onProgress
 */
function notifyProgress(completed, total, onProgress) {
    if (typeof onProgress !== 'function') return;
    try {
        onProgress(completed, total);
    } catch {
        // Ignore progress callback errors so embedding flow can continue.
    }
}

/**
 * @param {number} dims
 * @param {{ expected: number|null, observed: number|null }} state
 */
function updateDimensionState(dims, state) {
    if (!state.observed) {
        state.observed = dims;
    } else if (state.observed !== dims) {
        throw new Error(`Embedding provider returned mixed dimensions (${state.observed} vs ${dims}).`);
    }

    if (state.expected != null && dims !== state.expected) {
        throw new EmbeddingDimensionMismatchError(state.expected, dims);
    }
}

/**
 * Determine if we can safely reuse a cached vector.
 * @param {any} cachedValue
 * @param {typeof DEFAULT_EMBEDDING_SETTINGS} settings
 * @param {number|null} expectedDims
 * @param {string} text
 * @returns {cachedValue is { vector: number[], dims: number, model: string, provider?: string, text: string }}
 */
function isUsableCacheEntry(cachedValue, settings, expectedDims, text) {
    if (!cachedValue || typeof cachedValue !== 'object') return false;
    if (cachedValue.model !== settings.model) return false;
    if (cachedValue.provider !== settings.provider) return false;
    if (cachedValue.recipeKey !== getEmbeddingRecipeKey(settings)) return false;
    // Require exact text match to prevent accidental hash collision reuse.
    if (typeof cachedValue.text !== 'string' || cachedValue.text !== text) return false;
    if (!Array.isArray(cachedValue.vector) || cachedValue.vector.length === 0) return false;
    if (!Number.isInteger(cachedValue.dims) || cachedValue.dims <= 0) return false;
    if (cachedValue.dims !== cachedValue.vector.length) return false;
    if (expectedDims != null && cachedValue.dims !== expectedDims) return false;
    return true;
}

/**
 * Read a cached embedding vector for text if compatible with current settings.
 * @param {string} text
 * @returns {Promise<number[]|null>}
 */
export async function getCachedEmbeddingForText(text) {
    const operation = captureEmbeddingOperation();
    const settings = operation.settings;
    const normalizedText = String(text ?? '');
    const expectedDims = Number.isInteger(settings.dimensions) && settings.dimensions > 0
        ? settings.dimensions
        : null;

    const cache = getEmbeddingCache();
    const key = makeRecipeCacheKey(settings, normalizedText);
    await cacheMutationTail;
    const cached = await cache.getItem(key);
    assertEmbeddingOperationCurrent(operation);
    if (!isUsableCacheEntry(cached, settings, expectedDims, normalizedText)) {
        return null;
    }
    return cached.vector;
}

/**
 * Parallel cache lookups in chunks to avoid overwhelming IndexedDB.
 * @param {import('localforage')} cache
 * @param {{hash:string, text:string}[]} items
 * @param {number} [concurrency]
 * @param {(value:object|null, item:{hash:string,text:string}, index:number)=>any} [project]
 * @returns {Promise<any[]>}
 */
async function batchCacheGet(cache, items, concurrency = 50, project = value => value) {
    const results = new Array(items.length);
    for (let i = 0; i < items.length; i += concurrency) {
        const chunk = items.slice(i, i + concurrency);
        const values = await Promise.all(chunk.map(item => cache.getItem(item.hash)));
        for (let j = 0; j < chunk.length; j++) {
            results[i + j] = project(values[j], chunk[j], i + j);
        }
    }
    return results;
}

/**
 * Batch version of getCachedEmbeddingForText — reads many entries in parallel.
 * @param {string[]} texts
 * @returns {Promise<(number[]|null)[]>}
 */
export async function getCachedEmbeddingsForTexts(texts) {
    const operation = captureEmbeddingOperation();
    const settings = operation.settings;
    const expectedDims = Number.isInteger(settings.dimensions) && settings.dimensions > 0
        ? settings.dimensions
        : null;

    const cache = getEmbeddingCache();
    const items = texts.map(t => {
        const normalized = String(t ?? '');
        return { hash: makeRecipeCacheKey(settings, normalized), text: normalized };
    });
    await cacheMutationTail;
    const vectors = await batchCacheGet(cache, items, 50, (value, item) =>
        isUsableCacheEntry(value, settings, expectedDims, item.text) ? value.vector : null,
    );
    assertEmbeddingOperationCurrent(operation);
    return vectors;
}

/**
 * Provider dispatch + batching + cache.
 * @param {string[]} texts
 * @param {{ level?: 'chat'|'message'|'query', onProgress?: (completed:number, total:number)=>void }} [options]
 * @returns {Promise<number[][]>}
 */
export async function embedTexts(texts, options = {}) {
    if (!Array.isArray(texts)) {
        throw new Error('embedTexts(texts) expects an array of strings.');
    }

    const normalizedTexts = texts.map(text => String(text ?? ''));
    const total = normalizedTexts.length;
    if (total === 0) return [];

    const operation = captureEmbeddingOperation();
    const settings = operation.settings;
    if (!isEmbeddingConfigured()) {
        throw new Error('Embeddings are not configured. Set provider/model (and API key for cloud providers).');
    }
    if (!isValidEmbeddingLevel(options.level)) {
        throw new Error('embedTexts requires options.level to be one of: chat, message, query.');
    }
    if (!isEmbeddingLevelEnabled(options.level)) {
        throw new Error(`Embedding level "${options.level}" is disabled.`);
    }

    const provider = settings.provider;
    const onProgress = options.onProgress;
    const cache = getEmbeddingCache();

    // Recipe namespaces make old model/server caches harmless. Settings UI owns
    // any user-requested clearing; generating never clears another recipe.
    await cacheMutationTail;
    assertEmbeddingOperationCurrent(operation);

    const vectors = new Array(total);
    let completed = 0;
    notifyProgress(completed, total, onProgress);

    /** @type {Map<string, {hash:string, text:string, indices:number[]}>} */
    const uniqueByText = new Map();
    for (let i = 0; i < normalizedTexts.length; i++) {
        const text = normalizedTexts[i];
        const hash = makeRecipeCacheKey(settings, text);
        const existing = uniqueByText.get(text);
        if (existing) {
            existing.indices.push(i);
        } else {
            uniqueByText.set(text, { hash, text, indices: [i] });
        }
    }

    /** @type {{hash:string, text:string, indices:number[]}[]} */
    const pending = [];
    const dimensionState = {
        expected: Number.isInteger(settings.dimensions) && settings.dimensions > 0 ? settings.dimensions : null,
        observed: null,
    };

    const uniqueItems = [...uniqueByText.values()];
    const cachedValues = await batchCacheGet(cache, uniqueItems);
    assertEmbeddingOperationCurrent(operation);
    for (let ci = 0; ci < uniqueItems.length; ci++) {
        const item = uniqueItems[ci];
        const cached = cachedValues[ci];
        if (isUsableCacheEntry(cached, settings, dimensionState.expected, item.text)) {
            updateDimensionState(cached.dims, dimensionState);
            for (const idx of item.indices) {
                vectors[idx] = cached.vector;
            }
            completed += item.indices.length;
        } else {
            pending.push(item);
        }
    }
    notifyProgress(completed, total, onProgress);

    try {
        const batchSize = provider === 'ollama' ? OLLAMA_BATCH_SIZE : BATCH_SIZE;
        for (let i = 0; i < pending.length; i += batchSize) {
            assertEmbeddingOperationCurrent(operation);
            const batch = pending.slice(i, i + batchSize);
            await sleep(0);
            assertEmbeddingOperationCurrent(operation);
            let batchVectors;
            if (provider === 'ollama') {
                const endpoint = settings.ollamaUrl;
                if (!unsupportedOllamaBatchEndpoints.has(endpoint)) {
                    for (let attempt = 0; attempt < 2; attempt++) {
                        try {
                            batchVectors = await embedOllamaBatch(settings, batch.map(item => item.text));
                            break;
                        } catch (error) {
                            assertEmbeddingOperationCurrent(operation);
                            if (isUnsupportedOllamaBatchError(error)) {
                                unsupportedOllamaBatchEndpoints.add(endpoint);
                                break;
                            }
                            if (attempt > 0 || !isTransientEmbeddingRequestError(error)) throw error;
                            await sleep(150);
                            assertEmbeddingOperationCurrent(operation);
                        }
                    }
                }
                if (!batchVectors) {
                    batchVectors = [];
                    for (const item of batch) {
                        assertEmbeddingOperationCurrent(operation);
                        batchVectors.push(await embedOllamaSingle(settings, item.text));
                    }
                }
            } else {
                batchVectors = await embedOpenAICompatible(provider, settings, batch.map(item => item.text));
            }
            assertEmbeddingOperationCurrent(operation);
            // Validate the entire batch before scheduling any persistent writes.
            for (const vector of batchVectors) {
                updateDimensionState(getVectorDimensions(vector), dimensionState);
            }
            await mutateEmbeddingCache(async () => {
                assertEmbeddingOperationCurrent(operation);
                const writes = await Promise.allSettled(batch.map((item, j) => cache.setItem(item.hash, {
                    vector: batchVectors[j],
                    dims: batchVectors[j].length,
                    model: settings.model,
                    provider,
                    recipeKey: operation.recipeKey,
                    text: item.text,
                })));
                const failedWrite = writes.find(result => result.status === 'rejected');
                if (failedWrite) throw failedWrite.reason;
            });
            assertEmbeddingOperationCurrent(operation);
            for (let j = 0; j < batch.length; j++) {
                for (const idx of batch[j].indices) vectors[idx] = batchVectors[j];
                completed += batch[j].indices.length;
            }
            notifyProgress(completed, total, onProgress);
        }
    } catch (error) {
        if (error instanceof EmbeddingDimensionMismatchError) {
            assertEmbeddingOperationCurrent(operation);
            await clearEmbeddingCache();
            const nextOperation = captureEmbeddingOperation();
            if (nextOperation.configurationKey !== operation.configurationKey) throw new StaleEmbeddingOperationError();
            const current = ensureEmbeddingSettings();
            current.dimensions = null;
            saveEmbeddingSettings();
            notifyEmbeddingDimensionsInvalidated();
            if (typeof toastr !== 'undefined') {
                toastr.warning('Embedding dimensions changed. Cached vectors were cleared.');
            }
            // The caller's attachment token is now stale. Retry from a fresh UI
            // operation instead of returning vectors that its guard must drop.
            throw new StaleEmbeddingOperationError('dimensions');
        }
        throw error;
    }

    assertEmbeddingOperationCurrent(operation);
    const finalDims = dimensionState.expected ?? dimensionState.observed;
    const current = ensureEmbeddingSettings();
    if (finalDims && current.dimensions !== finalDims) {
        current.dimensions = finalDims;
        saveEmbeddingSettings();
    }

    await mutateEmbeddingCache(() => {
        assertEmbeddingOperationCurrent(operation);
        return cache.setItem(CACHE_META_KEY, {
            provider,
            model: settings.model,
            recipeKey: operation.recipeKey,
            dimensions: finalDims ?? null,
        });
    });
    assertEmbeddingOperationCurrent(operation);

    return /** @type {number[][]} */ (vectors);
}

/**
 * Convenience helper for single-text embedding.
 * @param {string} text
 * @param {{ level?: 'chat'|'message'|'query', onProgress?: (completed:number, total:number)=>void }} [options]
 * @returns {Promise<number[]>}
 */
export async function embedText(text, options = {}) {
    const vectors = await embedTexts([String(text ?? '')], options);
    return vectors[0];
}

/**
 * @returns {boolean}
 */
export function isEmbeddingConfigured() {
    const settings = ensureEmbeddingSettings();
    const provider = settings.provider;
    const model = settings.model.trim();
    if (!PROVIDERS.includes(provider)) return false;
    if (!model) return false;
    if (provider === 'ollama') return true;
    return !!settings.apiKey.trim();
}

/**
 * @returns {number|null}
 */
export function getEmbeddingDimensions() {
    const settings = ensureEmbeddingSettings();
    return Number.isInteger(settings.dimensions) && settings.dimensions > 0 ? settings.dimensions : null;
}

export async function clearEmbeddingCache() {
    invalidateEmbeddingOperations();
    const cache = getEmbeddingCache();
    await mutateEmbeddingCache(() => cache.clear());
}

/**
 * Persist current provider/model in cache metadata without clearing vectors.
 * Used when the user opts to keep existing cache despite a model/provider change.
 * @param {string} provider
 * @param {string} model
 * @returns {Promise<void>}
 */
export async function acknowledgeEmbeddingModelChange(provider, model) {
    const cache = getEmbeddingCache();
    const operation = captureEmbeddingOperation();
    const settings = operation.settings;
    if (provider !== settings.provider || String(model ?? '').trim() !== settings.model) return;
    await mutateEmbeddingCache(() => {
        assertEmbeddingOperationCurrent(operation);
        return cache.setItem(CACHE_META_KEY, {
            provider: String(provider ?? ''),
            model: settings.model,
            dimensions: null,
            recipeKey: operation.recipeKey,
        });
    });
}

/**
 * @returns {Promise<{ count: number, estimatedSizeKB: number }>}
 */
export async function getCacheStats() {
    const cache = getEmbeddingCache();
    let count = 0;
    let estimatedBytes = 0;

    await cache.iterate((value, key) => {
        if (key === CACHE_META_KEY) return;
        if (value && typeof value === 'object' && Array.isArray(value.vector)) {
            count += 1;
            estimatedBytes += (value.vector.length * 4) + (value.model ? value.model.length * 2 : 0) + 32;
            return;
        }
        // Fallback rough JSON estimate for unknown values.
        try {
            estimatedBytes += JSON.stringify(value).length * 2;
        } catch {
            // Ignore non-serializable values.
        }
    });

    return {
        count,
        estimatedSizeKB: Math.round((estimatedBytes / 1024) * 10) / 10,
    };
}
