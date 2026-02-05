/**
 * Metadata Store — Read/write display names, summaries, cached titles.
 * All data stored in extensionSettings.chat_manager.metadata keyed by character avatar.
 */

const MODULE_NAME = 'chat_manager';

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
    if (!charMeta) return;

    if (charMeta[oldFileName]) {
        charMeta[newFileName] = { ...charMeta[oldFileName] };
        delete charMeta[oldFileName];
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
