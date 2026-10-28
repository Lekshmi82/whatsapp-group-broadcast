'use strict';
// Static check: our own code must never reference write/messaging operations.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const FORBIDDEN = [
    'sendMessage', 'sendSeen', 'reply', 'forward', 'delete', 'clearMessages', 'archive', 'unarchive',
    'pin', 'mute', 'markUnread', 'addParticipants', 'removeParticipants', 'promoteParticipants',
    'demoteParticipants', 'setSubject', 'setDescription', 'setPicture', 'deletePicture',
    'setMessagesAdminsOnly', 'setInfoAdminsOnly', 'setAddMembersAdminsOnly', 'revokeInvite',
    'getInviteCode', 'acceptInvite', 'leave', 'createGroup', 'createCommunity', 'logout',
    'approveGroupMembershipRequests', 'rejectGroupMembershipRequests', 'setStatus', 'setDisplayName',
    'sendPresenceAvailable', 'pupPage', 'evaluate',
    // read-looking but unsafe/unneeded: getChatById can CREATE a chat (findOrCreateLatestChat);
    // getContacts loads the whole personal contact list.
    'getChatById', 'getContacts', 'getContactById',
];

for (const file of ['inventory.js', 'lib.js']) {
    test(`${file} uses no write/messaging APIs`, () => {
        const code = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); // ignore comments
        const hits = FORBIDDEN.filter((name) => new RegExp(`\\.${name}\\s*\\(`).test(code));
        assert.deepStrictEqual(hits, []);
    });
}

test('inventory.js only calls the expected client methods', () => {
    const code = fs.readFileSync(path.join(__dirname, '..', 'inventory.js'), 'utf8');
    const used = new Set([...code.matchAll(/client\.(\w+)\s*\(/g)].map((m) => m[1]));
    assert.deepStrictEqual([...used].sort(), ['destroy', 'getChats', 'getState', 'initialize', 'on', 'once']);
});

test('whatsapp-web.js is loaded from the vendored, reviewed folder', () => {
    const root = path.join(__dirname, '..');
    const code = fs.readFileSync(path.join(root, 'inventory.js'), 'utf8');
    assert.match(code, /require\('\.\/vendor\/whatsapp-web\.js-064a3d5'\)/);
    assert.doesNotMatch(code, /require\('whatsapp-web\.js'\)/);
    const vendored = require('../vendor/whatsapp-web.js-064a3d5/package.json');
    assert.strictEqual(vendored.name, 'whatsapp-web.js');
    // Every library dependency is installed at exactly the version it expects.
    const pkg = require('../package.json');
    for (const [name, version] of Object.entries(vendored.dependencies)) {
        assert.strictEqual(pkg.dependencies[name], version, `${name} version must match`);
    }
});
