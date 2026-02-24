/**
 * Stats Engine — Pure data aggregation for stats dashboard and heatmap.
 * No DOM dependencies. Reads from chat index, caches results keyed by indexVersion.
 */

let cachedStats = null;
let cachedStatsVersion = -1;
let cachedHeatmap = null;
let cachedHeatmapVersion = -1;

function normalizeTimestampMs(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
}

function resolveComparableTimestamp(rawValue, cachedMs) {
    const fromRaw = normalizeTimestampMs(rawValue);
    if (fromRaw !== null) return fromRaw;
    if (Number.isFinite(cachedMs) && cachedMs > 0) return cachedMs;
    return null;
}

/**
 * Compute aggregate stats from the chat index.
 * @param {Object} chatIndex - Map of fileName -> ChatIndexEntry
 * @param {number} indexVersion - Current index version for cache invalidation
 * @returns {{ totalChats: number, loadedChats: number, totalMessages: number, avgMessagesPerChat: number, longestChat: { fileName: string, count: number }|null, mostActiveChat: { fileName: string, count: number }|null, userMessages: number, assistantMessages: number, oldestTimestamp: string|number|null, newestTimestamp: string|number|null, isComplete: boolean }}
 */
export function computeStats(chatIndex, indexVersion) {
    if (cachedStats && cachedStatsVersion === indexVersion) {
        return cachedStats;
    }

    const entries = Object.values(chatIndex);
    let totalMessages = 0;
    let userMessages = 0;
    let assistantMessages = 0;
    let longestChat = null;
    let mostActiveChat = null;
    let oldestTs = null;
    let newestTs = null;
    let oldestMs = null;
    let newestMs = null;
    let loadedChats = 0;

    for (const entry of entries) {
        totalMessages += entry.messageCount;

        if (entry.isLoaded) {
            loadedChats++;
            for (const msg of entry.messages) {
                if (msg.role === 'user') userMessages++;
                else assistantMessages++;
            }
        }

        if (!longestChat || entry.messageCount > longestChat.count) {
            longestChat = { fileName: entry.fileName, count: entry.messageCount };
        }

        // Most active = highest message count (same as longest for now)
        if (!mostActiveChat || entry.messageCount > mostActiveChat.count) {
            mostActiveChat = { fileName: entry.fileName, count: entry.messageCount };
        }

        const firstMs = resolveComparableTimestamp(entry.firstMessageTimestamp, entry.firstTimestampMs);
        if (firstMs !== null && (oldestMs === null || firstMs < oldestMs)) {
            oldestMs = firstMs;
            oldestTs = entry.firstMessageTimestamp ?? firstMs;
        }

        const lastMs = resolveComparableTimestamp(entry.lastMessageTimestamp, entry.lastTimestampMs);
        if (lastMs !== null && (newestMs === null || lastMs > newestMs)) {
            newestMs = lastMs;
            newestTs = entry.lastMessageTimestamp ?? lastMs;
        }
    }

    const totalChats = entries.length;
    const avgMessagesPerChat = totalChats > 0 ? totalMessages / totalChats : 0;

    cachedStats = {
        totalChats,
        loadedChats,
        totalMessages,
        avgMessagesPerChat,
        longestChat,
        mostActiveChat,
        userMessages,
        assistantMessages,
        oldestTimestamp: oldestTs,
        newestTimestamp: newestTs,
        isComplete: loadedChats === totalChats,
    };
    cachedStatsVersion = indexVersion;
    return cachedStats;
}

/**
 * Compute heatmap data from the chat index.
 * @param {Object} chatIndex - Map of fileName -> ChatIndexEntry
 * @param {number} indexVersion - Current index version for cache invalidation
 * @returns {{ dayCounts: Map<string, number>, dayChats: Map<string, Set<string>>, minDate: string|null, maxDate: string|null, maxCount: number, isComplete: boolean }}
 */
export function computeHeatmapData(chatIndex, indexVersion) {
    if (cachedHeatmap && cachedHeatmapVersion === indexVersion) {
        return cachedHeatmap;
    }

    const dayCounts = new Map();
    const dayChats = new Map();
    let minDate = null;
    let maxDate = null;
    let maxCount = 0;
    let loadedCount = 0;
    const totalCount = Object.keys(chatIndex).length;

    for (const entry of Object.values(chatIndex)) {
        if (!entry.isLoaded) continue;
        loadedCount++;

        for (const msg of entry.messages) {
            if (!msg.timestamp) continue;
            const d = new Date(msg.timestamp);
            if (isNaN(d.getTime())) continue;

            const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

            const count = (dayCounts.get(dateKey) || 0) + 1;
            dayCounts.set(dateKey, count);
            if (count > maxCount) maxCount = count;

            if (!dayChats.has(dateKey)) dayChats.set(dateKey, new Set());
            dayChats.get(dateKey).add(entry.fileName);

            if (!minDate || dateKey < minDate) minDate = dateKey;
            if (!maxDate || dateKey > maxDate) maxDate = dateKey;
        }
    }

    cachedHeatmap = {
        dayCounts,
        dayChats,
        minDate,
        maxDate,
        maxCount,
        isComplete: loadedCount === totalCount,
    };
    cachedHeatmapVersion = indexVersion;
    return cachedHeatmap;
}

/**
 * Clear all cached stats.
 */
export function clearStatsCache() {
    cachedStats = null;
    cachedStatsVersion = -1;
    cachedHeatmap = null;
    cachedHeatmapVersion = -1;
}
