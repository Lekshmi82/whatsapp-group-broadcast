'use strict';

// link.js - link (or check) the WhatsApp number this project uses.
//
//   node link.js
//
// Opens a VISIBLE Chrome window with WhatsApp Web. If no number is linked yet,
// scan the QR code in that window with the phone:
//   WhatsApp > Settings > Linked devices > Link a device
// The QR keeps refreshing for up to 10 minutes. When linked, it prints which
// number is linked (last 4 digits), waits for chats to sync, and closes.
// If a number is already linked, it just tells you which one. Sends nothing.
//
// The login is saved in .wwebjs_auth (keep it private, never share it).

const path = require('path');
const { Client, LocalAuth } = require('./vendor/whatsapp-web.js-064a3d5');

const LINK_TIMEOUT_MS = 10 * 60 * 1000;
const SYNC_WAIT_MS = 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    const client = new Client({
        authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
        authTimeoutMs: 120000,
        webVersionCache: { type: 'none' }, // live (latest) WhatsApp Web
        qrMaxRetries: 0, // keep refreshing the QR; our own 10-minute limit applies
        puppeteer: { headless: false, defaultViewport: null, protocolTimeout: 15 * 60 * 1000 }, // big accounts load slowly
    });

    let qrShown = false;
    client.on('qr', () => {
        if (!qrShown) {
            console.log('\nA Chrome window with a QR code has opened.');
            console.log('On the phone: WhatsApp > Settings > Linked devices > Link a device, then scan it.');
            console.log('(Waiting up to 10 minutes. The code refreshes by itself.)');
        }
        qrShown = true;
    });
    client.on('authenticated', () => console.log('Scanned. Loading WhatsApp…'));

    let exitCode = 0;
    try {
        console.log('Opening WhatsApp Web in a Chrome window…');
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Not linked within 10 minutes.')), LINK_TIMEOUT_MS);
            client.once('ready', () => { clearTimeout(timer); resolve(); });
            client.once('auth_failure', (m) => { clearTimeout(timer); reject(new Error(`Login failed: ${m}`)); });
            client.once('disconnected', (r) => { clearTimeout(timer); reject(new Error(`Disconnected: ${r}`)); });
            client.initialize().catch((e) => { clearTimeout(timer); reject(e); });
        });
        const user = (client.info && client.info.wid && client.info.wid.user) || '';
        const name = (client.info && client.info.pushname) || '';
        console.log(`\nLINKED: number ending in ${user.slice(-4) || '????'}${name ? ` (${name})` : ''}.`);
        console.log(`Letting chats sync for ${SYNC_WAIT_MS / 1000}s before closing…`);
        await sleep(SYNC_WAIT_MS);
        console.log('Done. Next:  node .\\send-to-groups.js   (lists this number\'s groups)');
    } catch (err) {
        exitCode = 1;
        console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
        await Promise.race([client.destroy().catch(() => {}), sleep(15000)]);
        process.exit(exitCode);
    }
}

main();
