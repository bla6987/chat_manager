/**
 * Metadata Store — Read/write display names, summaries, cached titles, tags, filter/sort state.
 * All data stored in extensionSettings.chat_manager keyed by character avatar where appropriate.
 */

const MODULE_NAME = 'chat_manager';

const DEFAULT_TAG_DEFINITIONS = {
    tag_canon: { id: 'tag_canon', name: 'Canon', color: '#4CAF50', textColor: '#FFFFFF' },
    tag_experimental: { id: 'tag_experimental', name: 'Experimental', color: '#FF9800', textColor: '#FFFFFF' },
    tag_favorite: { id: 'tag_favorite', name: 'Favorite', color: '#E91E63', textColor: '#FFFFFF' },
    tag_archived: { id: 'tag_archived', name: 'Archived', color: '#9E9E9E', textColor: '#FFFFFF' },
};

const DEFAULT_FILTER_STATE = { tags: [], dateFrom: null, dateTo: null, messageCountMin: null, messageCountMax: null };
const DEFAULT_SORT_STATE = { field: 'recency', direction: 'desc' };
const DEFAULT_EMBEDDING_LEVELS = {
    chat: false,
    message: false,
    query: false,
};
const DEFAULT_EMBEDDING_SETTINGS = {
    enabled: false,
    provider: 'openrouter',
    apiKey: '',
    ollamaUrl: 'http://localhost:11434',
    model: '',
    dimensions: null,
    colorMode: 'cluster',
    mapEnabled: true,
    mapLodMode: 'auto',
    mapPointSize: 2.5,
    mapSimilarityChannel: 'both',
    embeddingLevels: { ...DEFAULT_EMBEDDING_LEVELS },
    scopeMode: 'all',
    selectedChatsByAvatar: {},
    includeAlternateSwipes: false,
    maxSwipesPerMessage: 8,
    swipeBackgroundBatchSize: 24,
    swipeBackgroundDelayMs: 650,
};

function createDefaultEmbeddingSettings() {
    return {
        ...DEFAULT_EMBEDDING_SETTINGS,
        embeddingLevels: { ...DEFAULT_EMBEDDING_SETTINGS.embeddingLevels },
        selectedChatsByAvatar: {},
    };
}

/**
 * Ensure the settings structure exists.
 */
function ensureSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = { metadata: {}, displayMode: 'panel' };
    }
    if (!extensionSettings[MODULE_NAME].metadata) {
        extensionSettings[MODULE_NAME].metadata = {};
    }
    if (!extensionSettings[MODULE_NAME].displayMode) {
        extensionSettings[MODULE_NAME].displayMode = 'panel';
    }
    if (!extensionSettings[MODULE_NAME].tagDefinitions) {
        extensionSettings[MODULE_NAME].tagDefinitions = { ...DEFAULT_TAG_DEFINITIONS };
    }
    if (!extensionSettings[MODULE_NAME].filterState) {
        extensionSettings[MODULE_NAME].filterState = { ...DEFAULT_FILTER_STATE };
    }
    if (!extensionSettings[MODULE_NAME].sortState) {
        extensionSettings[MODULE_NAME].sortState = { ...DEFAULT_SORT_STATE };
    }
    if (extensionSettings[MODULE_NAME].aiConnectionProfile === undefined) {
        extensionSettings[MODULE_NAME].aiConnectionProfile = '';
    }
    if (!extensionSettings[MODULE_NAME].embeddings || typeof extensionSettings[MODULE_NAME].embeddings !== 'object') {
        extensionSettings[MODULE_NAME].embeddings = createDefaultEmbeddingSettings();
    }
    normalizeEmbeddingSettings(extensionSettings[MODULE_NAME].embeddings);
}

/**
 * Normalize embedding settings in-place.
 * @param {Object} embeddings
 */
