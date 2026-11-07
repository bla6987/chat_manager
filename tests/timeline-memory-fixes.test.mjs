import { messagePreview as truncateMessagePreview } from '../src/message-descriptors.js';
import { messageKey } from '../src/chat-index-data.js';
import { clearIcicleSemanticCache } from '../src/icicle-data.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const dataSource = (await readFile(new URL('../src/icicle-data.js', import.meta.url), 'utf8'))
    .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
const viewSource = (await readFile(new URL('../src/icicle-view.js', import.meta.url), 'utf8'))
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '').replace(/^export /gm, '');
function builder(source, stats = { refs: 0 }) {
    return new Function('stats', 'messageKey', 'truncateMessagePreview', `${source}; return buildIcicleData;`)(stats, messageKey, truncateMessagePreview);
}
const originalConstruction = dataSource
    .replace('            current = child;', '            child.chatFiles.push(fileName);\n            current = child;')
    .replace('        current.chatFiles.push(fileName);', '')
    .replace('    assembleMembership(root, entries);', '');
const entry = (texts, label) => ({ isLoaded: true, clusterLabel: label,
    messages: texts.map((text, i) => ({ role: i % 2 ? 'assistant' : 'user', text })) });
const snapshot = data => data.flatNodes.map(node => ({ text: node.normalizedText,
    depth: node.depth, files: [...node.chatFiles], cluster: node.clusterLabel,
    representative: node.representative, y0: node.y0, y1: node.y1 }));

test('memberships, cluster ties, representatives and stable layout equal append-per-depth construction', async () => {
    const index = { a: entry(['common', 'left', 'end'], 2),
        b: entry(['common', 'right'], 1), c: entry(['common'], 1),
        d: entry(['common', 'left'], 1), e: entry(['other'], 2),
        f: entry(['common', 'right', 'end'], 2) };
    const oldBuild = builder(originalConstruction), newBuild = builder(dataSource);
    for (const active of ['a', 'b', 'c', null]) {
        const old = await oldBuild(index, active), next = await newBuild(index, active);
        assert.deepEqual(snapshot(next), snapshot(old));
        const changed = { ...index, g: entry(['common', 'left', 'new'], 2) };
        assert.deepEqual(snapshot(await newBuild(changed, active, { previousRoot: next.root })),
            snapshot(await oldBuild(changed, active, { previousRoot: old.root })));
    }
});

test('shared-prefix construction allocates file references once per distinct membership', async () => {
    const stats = { refs: 0 };
    const instrumented = dataSource
        .replace('current.chatFiles.push(fileName);', 'stats.refs++; current.chatFiles.push(fileName);')
        .replace('node.chatFiles = groups.flat();', 'stats.refs += groups.reduce((n, a) => n + a.length, 0); node.chatFiles = groups.flat();');
    const common = Array.from({ length: 1000 }, (_, i) => `turn ${i}`);
    const index = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`file${i}`, entry([...common, `branch ${i}`], i % 2)]));
    const result = await builder(instrumented, stats)(index, 'file0');
    assert.equal(stats.refs, 1000); // 500 terminals + one 500-file branch membership.
    assert.equal(result.flatNodes.length, 1500);
    assert.equal(new Set(result.flatNodes.slice(0, 1000).map(n => n.chatFiles)).size, 1);
});

function viewHarness(nodes) {
    return new Function('window', 'clearIcicleSemanticCache', `${viewSource}; return {
        load(nodes) { flatNodes = nodes; rebuildDepthIndex(); },
        visible: visibleDepthNodes, member: isActiveMember, unmount: unmountIcicle,
        indexSize: () => nodesByDepth.size,
    };`)({ removeEventListener() {} }, clearIcicleSemanticCache);
}

test('depth culling preserves pre-order and only checks visible shared memberships', () => {
    let checks = 0;
    const members = ['active'];
    members.includes = file => { checks++; return file === 'active'; };
    const nodes = Array.from({ length: 12000 }, (_, i) => ({ depth: i % 2000, chatFiles: members }));
    const api = viewHarness(); api.load(nodes);
    const visible = api.visible(100, 104);
    assert.deepEqual(visible, nodes.filter(n => n.depth >= 100 && n.depth <= 104));
    assert.equal(visible.length, 30);
    visible.forEach(n => assert.equal(api.member(n, 'active'), true));
    assert.equal(checks, 1);
    visible.forEach(n => api.member(n, 'other'));
    assert.equal(checks, 2);
    api.load([{ depth: 7, chatFiles: members }]);
    assert.deepEqual(api.visible(100, 104), []);
    api.member({ chatFiles: members }, 'other');
    assert.equal(checks, 3); // A rebuild invalidates membership even for reused arrays.
    assert.deepEqual(api.visible(-10000, 10000).map(n => n.depth), [7]);
    api.unmount();
    assert.equal(api.indexSize(), 0);
    assert.deepEqual(api.visible(-10000, 10000), []);
    api.member({ chatFiles: members }, 'other');
    assert.equal(checks, 4);
    api.load(nodes);
    assert.equal(api.visible(100, 104).length, 30);
});

test('render commands preserve spine, gutter, hover, overlap and Explore viewport drawing', async () => {
    const index = { a: entry(['common', 'left', 'one']), b: entry(['common', 'right', 'two']),
        c: entry(['common', 'left', 'three']) };
    const data = await builder(dataSource)(index, 'a');
    const renderTrace = (source, offset, x, y0, y1) => {
        const calls = [];
        const context = new Proxy({}, {
            get: (_, key) => (...args) => calls.push([key, ...args]),
            set: (_, key, value) => { calls.push(['set', key, value]); return true; },
        });
        new Function('nodes', 'context', 'offset', 'x', 'y0', 'y1', `${source};
            flatNodes = nodes; rebuildDepthIndex(); ctx = context;
            canvasWidth = 240; canvasHeight = 80;
            getActiveChatFile = () => 'a'; activeTopicDriftChatFile = 'a';
            hoveredNode = nodes[2]; exploreDepthOffset = offset;
            viewX = x; viewY0 = y0; viewY1 = y1; render();
        `)(data.flatNodes, context, offset, x, y0, y1);
        return calls;
    };
    const scanSource = viewSource.replace(
        'const visibleNodes = visibleDepthNodes(minVisibleDepth, maxVisibleDepth);',
        'const visibleNodes = flatNodes.filter(node => node.depth >= minVisibleDepth && node.depth <= maxVisibleDepth);');
    for (const args of [[0, 0, 0, 1], [1, 20, 0.2, 0.8], [0, 120, 0.49, 0.51]]) {
        assert.deepEqual(renderTrace(viewSource, ...args), renderTrace(scanSource, ...args));
    }
});
