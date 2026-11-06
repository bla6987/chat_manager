/** Demand-loaded archive access. No caller needs to retain every chat body. */
import { iterateChatBodies, getMessageEmbedding, getMessageActiveSwipeIndex, getIndex, getIndexCharacterAvatar, readChatMessages } from './chat-reader.js';
import { getEmbeddingSettings } from './metadata-store.js';
import { getCachedEmbeddingsForTexts, captureEmbeddingOperation, isEmbeddingOperationCurrent, hashEmbeddingText } from './embedding-service.js';
import { isVector, toFloat32Vector } from './vector-utils.js';
import { messagePreview } from './message-descriptors.js';
import { getRepresentativeEmbeddingText } from './embedding-text.js';

export function throwIfAborted(signal) {
    if (signal?.aborted) throw signal.reason || new DOMException('Operation cancelled', 'AbortError');
}

/** Keep the host's message/swipe identifiers; never substitute a preview for text. */
export function messageVariants(message, settings = {}, mode = 'active') {
    const active = getMessageActiveSwipeIndex(message);
    const variants = [];
    const activeText = typeof message?.text === 'string' ? message.text : '';
    if (mode !== 'alternate' && activeText.trim()) {
        variants.push({ swipeIndex: active, text: activeText, isActive: true });
    }
    if (mode === 'active' || settings.includeAlternateSwipes !== true) return variants;
    const swipes = Array.isArray(message?.swipes) ? message.swipes : [];
    const configured = Number(settings.maxSwipesPerMessage);
    const limit = Math.min(swipes.length, Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 8);
    for (let index = 0; index < limit; index++) {
        if (index === active || typeof swipes[index] !== 'string' || !swipes[index].trim()) continue;
        variants.push({ swipeIndex: index, text: swipes[index], isActive: false });
    }
    return variants;
}

export async function* iterateMessageVariants(options = {}) {
    const settings = options.settings || getEmbeddingSettings();
    const mode = options.mode || 'active';
    const window = Number(options.messageWindowLimit);
    for await (const { entry, messages } of iterateChatBodies({ fileNames: options.fileNames, signal: options.signal })) {
        throwIfAborted(options.signal);
        const start = Number.isFinite(window) && window > 0 ? Math.max(0, messages.length - Math.floor(window)) : 0;
        for (let index = start; index < messages.length; index++) {
            const msg = messages[index];
            for (const variant of messageVariants(msg, settings, mode)) {
                throwIfAborted(options.signal);
                yield {
                    entry, fileName: entry.fileName, msgIndex: msg.index,
                    swipeIndex: variant.swipeIndex, text: variant.text,
                    activeText: msg.text, activeSwipeIndex: getMessageActiveSwipeIndex(msg),
                    preview: messagePreview(variant.text, 240), role: msg.role,
                    timestamp: msg.timestamp, timestampMs: msg.timestampMs,
                    isActive: variant.isActive,
                };
            }
        }
        options.onProgress?.(entry.fileName);
    }
}

/** Bound temporary text and vector reads, even for an explicit full-archive job. */
export async function* iterateVariantBatches(options = {}) {
    const limit = Math.max(1, Math.min(100, Math.floor(Number(options.batchSize) || 50)));
    const charLimit = Math.max(4096, Number(options.maxBatchChars) || 262144);
    let batch = [];
    let chars = 0;
    for await (const item of iterateMessageVariants(options)) {
        if (batch.length && chars + item.text.length > charLimit) {
            yield batch;
            batch = [];
            chars = 0;
        }
        batch.push(item);
        chars += item.text.length;
        if (batch.length >= limit || chars >= charLimit) {
            yield batch;
            batch = [];
            chars = 0;
        }
    }
    if (batch.length) yield batch;
}

/**
 * Read vectors from the resident cache or IndexedDB without promoting a corpus
 * into RAM. Consumers receive one vector at a time and should retain only IDs,
 * projected coordinates, or a bounded selection of results.
 */
