# Vendored whatsapp-web.js

`whatsapp-web.js-064a3d5/` is the official whatsapp-web.js code from the commit below, with **one local patch** (see the end of this file):

- Repository: https://github.com/pedroslopez/whatsapp-web.js
- Commit: `064a3d5a5a3dce1281a6a12740b5a7051339d154` (main branch, 28 Sep 2026)
- Files: `index.js`, `index.d.ts`, `src/`, `package.json`, `LICENSE`, `README.md`.
  Produced with `git archive` and checked file-by-file against the commit.
- Licence: Apache-2.0 (see `LICENSE` inside the folder).

Why not `npm install whatsapp-web.js`? The latest npm release (1.34.7, April 2026)
breaks on WhatsApp Web's July 2026 change (`id._serialized` renamed to `id.$1`).
The fix is in commit `58ddf15` (26 Sep 2026) but has not been published to npm yet.

Its runtime dependencies (`puppeteer`, `node-fetch`, `mime`, `node-webpmux`,
`fluent-ffmpeg`) are listed at the same exact versions in the project's
`package.json`, so npm installs them normally into `node_modules/`.

When npm publishes a newer version than 1.34.7: run
`npm.cmd install --save-exact whatsapp-web.js@<version>`, change the `require` in
`inventory.js` back to `require('whatsapp-web.js')`, delete this folder, and update
the pin test in `test/safety.test.js`.

## Local patch

`src/Client.js`, in `inject()`: the wait for WhatsApp's connection state reads
`window.require('WAWebSocketModel')`. While WhatsApp Web is still loading or reloads
itself during start-up, that call **throws**, so Puppeteer ended the wait immediately
with the generic error "Waiting failed". This failed most connections on the company
number. The patch wraps the read in try/catch and returns "not ready yet", so the wait
keeps polling. The change is marked `LOCAL PATCH` in the file. Upstream `main` (commit
064a3d5, 28 Sep 2026) still has the unpatched line.