function normalizeEmbeddingSettings(embeddings) {
    if (!embeddings || typeof embeddings !== 'object') return;

    const providers = new Set(['openrouter', 'openai', 'ollama']);
    const colorModes = new Set(['structural', 'cluster', 'gradient']);
    const scopeModes = new Set(['all', 'selected']);
    const mapLodModes = new Set(['auto', 'points', 'density']);
    const mapSimilarityChannels = new Set(['alpha', 'size', 'both']);

    if (typeof embeddings.enabled !== 'boolean') embeddings.enabled = !!embeddings.enabled;
    if (!providers.has(embeddings.provider)) embeddings.provider = DEFAULT_EMBEDDING_SETTINGS.provider;
    if (typeof embeddings.apiKey !== 'string') embeddings.apiKey = String(embeddings.apiKey ?? '');
    if (typeof embeddings.ollamaUrl !== 'string' || !embeddings.ollamaUrl.trim()) {
        embeddings.ollamaUrl = DEFAULT_EMBEDDING_SETTINGS.ollamaUrl;
    }
    if (typeof embeddings.model !== 'string') embeddings.model = String(embeddings.model ?? '');
    if (!colorModes.has(embeddings.colorMode)) embeddings.colorMode = DEFAULT_EMBEDDING_SETTINGS.colorMode;
    if (typeof embeddings.mapEnabled !== 'boolean') embeddings.mapEnabled = !!embeddings.mapEnabled;
    if (!mapLodModes.has(embeddings.mapLodMode)) embeddings.mapLodMode = DEFAULT_EMBEDDING_SETTINGS.mapLodMode;
    if (!mapSimilarityChannels.has(embeddings.mapSimilarityChannel)) embeddings.mapSimilarityChannel = DEFAULT_EMBEDDING_SETTINGS.mapSimilarityChannel;
    const mapPointSize = Number(embeddings.mapPointSize);
    embeddings.mapPointSize = Number.isFinite(mapPointSize)
        ? Math.max(1, Math.min(8, mapPointSize))
        : DEFAULT_EMBEDDING_SETTINGS.mapPointSize;
    if (embeddings.dimensions != null) {
        const dims = Number(embeddings.dimensions);
        embeddings.dimensions = Number.isInteger(dims) && dims > 0 ? dims : null;
    }
    if (!embeddings.embeddingLevels || typeof embeddings.embeddingLevels !== 'object') {
        embeddings.embeddingLevels = { ...DEFAULT_EMBEDDING_LEVELS };
    }
    for (const [key, defaultValue] of Object.entries(DEFAULT_EMBEDDING_LEVELS)) {
        if (typeof embeddings.embeddingLevels[key] !== 'boolean') {
            embeddings.embeddingLevels[key] = defaultValue;
        }
    }
    if (!scopeModes.has(embeddings.scopeMode)) {
        embeddings.scopeMode = DEFAULT_EMBEDDING_SETTINGS.scopeMode;
    }
    if (!embeddings.selectedChatsByAvatar || typeof embeddings.selectedChatsByAvatar !== 'object' || Array.isArray(embeddings.selectedChatsByAvatar)) {
        embeddings.selectedChatsByAvatar = {};
    }
    for (const [avatar, value] of Object.entries(embeddings.selectedChatsByAvatar)) {
        if (!Array.isArray(value)) {
            delete embeddings.selectedChatsByAvatar[avatar];
            continue;
        }
        const normalized = value
            .filter(fileName => typeof fileName === 'string' && fileName.trim().length > 0)
            .map(fileName => fileName.trim());
        embeddings.selectedChatsByAvatar[avatar] = Array.from(new Set(normalized));
    }

    if (typeof embeddings.includeAlternateSwipes !== 'boolean') {
        embeddings.includeAlternateSwipes = DEFAULT_EMBEDDING_SETTINGS.includeAlternateSwipes;
    }

    const maxSwipesPerMessage = Number(embeddings.maxSwipesPerMessage);
    embeddings.maxSwipesPerMessage = Number.isFinite(maxSwipesPerMessage)
        ? Math.max(1, Math.min(64, Math.floor(maxSwipesPerMessage)))
        : DEFAULT_EMBEDDING_SETTINGS.maxSwipesPerMessage;

    const swipeBackgroundBatchSize = Number(embeddings.swipeBackgroundBatchSize);
    embeddings.swipeBackgroundBatchSize = Number.isFinite(swipeBackgroundBatchSize)
        ? Math.max(1, Math.min(256, Math.floor(swipeBackgroundBatchSize)))
        : DEFAULT_EMBEDDING_SETTINGS.swipeBackgroundBatchSize;

    const swipeBackgroundDelayMs = Number(embeddings.swipeBackgroundDelayMs);
    embeddings.swipeBackgroundDelayMs = Number.isFinite(swipeBackgroundDelayMs)
        ? Math.max(100, Math.min(5000, Math.floor(swipeBackgroundDelayMs)))
        : DEFAULT_EMBEDDING_SETTINGS.swipeBackgroundDelayMs;
}

