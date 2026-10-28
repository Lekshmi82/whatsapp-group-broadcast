'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../lib');

const group = (id, name, participants, extra = {}) => ({
    isGroup: true,
    id: { _serialized: id },
    name,
    participants,
    groupMetadata: { participants, ...extra },
});
const people = (n) => Array.from({ length: n }, (_, i) => ({ id: { _serialized: `${i}@c.us` } }));

test('csvEscape: commas, quotes, newlines, unicode', () => {
    assert.strictEqual(lib.csvEscape('plain'), 'plain');
    assert.strictEqual(lib.csvEscape('a,b'), '"a,b"');
    assert.strictEqual(lib.csvEscape('say "hi"'), '"say ""hi"""');
    assert.strictEqual(lib.csvEscape('line1\nline2'), '"line1\nline2"');
    assert.strictEqual(lib.csvEscape('cr\rx'), '"cr\rx"');
    assert.strictEqual(lib.csvEscape('Webinar 🚀 ñ'), 'Webinar 🚀 ñ');
    assert.strictEqual(lib.csvEscape(null), '');
    assert.strictEqual(lib.csvEscape(12), '12');
});

test('toCsv: header is exactly group_id,group_name,participants', () => {
    const csv = lib.toCsv([['1@g.us', 'A, "B"', 3]]);
    assert.strictEqual(csv, 'group_id,group_name,participants\r\n1@g.us,"A, ""B""",3\r\n');
});

test('buildInventory: keeps only isGroup chats, uses real ids/names/counts', () => {
    const inv = lib.buildInventory([
        group('111@g.us', 'LK Test Community 1', people(4)),
        { isGroup: false, id: { _serialized: '999@c.us' }, name: 'Private person' },
        group('222@g.us', 'Other group', people(2)),
    ]);
    assert.deepStrictEqual(inv.rows, [['111@g.us', 'LK Test Community 1', 4], ['222@g.us', 'Other group', 2]]);
    assert.strictEqual(inv.groupChatsSeen, 2);
});

test('buildInventory: duplicate ids are removed and reported', () => {
    const inv = lib.buildInventory([group('1@g.us', 'A', people(3)), group('1@g.us', 'A', people(3))]);
    assert.strictEqual(inv.rows.length, 1);
    assert.deepStrictEqual(inv.duplicates, ['1@g.us']);
    assert.strictEqual(inv.groupChatsSeen, 2);
});

test('buildInventory: missing/empty participants -> "unavailable", never a guessed number', () => {
    const inv = lib.buildInventory([group('1@g.us', 'No list', undefined), group('2@g.us', 'Empty', [])]);
    assert.deepStrictEqual(inv.rows.map((r) => r[2]), ['unavailable', 'unavailable']);
    assert.strictEqual(inv.unavailable.length, 2);
});

test('buildInventory: missing name stays blank and is reported', () => {
    const inv = lib.buildInventory([group('1@g.us', undefined, people(2))]);
    assert.strictEqual(inv.rows[0][1], '');
    assert.deepStrictEqual(inv.missingNames, ['1@g.us']);
});

test('buildInventory: refuses a group without an id', () => {
    assert.throws(() => lib.buildInventory([{ isGroup: true, name: 'x', participants: [] }]), /no ID/);
});

test('communityHints: picks community-ish fields, never dumps arrays', () => {
    const hints = lib.communityHints({
        participants: people(5),
        isParentGroup: false,
        parentGroup: { _serialized: '120@g.us' },
        announce: true,
        desc: 'ignored',
        pastParticipants: people(2),
    });
    assert.deepStrictEqual(hints, { isParentGroup: false, parentGroup: '120@g.us', announce: true });
    assert.strictEqual(lib.communityRole(hints, true), 'community_group');
    assert.strictEqual(lib.communityRole({ isParentGroup: true }, true), 'community_container');
    assert.strictEqual(lib.communityRole({ defaultSubgroup: true }, true), 'community_announcement');
    assert.strictEqual(lib.communityRole({}, false), 'unknown');
});

test('file handling: old CSV is set aside, new CSV written atomically as UTF-8', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-'));
    const out = path.join(dir, 'groups.csv');
    const prev = path.join(dir, 'groups.previous.csv');
    fs.writeFileSync(out, 'old');
    assert.strictEqual(lib.setAsidePreviousOutput(out, prev), true);
    assert.ok(!fs.existsSync(out));
    assert.strictEqual(fs.readFileSync(prev, 'utf8'), 'old');
    lib.writeCsvAtomic(out, [['1@g.us', 'Café 🚀', 2]]);
    assert.ok(!fs.existsSync(out + '.tmp'));
    assert.strictEqual(fs.readFileSync(out, 'utf8'), 'group_id,group_name,participants\r\n1@g.us,Café 🚀,2\r\n');
});

// ----- scalability / Community features -----

test('parseCsv reads back exactly what toCsv wrote (commas, quotes, newlines, emoji)', () => {
    const rows = [['1@g.us', 'A, "B"\nnext line', '3'], ['2@g.us', 'Café 🚀', 'unavailable']];
    assert.deepStrictEqual(lib.parseCsv(lib.toCsv(rows)), [lib.CSV_HEADER, ...rows]);
});

test('workNumberRole: admin / member / unknown, using only documented participant fields', () => {
    const chat = { participants: [
        { id: { _serialized: '911@c.us', user: '911' }, isAdmin: true },
        { id: { _serialized: '922@c.us', user: '922' }, isAdmin: false },
    ] };
    assert.strictEqual(lib.workNumberRole(chat, '911@c.us'), 'admin');
    assert.strictEqual(lib.workNumberRole(chat, '922@c.us'), 'member');
    assert.strictEqual(lib.workNumberRole(chat, '933@c.us'), 'unknown');
    assert.strictEqual(lib.workNumberRole(chat, undefined), 'unknown');
    assert.strictEqual(lib.workNumberRole({}, '911@c.us'), 'unknown');
});

