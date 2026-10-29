'use strict';
// Tests for the web panel server with a FAKE WhatsApp. Nothing is really sent.
const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('events');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPanel } = require('../panel/server');

const people = (n, admin) => [{ id: { _serialized: 'me@c.us', user: 'me' }, isAdmin: admin }, ...Array.from({ length: n - 1 }, (_, i) => ({ id: { _serialized: `${i}@c.us` } }))];
const CHATS = [
    { isGroup: true, id: { _serialized: 'A1@g.us' }, name: '100x | C07 | Alpha', isReadOnly: true, participants: people(5, true), groupMetadata: { isParentGroup: false, defaultSubgroup: true, parentGroup: { _serialized: 'C1@g.us' } } },
    { isGroup: true, id: { _serialized: 'A2@g.us' }, name: '100x | C08 | Beta', isReadOnly: true, participants: people(4, true), groupMetadata: { isParentGroup: false, defaultSubgroup: true, parentGroup: { _serialized: 'C2@g.us' } } },
    { isGroup: true, id: { _serialized: 'C1@g.us' }, name: '100x | C07 | Alpha', isReadOnly: false, participants: people(2, true), groupMetadata: { isParentGroup: true } },
    { isGroup: true, id: { _serialized: 'X@g.us' }, name: 'Locked group', isReadOnly: true, participants: people(9, false), groupMetadata: { isParentGroup: false } },
];

class FakeClient extends EventEmitter {
    constructor(opts = {}) { super(); this.opts = opts; this.sent = []; this.info = { wid: { _serialized: 'me@c.us', user: '919999998705' }, pushname: '100xEngineers' }; this.destroyed = false; }
    async initialize() { setImmediate(() => { this.emit('qr', '2@fake-qr-data,abc,def'); }); }
    scan() { this.emit('authenticated'); this.emit('ready'); }
    async getWWebVersion() { return '2.3000.TEST'; }
    async getChats() { return CHATS; }
    async sendMessage(id, content, options) {
        this.sent.push({ id, content, options });
        const msg = { id: { $1: `true_${id}_${this.sent.length}` }, ack: 0 };
        setImmediate(() => this.emit('message_ack', msg, 1));
        return msg;
    }
    async getMessageById(id) { return { getInfo: async () => ({ read: [{}, {}, {}], delivery: [{}], readRemaining: 1, id }) }; }
    async destroy() { this.destroyed = true; }
}

async function setup(extra = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-'));
    const clients = [];
    const panel = createPanel({
        dir, token: 'a'.repeat(32), syncWaitMs: 0, log: () => {},
        makeClient: () => { const c = new FakeClient(); clients.push(c); return c; },
        makeMediaFn: (type, base64, name) => ({ mimetype: type, data: base64, filename: name }),
        pauseFor: async () => {},
        ...extra,
    });
    await new Promise((r) => panel.server.listen(0, '127.0.0.1', r));
    panel.server.unref(); // a failing test must never keep the test run waiting
    const port = panel.server.address().port;
    const call = (method, url, body, headers = {}) => new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Host: `localhost:${port}`, 'X-Panel-Token': 'a'.repeat(32), ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
            let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) { /* not json */ } resolve({ status: res.statusCode, body: j, text: s }); });
        });
        req.on('error', reject); if (data) req.write(data); req.end();
    });
    const waitFor = async (fn, ms = 2000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };
    const connect = async () => { panel.start(); await waitFor(() => clients.length && panel.state.status === 'qr'); clients[clients.length - 1].scan(); await waitFor(() => panel.state.status === 'connected'); };
    return { dir, panel, call, clients, connect, waitFor, close: () => new Promise((r) => panel.server.close(r)) };
}

test('serves the page; API needs the access key and a local host name', async () => {
    const t = await setup();
    const page = await t.call('GET', '/', null, { 'X-Panel-Token': '' });
    assert.strictEqual(page.status, 200);
    assert.match(page.text, /WhatsApp Broadcast Panel/);
    assert.strictEqual((await t.call('GET', '/api/state', null, { 'X-Panel-Token': 'b'.repeat(32) })).status, 401);
    assert.strictEqual((await t.call('GET', '/api/state', null, { 'X-Panel-Token': '' })).status, 401);
    assert.strictEqual((await t.call('GET', '/api/state', null, { Host: 'evil.example:80' })).status, 403);
    assert.strictEqual((await t.call('GET', '/api/state')).status, 200);
    await t.close();
});