/**
 * Get the character key (avatar) for the current character.
 * @returns {string|null}
 */
function getCharacterKey() {
    const context = SillyTavern.getContext();
    if (context.characterId === undefined) return null;
    const character = context.characters[context.characterId];
    return character ? character.avatar : null;
}

/**
 * Get metadata for a specific chat file.
 * @param {string} fileName - The chat filename
 * @param {string} [charKey] - Optional character key override
 * @returns {Object} Metadata object (may be empty)
 */
export function getChatMeta(fileName, charKey) {
    ensureSettings();
    const key = charKey || getCharacterKey();
    if (!key) return {};

    const { extensionSettings } = SillyTavern.getContext();
    const charMeta = extensionSettings[MODULE_NAME].metadata[key];
    if (!charMeta || !charMeta[fileName]) return {};

    return charMeta[fileName];
}

/**
 * Set metadata for a specific chat file.
 * @param {string} fileName - The chat filename
 * @param {Object} data - Key/value pairs to merge into the metadata
 * @param {string} [charKey] - Optional character key override
 */
export function setChatMeta(fileName, data, charKey) {
    ensureSettings();
    const key = charKey || getCharacterKey();
    if (!key) return;

    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();

    if (!extensionSettings[MODULE_NAME].metadata[key]) {
        extensionSettings[MODULE_NAME].metadata[key] = {};
    }

    if (!extensionSettings[MODULE_NAME].metadata[key][fileName]) {
        extensionSettings[MODULE_NAME].metadata[key][fileName] = {};
    }

    Object.assign(extensionSettings[MODULE_NAME].metadata[key][fileName], data);
    saveSettingsDebounced();
}

/**
 * Get the display name for a chat file.
 * @param {string} fileName
 * @returns {string} Display name or empty string (caller should fall back to filename)
 */
export function getDisplayName(fileName) {
    const meta = getChatMeta(fileName);
    return meta.displayName || '';
}

/**
 * Set the display name for a chat file.
 * @param {string} fileName
 * @param {string} displayName
 */
export function setDisplayName(fileName, displayName) {
    setChatMeta(fileName, {
        displayName,
        titleEditedByUser: true,
    });
}

/**
 * Get the summary for a chat file.
 * @param {string} fileName
 * @returns {string}
 */
export function getSummary(fileName) {
    const meta = getChatMeta(fileName);
    return meta.summary || '';
}

/**
 * Set the summary for a chat file.
 * @param {string} fileName
 * @param {string} summary
 * @param {boolean} [editedByUser=false]
 */
export function setSummary(fileName, summary, editedByUser = false) {
    setChatMeta(fileName, {
        summary,
        summaryEditedByUser: editedByUser,
    });
}

/**
 * When a file is renamed, migrate its metadata to the new key.
 * @param {string} oldFileName
 * @param {string} newFileName
 */
