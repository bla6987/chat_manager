import test from 'node:test';
import assert from 'node:assert/strict';
import { getReplySwipes, getRecentReplies } from '../src/swipe-browser.js';

test('swipes are newest first, retain original numbers, and use the live current text without writes', () => {
    const message = { mes: 'current, edited since save', swipe_id: 1, swipes: ['first', 'stale current', 'latest'] };
    const before = structuredClone(message);
    assert.deepEqual(getReplySwipes(message), [
        { index: 2, number: 3, text: 'latest', current: false },
        { index: 1, number: 2, text: 'current, edited since save', current: true },
        { index: 0, number: 1, text: 'first', current: false },
    ]);
    assert.deepEqual(message, before);
});

test('missing swipes and malformed active IDs preserve a readable live reply without allocating sparse arrays', () => {
    for (const swipe_id of [undefined, -1, 9e12, 'invalid', 1.5]) {
        assert.deepEqual(getReplySwipes({ mes: 'live', swipe_id }), [{ index: 0, number: 1, text: 'live', current: true }]);
    }
    assert.deepEqual(getReplySwipes({ mes: 'first', swipe_id: 90, swipes: ['stale', 'last'] }).map(s => s.text), ['last', 'first']);
    assert.deepEqual(getReplySwipes(null), []);
});

test('empty and malformed alternatives are skipped without renumbering or deduplicating valid swipes', () => {
    const message = { mes: 'same', swipe_id: '0', swipes: ['same', null, '', 'same', '  ', '<img src=x onerror=alert(1)>'] };
    assert.deepEqual(getReplySwipes(message).map(s => s.number), [6, 4, 1]);
    assert.equal(getReplySwipes(message)[0].text, '<img src=x onerror=alert(1)>');
});

test('recent replies ignore users and system messages and keep identities and real message indices', () => {
    const chat = [
        { mes: 'old', is_user: false }, { mes: 'user', is_user: true },
        { mes: 'system', is_system: true }, { mes: 'new', is_user: false },
    ];
    const replies = getRecentReplies(chat, 1);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].index, 3);
    assert.equal(replies[0].message, chat[3]);
    assert.deepEqual(getRecentReplies(chat).map(reply => reply.index), [3, 0]);
    assert.deepEqual(getRecentReplies(undefined), []);
});

test('recent reply pagination scans past user/system messages and includes a streaming empty reply', () => {
    const chat = Array.from({ length: 200 }, (_, index) => ({ mes: `message ${index}`, is_user: index % 2 === 0 }));
    chat.push({ mes: '', is_user: false, swipes: [''] });
    const replies = getRecentReplies(chat, 31);
    assert.equal(replies.length, 31);
    assert.equal(replies[0].index, 200);
    assert.equal(replies.at(-1).index, 141);
    assert.deepEqual(chat[200].swipes, ['']);
});