test('QR code is shown as an SVG, then connected with groups loaded', async () => {
    const t = await setup();
    t.panel.start();
    await t.waitFor(() => t.panel.state.status === 'qr');
    assert.match(t.panel.state.qr, /^<svg /);
    t.clients[0].scan();
    await t.waitFor(() => t.panel.state.status === 'connected');
    assert.deepStrictEqual(t.panel.state.me, { last4: '8705', name: '100xEngineers' });
    const g = await t.call('GET', '/api/groups');
    const byId = Object.fromEntries(g.body.groups.map((x) => [x.id, x]));
    assert.strictEqual(byId['A1@g.us'].canPost, true);
    assert.strictEqual(byId['A1@g.us'].cohort, 'C07');
    assert.strictEqual(byId['C1@g.us'].canPost, false, 'Community container cannot receive messages');
    assert.strictEqual(byId['X@g.us'].canPost, false, 'admin-only group where we are not admin');
    await t.close();
});

test('plan: checks groups, message and image before anything can be sent', async () => {
    const t = await setup();
    await t.connect();
    assert.match((await t.call('POST', '/api/plan', { groupIds: [], message: 'Hi' })).body.error, /Select at least one group/);
    assert.match((await t.call('POST', '/api/plan', { groupIds: ['A1@g.us'], message: '  ' })).body.error, /empty/);
    assert.match((await t.call('POST', '/api/plan', { groupIds: ['C1@g.us'], message: 'Hi' })).body.error, /Nothing was sent. Untick these groups first:\n.*Community itself/s);
    assert.match((await t.call('POST', '/api/plan', { groupIds: ['A1@g.us'], message: 'Hi', image: { type: 'image/gif', base64: 'AAAA', name: 'x.gif' } })).body.error, /JPG or PNG/);
    const ok = await t.call('POST', '/api/plan', { groupIds: ['A1@g.us', 'A2@g.us'], message: 'Hello *all*', image: { type: 'image/png', base64: Buffer.from('png-bytes').toString('base64'), name: 'poster.png' } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.confirm, 'SEND 2');
    assert.strictEqual(ok.body.members, 9);
    await t.close();
});

test('send: needs the exact SEND N, sends each group once with the caption, logs and shows history', async () => {
    const t = await setup();
    await t.connect();
    const plan = (await t.call('POST', '/api/plan', { groupIds: ['A1@g.us', 'A2@g.us'], message: 'Webinar today', image: { type: 'image/png', base64: Buffer.from('img').toString('base64'), name: 'p.png' } })).body;
    assert.strictEqual((await t.call('POST', '/api/send', { planId: plan.planId, confirm: 'SEND 3', speed: 'safe' })).status, 400);
    assert.strictEqual((await t.call('POST', '/api/send', { planId: plan.planId, confirm: 'SEND 2', speed: 'turbo' })).status, 400);
    assert.strictEqual((await t.call('POST', '/api/send', { planId: plan.planId, confirm: 'send 2', speed: 'fast' })).status, 202);
    await t.waitFor(() => t.panel._internals.job && !t.panel._internals.job.running);
    const c = t.clients[0];
    assert.deepStrictEqual(c.sent.map((s) => s.id), ['A1@g.us', 'A2@g.us']);
    assert.strictEqual(c.sent[0].options.caption, 'Webinar today');
    assert.deepStrictEqual(t.panel._internals.job.results.map((r) => r.status), ['SENT', 'SENT']);
    const hist = (await t.call('GET', '/api/history')).body.history;
    assert.strictEqual(hist.length, 1);
    assert.strictEqual(hist[0].sent, 2);
    assert.strictEqual(hist[0].preview, 'Webinar today');
    // Same message + image again: both groups are skipped, nothing to send.
    const again = (await t.call('POST', '/api/plan', { groupIds: ['A1@g.us', 'A2@g.us'], message: 'Webinar today', image: { type: 'image/png', base64: Buffer.from('img').toString('base64'), name: 'p.png' } })).body;
    assert.strictEqual(again.toSend.length, 0);
    assert.strictEqual(again.skipped.length, 2);
    // A used preview cannot be sent twice.
    assert.match((await t.call('POST', '/api/send', { planId: plan.planId, confirm: 'SEND 2', speed: 'fast' })).body.error, /expired/);
    await t.close();
});

test('Stop: finishes the current group and sends no more', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const t = await setup({ pauseFor: () => gate });
    await t.connect();
    const plan = (await t.call('POST', '/api/plan', { groupIds: ['A1@g.us', 'A2@g.us'], message: 'Hi' })).body;
    await t.call('POST', '/api/send', { planId: plan.planId, confirm: 'SEND 2', speed: 'safe' });
    await t.waitFor(() => t.panel._internals.job && t.panel._internals.job.results.length === 1);
    assert.strictEqual((await t.call('POST', '/api/send', { planId: plan.planId, confirm: 'SEND 2', speed: 'safe' })).status, 409, 'one send at a time');
    assert.strictEqual((await t.call('POST', '/api/stop')).status, 200);
    release();
    await t.waitFor(() => !t.panel._internals.job.running);
    assert.deepStrictEqual(t.clients[0].sent.map((s) => s.id), ['A1@g.us']);
    await t.close();
});