export async function* iterateCachedMessageVectors(options = {}) {
    const operation = options.embeddingOperation || captureEmbeddingOperation();
    const assertCurrent = () => {
        throwIfAborted(options.signal);
        if (!isEmbeddingOperationCurrent(operation)) throw new DOMException('Embedding settings changed', 'AbortError');
    };
    assertCurrent();
    for await (const batch of iterateVariantBatches(options)) {
        assertCurrent();
        const vectors = batch.map(item => getMessageEmbedding(item.entry, { index: item.msgIndex, swipeId: item.activeSwipeIndex }, item.swipeIndex));
        const missing = [];
        for (let index = 0; index < batch.length; index++) if (!isVector(vectors[index])) missing.push(index);
        if (missing.length) {
            const cached = await getCachedEmbeddingsForTexts(missing.map(index => batch[index].text.trim()));
            assertCurrent();
            for (let index = 0; index < missing.length; index++) vectors[missing[index]] = cached[index];
        }
        for (let index = 0; index < batch.length; index++) {
            assertCurrent();
            if (isVector(vectors[index]) && vectors[index].length) yield { ...batch[index], vector: vectors[index] };
        }
    }
    assertCurrent();
}

/**
 * Stream cached chat-level vectors using the same bounded representative text
 * recipe as generation. Cold indexed chats need no body read; unknown/stale
 * catalog entries are hydrated individually before their small text is chosen.
 * The iterator never attaches restored vectors to resident entry caches.
 */
export async function* iterateCachedChatVectors(options = {}) {
    const operation = options.embeddingOperation || captureEmbeddingOperation();
    const avatar = getIndexCharacterAvatar();
    const assertCurrent = () => {
        throwIfAborted(options.signal);
        if (!isEmbeddingOperationCurrent(operation)) throw new DOMException('Embedding settings changed', 'AbortError');
        const context = globalThis.SillyTavern?.getContext?.();
        if (getIndexCharacterAvatar() !== avatar
            || (avatar && context?.characters?.[context.characterId]?.avatar !== avatar)) {
            throw new DOMException('The selected character changed', 'AbortError');
        }
    };
    const assertItemCurrent = item => {
        assertCurrent();
        if (getIndex()[item.fileName] !== item.entry || getRepresentativeEmbeddingText(item.entry) !== item.text) {
            throw new DOMException('Chat content changed', 'AbortError');
        }
    };
    const limit = Math.max(1, Math.min(50, Math.floor(Number(options.batchSize) || 50)));
    const charLimit = Math.max(1, Math.floor(Number(options.maxBatchChars) || 262144));
    const names = Array.isArray(options.fileNames) ? options.fileNames : Object.keys(getIndex());

    async function* readBatch(batch) {
        assertCurrent();
        const vectors = batch.map(item => item.entry.chatEmbeddingHash === item.hash && isVector(item.entry.chatEmbedding)
            ? toFloat32Vector(item.entry.chatEmbedding) : null);
        const missing = [];
        for (let i = 0; i < vectors.length; i++) if (!vectors[i]) missing.push(i);
        if (missing.length) {
            const cached = await getCachedEmbeddingsForTexts(missing.map(i => batch[i].text));
            assertCurrent();
            for (let i = 0; i < missing.length; i++) vectors[missing[i]] = cached[i];
        }
        for (let i = 0; i < batch.length; i++) {
            const item = batch[i];
            assertItemCurrent(item);
            if (isVector(vectors[i])) {
                yield { fileName: item.fileName, vector: vectors[i], hash: item.hash,
                    recipeKey: operation.recipeKey, epoch: operation.epoch };
            }
        }
    }

    assertCurrent();
    let batch = [];
    let chars = 0;
    for (const fileName of names) {
        assertCurrent();
        let entry = getIndex()[fileName];
        if (!entry) continue;
        if (!entry.isLoaded || entry.needsHydration) {
            await readChatMessages(fileName, { signal: options.signal });
            assertCurrent();
            entry = getIndex()[fileName];
            if (!entry) continue;
        }
        const text = getRepresentativeEmbeddingText(entry);
        if (!text) continue;
        if (batch.length && chars + text.length > charLimit) {
            yield* readBatch(batch);
            batch = [];
            chars = 0;
        }
        batch.push({ fileName, entry, text, hash: hashEmbeddingText(text) });
        chars += text.length;
        if (batch.length >= limit || chars >= charLimit) {
            yield* readBatch(batch);
            batch = [];
            chars = 0;
        }
    }
    if (batch.length) yield* readBatch(batch);
    assertCurrent();
}
