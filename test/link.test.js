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

test('vendored library has the LOCAL PATCH for the connection-state wait', () => {
    const code = fs.readFileSync(path.join(__dirname, '..', 'vendor', 'whatsapp-web.js-064a3d5', 'src', 'Client.js'), 'utf8');
    const i = code.indexOf('LOCAL PATCH (whatsapp-group-broadcast)');
    assert.ok(i > 0, 'patch marker present');
    const block = code.slice(i, i + 600);
    assert.match(block, /try \{\s*state =\s*window\.require\?\.\('WAWebSocketModel'\)\?\.Socket\?\.state;\s*\} catch \(e\) \{\s*return false;\s*\}/);
});
