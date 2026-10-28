'use strict';
// Tests for send-to-groups.js. A FAKE WhatsApp is used; nothing is really sent.
const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const s = require('../send-to-groups');

const G = {
    container: { id: '120363414764184538@g.us', name: 'LK Test Community 1', role: 'community_container', adminsOnly: 'no', workNumberRole: 'admin', participants: 2 },
    ann1: { id: '120363413574774257@g.us', name: 'LK Test Community 1', role: 'community_announcement', adminsOnly: 'yes', workNumberRole: 'admin', participants: 3 },
    ann2: { id: '120363431042734972@g.us', name: 'LK Test Community 2', role: 'community_announcement', adminsOnly: 'yes', workNumberRole: 'admin', participants: 3 },
    personal: { id: '120363428596837134@g.us', name: 'Personal', role: 'standalone_group', adminsOnly: 'yes', workNumberRole: 'member', participants: 2 },
    normal: { id: '120363430354477618@g.us', name: 'LK Test Community 1', role: 'standalone_group', adminsOnly: 'no', workNumberRole: 'admin', participants: 3 },
};
const inv = { groups: Object.values(G) };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'send-'));

test('parseTargets: IDs only, comments and names ignored, BOM handled', () => {
    const text = '﻿# my list\r\n120363413574774257@g.us  LK Test Community 1 - Announcements\r\n\r\n# 120363431042734972@g.us not chosen\r\n120363430354477618@g.us\r\n';
    assert.deepStrictEqual(s.parseTargets(text), ['120363413574774257@g.us', '120363430354477618@g.us']);
});

test('parseTargets refuses names, phone numbers, duplicates, empty lists and too many groups', () => {
    assert.throws(() => s.parseTargets('LK Test Community 1'), /line 1: "LK" is not a group ID/);
    assert.throws(() => s.parseTargets('919876543210@c.us'), /not a group ID/);
    assert.throws(() => s.parseTargets('1@g.us\n1@g.us'), /listed twice/);
    assert.throws(() => s.parseTargets('# nothing chosen'), /no group IDs/);
    const many = Array.from({ length: s.MAX_GROUPS_PER_RUN + 1 }, (_, i) => `${i + 1}@g.us`).join('\n');
    assert.throws(() => s.parseTargets(many), /limit per run/);
});

test('parseMessage keeps multi-line text, strips BOM and outer blank lines, refuses empty', () => {
    assert.strictEqual(s.parseMessage('﻿\r\nWebinar today!\r\nJoin: https://x\r\n\r\n'), 'Webinar today!\nJoin: https://x');
    assert.throws(() => s.parseMessage('  \r\n '), /empty/);
});

test('canPost: no Community containers, no admin-only groups unless admin', () => {
    assert.strictEqual(s.canPost(G.ann1).ok, true);
    assert.strictEqual(s.canPost(G.normal).ok, true);
    assert.match(s.canPost(G.container).reason, /Community itself/);
    assert.match(s.canPost(G.personal).reason, /only admins/);
});

test('planBatch: one bad target -> NOTHING is sent (throws with every problem listed)', () => {
    const h = s.messageHash('hi');
    assert.throws(() => s.planBatch(inv, [G.ann1.id, G.container.id, '999@g.us'], h, new Set()),
        (err) => /Nothing was sent/.test(err.message) && /Community itself/.test(err.message) && /999@g.us: not found/.test(err.message));
});

test('planBatch: groups that already got the same message are skipped; a new message is not', () => {
    const h = s.messageHash('hi');
    const sent = new Set([`${G.ann1.id}|${h}`]);
    const p = s.planBatch(inv, [G.ann1.id, G.ann2.id], h, sent);
    assert.deepStrictEqual(p.toSend.map((g) => g.id), [G.ann2.id]);
    assert.deepStrictEqual(p.skipped.map((x) => x.group.id), [G.ann1.id]);
    assert.strictEqual(s.planBatch(inv, [G.ann1.id], s.messageHash('different'), sent).toSend.length, 1);
});

