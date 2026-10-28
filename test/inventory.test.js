'use strict';
// Exercises the full run lifecycle with a FAKE client (no WhatsApp involved).
const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runInventory } = require('../inventory');

const people = (n) => Array.from({ length: n }, () => ({}));
const g = (id, name, n) => ({ isGroup: true, id: { _serialized: id }, name, participants: people(n), groupMetadata: {} });

class FakeClient extends EventEmitter {
    constructor(script) { super(); this.script = script; this.calls = []; this.reads = 0; this.info = { wid: { _serialized: 'me@c.us' } }; }
    async initialize() {
        this.calls.push('initialize');
        setImmediate(() => this.script.onInit(this));
    }
    async getChats() { this.calls.push('getChats'); return this.script.chats(this.reads++); }
    async getState() { this.calls.push('getState'); return this.script.state || 'CONNECTED'; }
    async destroy() { this.calls.push('destroy'); }
}

function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-'));
    const outFile = path.join(dir, 'groups.csv');
    fs.writeFileSync(outFile, 'STALE DATA FROM AN OLD RUN');
    return {
        outFile,
        opts: {
            outFile, previousFile: path.join(dir, 'groups.previous.csv'),
            detailsFile: path.join(dir, 'groups_details.csv'), detailsPreviousFile: path.join(dir, 'groups_details.previous.csv'),
            readyTimeoutMs: 200, syncWaitMs: 5, recheckWaitMs: 5, maxRechecks: 3, log: () => {},
        },
    };
}

const assertNoCsv = (outFile) => {
    assert.ok(!fs.existsSync(outFile), 'stale/partial groups.csv must not exist after a failed run');
    assert.ok(!fs.existsSync(path.join(path.dirname(outFile), 'groups_details.csv')), 'no details file after a failed run');
};

test('success: writes CSV after ready + stable reads', async () => {
    const { outFile, opts } = setup();
    let qrShown = 0;
    const client = new FakeClient({ onInit: (c) => { c.emit('qr', 'secret'); c.emit('ready'); }, chats: () => [g('1@g.us', 'A', 3), g('2@g.us', 'B, "x"', 5)] });
    const inv = await runInventory(client, { ...opts, showQr: () => qrShown++ });
    assert.strictEqual(qrShown, 1);
    assert.strictEqual(inv.rows.length, 2);
    assert.strictEqual(fs.readFileSync(outFile, 'utf8'), 'group_id,group_name,participants\r\n1@g.us,A,3\r\n2@g.us,"B, ""x""",5\r\n');
    assert.deepStrictEqual(client.calls, ['initialize', 'getChats', 'getChats', 'getState']);
    const details = fs.readFileSync(path.join(path.dirname(outFile), 'groups_details.csv'), 'utf8');
    assert.ok(details.startsWith('group_id,group_name,participants,community_role,community_id,community_name,admins_only_messages,work_number_role\r\n'));
    assert.strictEqual(inv.changes, null, 'old file was not our format, so no comparison');
});

test('second run reports changes against the previous successful run', async () => {
    const { outFile, opts } = setup();
    const run = (chats) => runInventory(new FakeClient({ onInit: (c) => c.emit('ready'), chats: () => chats }), opts);
    await run([g('1@g.us', 'A', 3), g('2@g.us', 'B', 5)]);
    const inv = await run([g('1@g.us', 'A renamed', 4), g('3@g.us', 'C', 2)]);
    assert.deepStrictEqual(inv.changes.added.map((x) => x.id), ['3@g.us']);
    assert.deepStrictEqual(inv.changes.removed.map((x) => x.id), ['2@g.us']);
    assert.deepStrictEqual(inv.changes.renamed, [{ id: '1@g.us', from: 'A', to: 'A renamed' }]);
    assert.deepStrictEqual(inv.changes.countChanged, [{ id: '1@g.us', name: 'A renamed', from: '3', to: '4' }]);
});

test('sync delay: list changes then settles -> uses settled data', async () => {
    const { outFile, opts } = setup();
    const client = new FakeClient({ onInit: (c) => c.emit('ready'), chats: (n) => (n === 0 ? [g('1@g.us', 'A', 3)] : [g('1@g.us', 'A', 3), g('2@g.us', 'B', 4)]) });
    const inv = await runInventory(client, opts);
    assert.strictEqual(inv.rows.length, 2);
    assert.ok(fs.existsSync(outFile));
});

test('sync never settles -> fails, no CSV', async () => {
    const { outFile, opts } = setup();
    const client = new FakeClient({ onInit: (c) => c.emit('ready'), chats: (n) => [g(`${n}@g.us`, 'A', 3)] });
    await assert.rejects(runInventory(client, opts), /kept changing/);
    assertNoCsv(outFile);
});

test('auth failure -> fails clearly, no CSV', async () => {
    const { outFile, opts } = setup();
    const client = new FakeClient({ onInit: (c) => c.emit('auth_failure', 'bad session') });
    await assert.rejects(runInventory(client, opts), /Authentication failed/);
    assertNoCsv(outFile);
});

test('QR never scanned (timeout) -> fails, no CSV', async () => {
    const { outFile, opts } = setup();
    const client = new FakeClient({ onInit: () => {} });
    await assert.rejects(runInventory(client, opts), /not ready within/);
    assertNoCsv(outFile);
});

test('disconnect during sync wait -> fails immediately, no CSV', async () => {
    const { outFile, opts } = setup();
    const client = new FakeClient({ onInit: (c) => { c.emit('ready'); setTimeout(() => c.emit('disconnected', 'NAVIGATION'), 10); }, chats: () => [g('1@g.us', 'A', 3)] });
    await assert.rejects(runInventory(client, { ...opts, syncWaitMs: 1000 }), /disconnected/);
    assertNoCsv(outFile);
});

test('state not CONNECTED after reading -> fails, no CSV', async () => {
    const { outFile, opts } = setup();
    const client = new FakeClient({ onInit: (c) => c.emit('ready'), chats: () => [g('1@g.us', 'A', 3)], state: 'TIMEOUT' });
    await assert.rejects(runInventory(client, opts), /not healthy/);
    assertNoCsv(outFile);
});

test('zero groups -> fails instead of writing empty inventory', async () => {
    const { outFile, opts } = setup();
    const client = new FakeClient({ onInit: (c) => c.emit('ready'), chats: () => [] });
    await assert.rejects(runInventory(client, opts), /No group chats/);
    assertNoCsv(outFile);
});

test('browser fails to start (initialize throws) -> fails, no CSV', async () => {
    const { outFile, opts } = setup();
    const client = new FakeClient({});
    client.initialize = async () => { throw new Error('Failed to launch the browser process'); };
    await assert.rejects(runInventory(client, opts), /Failed to launch/);
    assertNoCsv(outFile);
});

test('failure reports which step it happened in (e.g. reading chats)', async () => {
    const { outFile, opts } = setup();
    const client = new FakeClient({ onInit: (c) => c.emit('ready'), chats: () => { throw new Error('r'); } });
    const progress = {};
    await assert.rejects(runInventory(client, { ...opts, progress }), /^Error: r$/);
    assert.strictEqual(progress.step, 'reading the chat list (client.getChats)');
    assertNoCsv(outFile);
});