export function migrateFileKey(oldFileName, newFileName) {
    ensureSettings();
    const key = getCharacterKey();
    if (!key) return;

    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    const charMeta = extensionSettings[MODULE_NAME].metadata[key];
    const embeddings = extensionSettings[MODULE_NAME].embeddings;
    const selected = embeddings?.selectedChatsByAvatar?.[key];
    let updatedSelection = false;

    if (Array.isArray(selected)) {
        const idx = selected.indexOf(oldFileName);
        if (idx !== -1) {
            selected[idx] = newFileName;
            embeddings.selectedChatsByAvatar[key] = Array.from(new Set(selected));
            updatedSelection = true;
        }
    }

    if (!charMeta) {
        if (updatedSelection) saveSettingsDebounced();
        return;
    }

    if (charMeta[oldFileName]) {
        charMeta[newFileName] = { ...charMeta[oldFileName] };
        delete charMeta[oldFileName];
        saveSettingsDebounced();
    } else if (updatedSelection) {
        saveSettingsDebounced();
    }
}

/**
 * Get all metadata for the current character.
 * @returns {Object} Map of fileName -> metadata
 */
export function getAllChatMeta() {
    ensureSettings();
    const key = getCharacterKey();
    if (!key) return {};

    const { extensionSettings } = SillyTavern.getContext();
    return extensionSettings[MODULE_NAME].metadata[key] || {};
}

/**
 * Get the current display mode ('panel' or 'popup').
 * @returns {string}
 */
export function getDisplayMode() {
    ensureSettings();
    const { extensionSettings } = SillyTavern.getContext();
    return extensionSettings[MODULE_NAME].displayMode || 'panel';
}

/**
 * Set the display mode ('panel' or 'popup').
 * @param {string} mode
 */
export function setDisplayMode(mode) {
    ensureSettings();
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    extensionSettings[MODULE_NAME].displayMode = mode;
    saveSettingsDebounced();
}

/**
 * Get the branch context injection preference (defaults to false).
 * @returns {boolean}
 */
export function getBranchContextEnabled() {
    ensureSettings();
    const { extensionSettings } = SillyTavern.getContext();
    return extensionSettings[MODULE_NAME].branchContextEnabled === true;
}

/**
 * Set the branch context injection preference.
 * @param {boolean} active
 */
export function setBranchContextEnabled(active) {
    ensureSettings();
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    extensionSettings[MODULE_NAME].branchContextEnabled = active;
    saveSettingsDebounced();
}

/**
 * Get the AI connection profile ID (empty string = use current connection).
 * @returns {string}
 */
export function getAIConnectionProfile() {
    ensureSettings();
    const { extensionSettings } = SillyTavern.getContext();
    return extensionSettings[MODULE_NAME].aiConnectionProfile || '';
}

/**
 * Set the AI connection profile ID.
 * @param {string} profileId - Profile ID or empty string for current connection
 */
export function setAIConnectionProfile(profileId) {
    ensureSettings();
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    extensionSettings[MODULE_NAME].aiConnectionProfile = profileId || '';
    saveSettingsDebounced();
}

/**
 * Get the thread focus preference (defaults to true).
 * @returns {boolean}
 */
export function getThreadFocus() {
    ensureSettings();
    const { extensionSettings } = SillyTavern.getContext();
    return extensionSettings[MODULE_NAME].threadFocus !== false;
}

/**
 * Set the thread focus preference.
 * @param {boolean} active
 */
export function setThreadFocus(active) {
    ensureSettings();
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    extensionSettings[MODULE_NAME].threadFocus = active;
    saveSettingsDebounced();
}

// ──────────────────────────────────────────────
//  Tag Definitions (global)
// ──────────────────────────────────────────────

function getSettings() {
    ensureSettings();
    return SillyTavern.getContext().extensionSettings[MODULE_NAME];
}

function save() {
    SillyTavern.getContext().saveSettingsDebounced();
}

/**
 * Generate a tag ID from a name.
 * @param {string} name
 * @returns {string}
 */
