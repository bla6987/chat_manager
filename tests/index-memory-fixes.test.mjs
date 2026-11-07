import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { installFakeIndexedDB } from './helpers/fake-indexeddb.mjs';

installFakeIndexedDB({ schedule: setImmediate });

test('clearIndex releases the owned flattened search cache immediately', async () => {
    // Expose ownership for this isolated test without adding production diagnostics.
    let source = await readFile(new URL('../src/chat-reader.js', import.meta.url), 'utf8');
    source = source.replace(/from '(\.\/[^']+)'/g, (_match, relative) =>
        `from '${new URL(`../src/${relative.slice(2)}`, import.meta.url).href}'`);
    source += '\nexport const inspectOwnedSearchCache = () => cachedSearchableMessages;';
    const reader = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    globalThis.SillyTavern = { getContext: () => ({ characterId: 0, characters: [{ avatar: 'avatar' }], chat: [] }) };
    reader.getIndex()['a.jsonl'] = { messages: [{ text: 'owned message', index: 0 }], isLoaded: true };
    const messages = reader.getSearchableMessages();
    assert.equal(messages.length, 1); assert.equal(reader.inspectOwnedSearchCache(), messages);
    reader.clearIndex();
    assert.equal(reader.inspectOwnedSearchCache(), null);
    assert.equal(messages.length, 1); // A caller still owns its explicit result.
});