test('read report: counts per group and cohort, saved as CSV', async () => {
    const t = await setup();
    await t.connect();
    const plan = (await t.call('POST', '/api/plan', { groupIds: ['A1@g.us', 'A2@g.us'], message: 'Hi' })).body;
    await t.call('POST', '/api/send', { planId: plan.planId, confirm: 'SEND 2', speed: 'fast' });
    await t.waitFor(() => !t.panel._internals.job.running);
    const rep = (await t.call('POST', '/api/report')).body;
    assert.deepStrictEqual(rep.byCohort.map((c) => [c.cohort, c.read]), [['C07', 3], ['C08', 3]]);
    const csv = await t.call('GET', '/api/report.csv');
    assert.strictEqual(csv.status, 200);
    assert.match(csv.text, /^checked_at,cohort,group_name/);
    assert.doesNotMatch(csv.text, /@c\.us/, 'no phone numbers in the report');
    await t.close();
});

test('Switch number keeps the old login (renamed) and shows a new QR code', async () => {
    const t = await setup();
    await t.connect();
    fs.mkdirSync(path.join(t.dir, '.wwebjs_auth', 'session'), { recursive: true });
    assert.strictEqual((await t.call('POST', '/api/switch-number', { confirm: 'nope' })).status, 400);
    assert.strictEqual((await t.call('POST', '/api/switch-number', { confirm: 'switch' })).status, 200);
    await t.waitFor(() => t.clients.length === 2 && t.panel.state.status === 'qr');
    assert.ok(t.clients[0].destroyed);
    const kept = fs.readdirSync(t.dir).filter((f) => f.startsWith('.wwebjs_auth_saved_'));
    assert.strictEqual(kept.length, 1, 'old login kept, not deleted');
    assert.ok(!fs.existsSync(path.join(t.dir, '.wwebjs_auth')));
    await t.close();
});

test('panel code never calls forbidden WhatsApp write operations', () => {
    const code = fs.readFileSync(path.join(__dirname, '..', 'panel', 'server.js'), 'utf8');
    // Sending only happens through the shared engine (engine.runBatch -> sendOne), which has its own tests.
    assert.match(code, /engine\.runBatch\(/);
    for (const bad of ['sendMessage', 'forward', 'delete', 'addParticipants', 'removeParticipants', 'setSubject', 'leave', 'logout', 'getChatById', 'evaluate']) {
        // Look at calls on the WhatsApp client objects (client / c), not on ordinary Maps and Sets.
        assert.ok(!new RegExp(`\\b(client|c)\\.${bad}\\s*\\(`).test(code), `panel/server.js must not call client.${bad}() directly`);
    }
});