function makeTagId(name) {
    return 'tag_' + name.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

/**
 * @returns {Object} Map of tagId -> { id, name, color, textColor }
 */
export function getTagDefinitions() {
    return getSettings().tagDefinitions;
}

/**
 * Create a new tag definition.
 * @param {string} name
 * @param {string} [color='#607D8B']
 * @param {string} [textColor='#FFFFFF']
 * @returns {{ id: string, name: string, color: string, textColor: string } | null} The created tag, or null if duplicate
 */
export function createTagDefinition(name, color = '#607D8B', textColor = '#FFFFFF') {
    const settings = getSettings();
    const id = makeTagId(name);
    if (settings.tagDefinitions[id]) return null;
    settings.tagDefinitions[id] = { id, name, color, textColor };
    save();
    return settings.tagDefinitions[id];
}

/**
 * Update an existing tag definition.
 * @param {string} tagId
 * @param {Object} updates - Partial { name, color, textColor }
 */
export function updateTagDefinition(tagId, updates) {
    const settings = getSettings();
    if (!settings.tagDefinitions[tagId]) return;
    Object.assign(settings.tagDefinitions[tagId], updates);
    save();
}

/**
 * Delete a tag definition. Cascades removal from all per-chat tags and active filter.
 * @param {string} tagId
 */
export function deleteTagDefinition(tagId) {
    const settings = getSettings();
    delete settings.tagDefinitions[tagId];

    // Cascade: remove from all per-chat metadata for all characters
    for (const charMeta of Object.values(settings.metadata)) {
        for (const fileMeta of Object.values(charMeta)) {
            if (Array.isArray(fileMeta.tags)) {
                const idx = fileMeta.tags.indexOf(tagId);
                if (idx !== -1) fileMeta.tags.splice(idx, 1);
            }
        }
    }

    // Cascade: remove from active filter
    if (Array.isArray(settings.filterState.tags)) {
        const idx = settings.filterState.tags.indexOf(tagId);
        if (idx !== -1) settings.filterState.tags.splice(idx, 1);
    }

    save();
}

// ──────────────────────────────────────────────
//  Per-Chat Tags
// ──────────────────────────────────────────────

/**
 * Get tags for a chat file.
 * @param {string} fileName
 * @returns {string[]}
 */
export function getChatTags(fileName) {
    const meta = getChatMeta(fileName);
    return Array.isArray(meta.tags) ? meta.tags : [];
}

/**
 * Add a tag to a chat file.
 * @param {string} fileName
 * @param {string} tagId
 */
export function addChatTag(fileName, tagId) {
    const tags = getChatTags(fileName);
    if (tags.includes(tagId)) return;
    tags.push(tagId);
    setChatMeta(fileName, { tags });
}

/**
 * Remove a tag from a chat file.
 * @param {string} fileName
 * @param {string} tagId
 */
export function removeChatTag(fileName, tagId) {
    const tags = getChatTags(fileName);
    const idx = tags.indexOf(tagId);
    if (idx === -1) return;
    tags.splice(idx, 1);
    setChatMeta(fileName, { tags });
}

// ──────────────────────────────────────────────
//  Filter & Sort State (global, persisted)
// ──────────────────────────────────────────────

/**
 * @returns {{ tags: string[], dateFrom: string|null, dateTo: string|null, messageCountMin: number|null, messageCountMax: number|null }}
 */
export function getFilterState() {
    return getSettings().filterState;
}

/**
 * Merge partial filter updates into the current state.
 * @param {Object} partial
 */
export function setFilterState(partial) {
    const settings = getSettings();
    Object.assign(settings.filterState, partial);
    save();
}

/**
 * Reset filter state to defaults.
 */
export function clearFilterState() {
    const settings = getSettings();
    settings.filterState = { ...DEFAULT_FILTER_STATE };
    save();
}

/**
 * Check if any filter is active.
 * @returns {boolean}
 */
export function hasActiveFilter() {
    const f = getFilterState();
    return (f.tags.length > 0) || f.dateFrom || f.dateTo || f.messageCountMin != null || f.messageCountMax != null;
}

/**
 * @returns {{ field: string, direction: string }}
 */
export function getSortState() {
    return getSettings().sortState;
}

/**
 * Merge partial sort updates.
 * @param {Object} partial - { field?, direction? }
 */
export function setSortState(partial) {
    const settings = getSettings();
    Object.assign(settings.sortState, partial);
    save();
}

/**
 * Get embedding settings (global, persisted).
 * @returns {{ enabled: boolean, provider: string, apiKey: string, ollamaUrl: string, model: string, dimensions: number|null, colorMode: string, mapEnabled: boolean, mapLodMode: string, mapPointSize: number, mapSimilarityChannel: string, embeddingLevels: { chat: boolean, message: boolean, query: boolean }, scopeMode: string, selectedChatsByAvatar: Record<string, string[]>, includeAlternateSwipes: boolean, maxSwipesPerMessage: number, swipeBackgroundBatchSize: number, swipeBackgroundDelayMs: number }}
 */
export function getEmbeddingSettings() {
    const settings = getSettings();
    if (!settings.embeddings || typeof settings.embeddings !== 'object') {
        settings.embeddings = createDefaultEmbeddingSettings();
        save();
    } else {
        for (const [key, value] of Object.entries(DEFAULT_EMBEDDING_SETTINGS)) {
            if (settings.embeddings[key] === undefined) {
                settings.embeddings[key] = (value && typeof value === 'object' && !Array.isArray(value))
                    ? { ...value }
                    : value;
            }
        }
        normalizeEmbeddingSettings(settings.embeddings);
    }
    return settings.embeddings;
}

/**
 * Merge and persist embedding settings.
 * @param {Partial<{ enabled: boolean, provider: string, apiKey: string, ollamaUrl: string, model: string, dimensions: number|null, colorMode: string, mapEnabled: boolean, mapLodMode: string, mapPointSize: number, mapSimilarityChannel: string, embeddingLevels: { chat: boolean, message: boolean, query: boolean }, scopeMode: string, selectedChatsByAvatar: Record<string, string[]>, includeAlternateSwipes: boolean, maxSwipesPerMessage: number, swipeBackgroundBatchSize: number, swipeBackgroundDelayMs: number }>} partial
 */
export function setEmbeddingSettings(partial) {
    const settings = getSettings();
    if (!settings.embeddings || typeof settings.embeddings !== 'object') {
        settings.embeddings = createDefaultEmbeddingSettings();
    }
    Object.assign(settings.embeddings, partial || {});
    normalizeEmbeddingSettings(settings.embeddings);
    save();
}

/**
 * Get selected chat filenames for embedding scope for a character.
 * @param {string} [charKey]
 * @returns {string[]}
 */
export function getSelectedEmbeddingChats(charKey) {
    const settings = getEmbeddingSettings();
    const key = charKey || getCharacterKey();
    if (!key) return [];
    const selected = settings.selectedChatsByAvatar?.[key];
    return Array.isArray(selected) ? selected.slice() : [];
}

/**
 * Persist selected chat filenames for embedding scope for a character.
 * @param {string[]} fileNames
 * @param {string} [charKey]
 */
export function setSelectedEmbeddingChats(fileNames, charKey) {
    const settings = getEmbeddingSettings();
    const key = charKey || getCharacterKey();
    if (!key) return;

    const normalized = Array.isArray(fileNames)
        ? fileNames
            .filter(fileName => typeof fileName === 'string' && fileName.trim().length > 0)
            .map(fileName => fileName.trim())
        : [];

    settings.selectedChatsByAvatar[key] = Array.from(new Set(normalized));
    save();
}

/**
 * Check whether a chat is selected for embedding scope.
 * @param {string} fileName
 * @param {string} [charKey]
 * @returns {boolean}
 */
export function isEmbeddingChatSelected(fileName, charKey) {
    if (!fileName) return false;
    const selected = getSelectedEmbeddingChats(charKey);
    return selected.includes(fileName);
}

/**
 * Add/remove a single chat from the embedding selection set.
 * @param {string} fileName
 * @param {boolean} selected
 * @param {string} [charKey]
 */
export function setEmbeddingChatSelected(fileName, selected, charKey) {
    if (!fileName) return;
    const current = getSelectedEmbeddingChats(charKey);
    const has = current.includes(fileName);
    if (selected && !has) current.push(fileName);
    if (!selected && has) {
        const idx = current.indexOf(fileName);
        if (idx !== -1) current.splice(idx, 1);
    }
    setSelectedEmbeddingChats(current, charKey);
}
