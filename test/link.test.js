'use strict';
// Static checks for link.js (it opens a real browser, so it is not run here).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('link.js: fixed library, visible window, unlimited QR refresh, never sends', () => {
    const code = fs.readFileSync(path.join(__dirname, '..', 'link.js'), 'utf8');
    assert.match(code, /require\('\.\/vendor\/whatsapp-web\.js-064a3d5'\)/);
    assert.match(code, /headless: false/);
    assert.match(code, /qrMaxRetries: 0/);
    assert.match(code, /dataPath: path\.join\(__dirname, '\.wwebjs_auth'\)/);
    for (const bad of ['sendMessage', 'logout', 'getChats', 'evaluate']) {
        assert.ok(!new RegExp(`\\.${bad}\\s*\\(`).test(code), `must not call ${bad}()`);
    }
});