test('availableTargetsText lists only postable groups, all commented out', () => {
    const text = s.availableTargetsText(inv);
    assert.match(text, /# 120363413574774257@g.us {2}LK Test Community 1 {2}\[community_announcement, 3 members\]/);
    assert.doesNotMatch(text, /120363414764184538/); // container
    assert.doesNotMatch(text, /120363428596837134/); // admin-only, not admin
    assert.throws(() => s.parseTargets(text), /no group IDs/); // nothing chosen until # removed
});

class FakeClient extends EventEmitter {
    constructor(plan = {}) { super(); this.plan = plan; this.sent = []; }
    async sendMessage(id, text, opts) {
        if (this.plan[id] === 'throw') throw new Error('Evaluation failed');
        this.sent.push({ id, text, opts });
        const msg = { id: { $1: `true_${id}_${this.sent.length}` }, ack: 0 };
        if (this.plan[id] !== 'noack') setImmediate(() => this.emit('message_ack', msg, 1));
        return msg;
    }
}

test('runBatch sends to each group once, in order, pausing between, and logs every result', async () => {
    const dir = tmp(); const logFile = path.join(dir, 'send-log.csv');
    const c = new FakeClient(); let pauses = 0;
    const r = await s.runBatch(c, [G.ann1, G.ann2, G.normal], 'Hello', { hash: 'abc', logFile, pause: async () => { pauses++; }, ackWaitMs: 200, log: () => {} });
    assert.deepStrictEqual(r.map((x) => x.status), ['SENT', 'SENT', 'SENT']);
    assert.deepStrictEqual(c.sent.map((x) => x.id), [G.ann1.id, G.ann2.id, G.normal.id]);
    assert.ok(c.sent.every((x) => x.text === 'Hello' && x.opts.sendSeen === false));
    assert.strictEqual(pauses, 2);
    assert.strictEqual(c.listenerCount('message_ack'), 0, 'listeners cleaned up');
    const sentSet = s.readSentLog(logFile);
    assert.ok(sentSet.has(`${G.ann2.id}|abc`));
    assert.strictEqual(sentSet.size, 3);
});

test('runBatch STOPS at the first failure; later groups are not sent', async () => {
    const dir = tmp(); const logFile = path.join(dir, 'send-log.csv');
    const c = new FakeClient({ [G.ann2.id]: 'throw' });
    const r = await s.runBatch(c, [G.ann1, G.ann2, G.normal], 'Hello', { hash: 'abc', logFile, pause: async () => {}, ackWaitMs: 200, log: () => {} });
    assert.deepStrictEqual(r.map((x) => x.status), ['SENT', 'FAILED']);
    assert.deepStrictEqual(c.sent.map((x) => x.id), [G.ann1.id]);
    assert.match(fs.readFileSync(logFile, 'utf8'), /FAILED/);
});

test('runBatch STOPS when WhatsApp does not confirm (UNCONFIRMED), and that group is not marked SENT', async () => {
    const dir = tmp(); const logFile = path.join(dir, 'send-log.csv');
    const c = new FakeClient({ [G.ann1.id]: 'noack' });
    const r = await s.runBatch(c, [G.ann1, G.ann2], 'Hello', { hash: 'abc', logFile, pause: async () => {}, ackWaitMs: 50, log: () => {} });
    assert.deepStrictEqual(r.map((x) => x.status), ['UNCONFIRMED']);
    assert.strictEqual(s.readSentLog(logFile).size, 0);
});

test('send-to-groups.js: fixed library, one sendMessage call, no other write operations', () => {
    const code = fs.readFileSync(path.join(__dirname, '..', 'send-to-groups.js'), 'utf8');
    assert.match(code, /require\('\.\/vendor\/whatsapp-web\.js-064a3d5'\)/);
    assert.doesNotMatch(code, /require\('whatsapp-web\.js'\)/);
    // Exactly two sendMessage calls (text, or image + caption), both inside sendOne().
    assert.strictEqual((code.match(/\.sendMessage\(/g) || []).length, 2);
    const sendOneBody = code.slice(code.indexOf('async function sendOne('), code.indexOf('async function runBatch('));
    assert.strictEqual((sendOneBody.match(/\.sendMessage\(/g) || []).length, 2);
    for (const bad of ['forward', 'delete', 'addParticipants', 'removeParticipants', 'setSubject', 'leave', 'logout', 'getChatById', 'evaluate']) {
        assert.ok(!new RegExp(`\\.${bad}\\s*\\(`).test(code), `must not call ${bad}()`);
    }
});

// ----- image + options (added for "message with image to many groups") -----

test('parseSendOptions: --all, --dry-run, --no-image, --gap; refuses unknown options and tiny gaps', () => {
    assert.deepStrictEqual(s.parseSendOptions([]), { all: false, dryRun: false, noImage: false, gapS: 60 });
    assert.deepStrictEqual(s.parseSendOptions(['--all', '--dry-run', '--gap', '30']), { all: true, dryRun: true, noImage: false, gapS: 30 });
    assert.strictEqual(s.parseSendOptions(['--no-image']).noImage, true);
    assert.throws(() => s.parseSendOptions(['--gap', '2']), /at least 15/);
    assert.throws(() => s.parseSendOptions(['--everyone']), /Unknown option/);
});

test('findImage: none -> text only; one -> used; two -> refused; too big -> refused', () => {
    const dir = tmp();
    assert.strictEqual(s.findImage(dir), null);
    fs.writeFileSync(path.join(dir, 'image.png'), Buffer.alloc(1000, 1));
    assert.strictEqual(s.findImage(dir).name, 'image.png');
    fs.writeFileSync(path.join(dir, 'image.jpg'), Buffer.alloc(10, 1));
    assert.throws(() => s.findImage(dir), /more than one image/);
    fs.unlinkSync(path.join(dir, 'image.jpg'));
    fs.writeFileSync(path.join(dir, 'image.png'), Buffer.alloc(6e6, 1));
    assert.throws(() => s.findImage(dir), /under 5 MB/);
});

test('messageHash changes when the image changes, so a new poster is not skipped', () => {
    assert.notStrictEqual(s.messageHash('Hi', Buffer.from('poster-1')), s.messageHash('Hi', Buffer.from('poster-2')));
    assert.notStrictEqual(s.messageHash('Hi', Buffer.from('poster-1')), s.messageHash('Hi'));
});

test('image send: media object is sent with message.txt as caption', async () => {
    const dir = tmp(); const logFile = path.join(dir, 'send-log.csv');
    const c = new FakeClient(); const media = { mimetype: 'image/png', data: 'AAAA', filename: 'image.png' };
    const r = await s.runBatch(c, [G.ann1], 'Webinar today', { hash: 'h1', logFile, pause: async () => {}, ackWaitMs: 200, log: () => {}, media, imageName: 'image.png' });
    assert.strictEqual(r[0].status, 'SENT');
    assert.strictEqual(c.sent[0].text, media);
    assert.deepStrictEqual(c.sent[0].opts, { caption: 'Webinar today', sendSeen: false, waitUntilMsgSent: true });
    const log = fs.readFileSync(logFile, 'utf8').split('\r\n');
    assert.strictEqual(log[0], s.LOG_HEADER.join(','));
    assert.match(log[1], /,image\.png,SENT,1,h1,/);
});

test('an older send-log.csv format is kept (renamed) and a fresh log is started', () => {
    const dir = tmp(); const logFile = path.join(dir, 'send-log.csv');
    fs.writeFileSync(logFile, 'time,group_id,group_name,status,ack,message_hash,message_id\r\nx,1@g.us,A,SENT,1,h,m\r\n');
    s.appendLog(logFile, ['t', '2@g.us', 'B', '', 'SENT', 1, 'h2', 'm2', '']);
    const files = fs.readdirSync(dir);
    assert.ok(files.some((f) => /^send-log\.old-\d+\.csv$/.test(f)), 'old log kept');
    assert.strictEqual(fs.readFileSync(logFile, 'utf8').split('\r\n')[0], s.LOG_HEADER.join(','));
});
