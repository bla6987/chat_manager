import test from 'node:test';
import assert from 'node:assert/strict';
import { timestampMs, localDateBoundary } from '../src/timestamps.js';
import { computeStats, computeHeatmapData, clearStatsCache } from '../src/stats-engine.js';
import { clearIndex, getIndex, getFilteredSortedEntries, getSearchableMessages, buildIndex, loadEntryNow } from '../src/chat-reader.js';

const originalTZ = process.env.TZ;
process.env.TZ = 'America/New_York';
process.on('exit', () => { if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ; });

test('historical ST, meridiem, epoch and ISO timestamps retain host timezone semantics', () => {
    assert.equal(timestampMs('2024-07-12@01h31m37s123ms'), Date.parse('2024-07-12T01:31:37.123Z'));
    assert.equal(timestampMs('2024-7-12@01h31m37s'), Date.parse('2024-07-12T01:31:37Z'));
    assert.equal(timestampMs('2024-6-5 @14h 56m 50s 682ms'), Date.parse('2024-06-05T14:56:50.682Z'));
    assert.equal(timestampMs('June 19, 2023 2:20pm'), new Date(2023, 5, 19, 14, 20).getTime());
    assert.equal(timestampMs('June 19, 2023 12:20am'), new Date(2023, 5, 19, 0, 20).getTime());
    assert.equal(timestampMs('1710000000000'), 1710000000000);
    assert.equal(timestampMs(1710000000000), 1710000000000);
    assert.equal(timestampMs('2026-10-14T00:00:00-04:00'), new Date(2026, 9, 14).getTime());
    for (const invalid of ['', null, 'garbage', -1]) assert.equal(timestampMs(invalid), null);
});

test('local calendar boundaries use exclusive next midnight across 23/25-hour DST days', () => {
    assert.equal(localDateBoundary('2026-03-08', true) - localDateBoundary('2026-03-08'), 23 * 3600000);
    assert.equal(localDateBoundary('2026-11-01', true) - localDateBoundary('2026-11-01'), 25 * 3600000);
    assert.equal(localDateBoundary('2026-02-30'), null);
    assert.equal(localDateBoundary('not-a-date'), null);
});

test('reader calendar filter matches local heatmap dates and excludes next midnight', () => {
    clearIndex();
    const times = ['2026-10-13T21:00:00-04:00', '2026-10-14T00:00:00-04:00', '2026-10-14T21:00:00-04:00', '2026-10-15T00:00:00-04:00'];
    for (let i = 0; i < times.length; i++) getIndex()[`${i}.jsonl`] = {
        fileName: `${i}.jsonl`, messageCount: 1, isLoaded: true,
        lastTimestampMs: timestampMs(times[i]), sortTimestamp: timestampMs(times[i]),
        messages: [{ text: String(i), timestamp: times[i] }],
    };
    const result = getFilteredSortedEntries({ dateFrom: '2026-10-14', dateTo: '2026-10-14' }, { field: 'recency' }, () => ({}));
    assert.deepEqual(result.map(e => e.fileName), ['2.jsonl', '1.jsonl']);
    clearStatsCache();
    const heatmap = computeHeatmapData(getIndex(), 1);
    assert.equal(heatmap.dayCounts.get('2026-10-14'), result.length);
    clearIndex();
});

test('historical hydrated timestamps participate in recency, date filters, stats and heatmaps', async () => {
    clearIndex();
    const dates = ['2024-7-12@01h31m37s', '2024-07-13@01h31m37s123ms'];
    globalThis.SillyTavern = { getContext: () => ({ characterId: 0, characters: [{ avatar: 'date.png' }],
        extensionSettings: {}, getRequestHeaders: () => ({}) }) };
    globalThis.fetch = async url => ({ ok: true, json: async () => url === '/api/characters/chats'
        ? [{ file_name: 'historical.jsonl', last_mes: dates[1], chat_items: 2 }]
        : [{ chat_metadata: {} }, ...dates.map(send_date => ({ send_date, mes: send_date }))] });
    await buildIndex(); await loadEntryNow('historical.jsonl');
    const entry = getIndex()['historical.jsonl'];
    assert.equal(entry.lastModified, timestampMs(dates[1]));
    assert.deepEqual(entry.messages.map(m => m.timestampMs), dates.map(timestampMs));
    assert.deepEqual(getSearchableMessages().map(m => m.timestamp), [...dates].reverse());
    assert.equal(getFilteredSortedEntries({ dateFrom: '2024-07-12', dateTo: '2024-07-12' }, {}, () => ({})).length, 1);
    clearStatsCache();
    assert.equal(computeStats(getIndex(), 2).oldestTimestamp, timestampMs(dates[0]));
    assert.equal(computeStats(getIndex(), 2).newestTimestamp, timestampMs(dates[1]));
    assert.equal(computeHeatmapData(getIndex(), 2).dayCounts.get('2024-07-11'), 1);
    assert.equal(computeHeatmapData(getIndex(), 2).dayCounts.get('2024-07-12'), 1);
    clearIndex();
});

test('statistics retain last good counts while reporting pending revalidation incomplete', () => {
    clearStatsCache();
    const index = { a: { fileName: 'a', messageCount: 1, isLoaded: true, needsHydration: true,
        messages: [{ role: 'user', timestamp: '2026-10-14T12:00:00Z' }] } };
    const stats = computeStats(index, 3);
    assert.equal(stats.isComplete, false); assert.equal(stats.loadedChats, 0);
    assert.equal(stats.userMessages, 1); assert.equal(stats.totalMessages, 1);
    const heatmap = computeHeatmapData(index, 3);
    assert.equal(heatmap.isComplete, false); assert.equal(heatmap.maxCount, 1);
});