test('communityHints keeps lists of group IDs but hides other lists', () => {
    const hints = lib.communityHints({ joinedSubgroups: [{ _serialized: 'a@g.us' }, 'b@g.us'], linkedPeople: [{ _serialized: '9@c.us' }] });
    assert.deepStrictEqual(hints, { joinedSubgroups: ['a@g.us', 'b@g.us'], linkedPeople: '[list of 1]' });
});

test('communityRole: unknown when WhatsApp gives no Community fields; standalone only when it does', () => {
    assert.strictEqual(lib.communityRole({ announce: false }, false), 'unknown');
    assert.strictEqual(lib.communityRole({ isParentGroup: false }, true), 'standalone_group');
});

test('buildInventory: Community rows are grouped; missing container is shown as missing', () => {
    const mk = (id, name, meta, extra = {}) => ({ isGroup: true, id: { _serialized: id }, name, participants: people(3), groupMetadata: meta, ...extra });
    const inv = lib.buildInventory([
        mk('C1@g.us', 'LK Test Community 1', { isParentGroup: true }),
        mk('A1@g.us', 'LK Test Community 1', { isParentGroup: false, defaultSubgroup: true, parentGroup: { _serialized: 'C1@g.us' } }, { isReadOnly: true }),
        mk('G1@g.us', 'General', { isParentGroup: false, parentGroup: { _serialized: 'C1@g.us' } }),
        mk('A2@g.us', 'LK Test Community 2', { isParentGroup: false, defaultSubgroup: true, parentGroup: { _serialized: 'C2@g.us' } }),
        mk('S@g.us', 'Standalone', { isParentGroup: false }),
        mk('U@g.us', 'No fields', {}),
    ]);
    const c1 = inv.communities.get('C1@g.us');
    assert.strictEqual(c1.container.id, 'C1@g.us');
    assert.deepStrictEqual(c1.announcement.map((g) => g.id), ['A1@g.us']);
    assert.deepStrictEqual(c1.groups.map((g) => g.id), ['G1@g.us']);
    assert.strictEqual(inv.communities.get('C2@g.us').container, null);
    const d = Object.fromEntries(inv.detailRows.map((r) => [r[0], r]));
    assert.deepStrictEqual(d['A1@g.us'].slice(3), ['community_announcement', 'C1@g.us', 'LK Test Community 1', 'yes', 'unknown']);
    assert.deepStrictEqual(d['A2@g.us'].slice(3, 6), ['community_announcement', 'C2@g.us', '']);
    assert.strictEqual(d['S@g.us'][3], 'standalone_group');
    assert.strictEqual(d['U@g.us'][3], 'unknown');
    assert.strictEqual(inv.rows[0].length, 3, 'groups.csv rows stay at exactly 3 columns');
});

test('compareWithPrevious: new, gone, renamed, member count changed (by ID, not name)', () => {
    const prev = [['1@g.us', 'Old name', '3'], ['2@g.us', 'Gone', '5'], ['3@g.us', 'Same', '4']];
    const now = [['1@g.us', 'New name', 3], ['3@g.us', 'Same', 6], ['4@g.us', 'Brand new', 2]];
    assert.deepStrictEqual(lib.compareWithPrevious(prev, now), {
        added: [{ id: '4@g.us', name: 'Brand new' }],
        removed: [{ id: '2@g.us', name: 'Gone' }],
        renamed: [{ id: '1@g.us', from: 'Old name', to: 'New name' }],
        countChanged: [{ id: '3@g.us', name: 'Same', from: '4', to: '6' }],
    });
});

test('readPreviousRows ignores files that are not our CSV format', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-'));
    const f = path.join(dir, 'x.csv');
    fs.writeFileSync(f, 'something,else\n1,2\n');
    assert.strictEqual(lib.readPreviousRows(f), null);
    assert.strictEqual(lib.readPreviousRows(path.join(dir, 'missing.csv')), null);
});

// ----- WhatsApp July 2026 change: id._serialized renamed to id.$1 -----

test('widString reads old (_serialized) and new ($1) ID formats, never invents one', () => {
    assert.strictEqual(lib.widString({ _serialized: '1@g.us' }), '1@g.us');
    assert.strictEqual(lib.widString({ $1: '2@g.us' }), '2@g.us');
    assert.strictEqual(lib.widString('3@g.us'), '3@g.us');
    assert.strictEqual(lib.widString({ server: 'g.us' }), '');
    assert.strictEqual(lib.widString(null), '');
});

test('buildInventory works when WhatsApp uses the new $1 ID field everywhere', () => {
    const inv = lib.buildInventory([{
        isGroup: true,
        id: { $1: 'A1@g.us' },
        name: 'LK Test Community 1',
        isReadOnly: true,
        participants: [{ id: { $1: '911@c.us', user: '911' }, isAdmin: true }, { id: { $1: '922@c.us' } }],
        groupMetadata: { isParentGroup: false, defaultSubgroup: true, parentGroup: { $1: 'C1@g.us' } },
    }], { meId: '911@c.us' });
    assert.deepStrictEqual(inv.detailRows[0], [
        'A1@g.us', 'LK Test Community 1', 2, 'community_announcement', 'C1@g.us', '', 'yes', 'admin',
    ]);
});
