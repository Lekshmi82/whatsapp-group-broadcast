'use strict';

// READ-ONLY WhatsApp group inventory.
// Only these client methods are used: initialize, getChats, getState, destroy.
// It never sends, forwards, deletes, edits or changes anything.

const path = require('path');
const {
    DETAILS_HEADER,
    widString,
    buildInventory,
    compareWithPrevious,
    readPreviousRows,
    writeCsvAtomic,
    setAsidePreviousOutput,
} = require('./lib');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one inventory pass with an already-constructed client.
 * Resolves with the inventory on success; throws on any failure.
 * The caller is responsible for exiting the process.
 */
async function runInventory(client, opts) {
    const {
        outFile,
        previousFile,
        detailsFile,
        detailsPreviousFile,
        readyTimeoutMs,
        syncWaitMs,
        recheckWaitMs,
        maxRechecks,
        log = console.log,
        showQr = () => {},
        progress = {}, // progress.step names the current stage, for error messages
    } = opts;
    progress.step = 'preparing output files';

    // 1. Never leave old output where it could be mistaken for this run's result.
    if (setAsidePreviousOutput(outFile, previousFile)) {
        log(`Moved old ${path.basename(outFile)} to ${path.basename(previousFile)}.`);
    }
    setAsidePreviousOutput(detailsFile, detailsPreviousFile);

    // 2. Watch for disconnection for the whole run.
    let disconnectReason = null;
    let rejectOnDisconnect;
    const disconnected = new Promise((_, reject) => { rejectOnDisconnect = reject; });
    disconnected.catch(() => {}); // avoid "unhandled rejection" if nobody is waiting
    client.on('disconnected', (reason) => {
        disconnectReason = String(reason);
        log(`! WhatsApp client disconnected: ${disconnectReason}`);
        rejectOnDisconnect(new Error(`Client disconnected (${disconnectReason}).`));
    });

    client.on('qr', (qr) => showQr(qr));
    client.on('authenticated', () => log('Authenticated. Loading WhatsApp…'));
    client.on('loading_screen', (percent) => log(`Loading: ${percent}%`));
    client.on('change_state', (state) => log(`Connection state: ${state}`));

    // 3. Wait for "ready" (or fail on auth error / disconnect / timeout).
    const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`Client was not ready within ${readyTimeoutMs / 1000}s (QR not scanned, or WhatsApp Web did not load).`)),
            readyTimeoutMs,
        );
        client.once('ready', () => { clearTimeout(timer); resolve(); });
        client.once('auth_failure', (msg) => {
            clearTimeout(timer);
            reject(new Error(`Authentication failed: ${msg}. Delete .wwebjs_auth/ and scan the QR code again.`));
        });
        disconnected.catch((err) => { clearTimeout(timer); reject(err); });
    });

    progress.step = 'starting the browser and logging in';
    log('Starting WhatsApp Web client…');
    const init = client.initialize();
    // If initialize() itself throws (e.g. browser failed to start), fail fast.
    await Promise.race([ready, init.then(() => ready)]);
    log('Client is ready.');

    // The work number's own ID (documented: client.info.wid). Used only to
    // check whether it is an admin of each group; never printed.
    const meId = (client.info && widString(client.info.wid)) || undefined;

    // Sleep, but stop immediately if we get disconnected meanwhile.
    const waitOrDisconnect = (ms) => Promise.race([sleep(ms), disconnected]);

    // 4. Give WhatsApp time to sync chats from the phone.
    progress.step = 'waiting for chats to synchronise';
    log(`Waiting ${syncWaitMs / 1000}s for chats to synchronise…`);
    await waitOrDisconnect(syncWaitMs);

    // 5. Read chats, then re-read (a limited number of times) until two reads
    //    match. Each read refreshes every group's details, so with many groups
    //    we keep reads to the minimum: normally 2, never more than 1 + maxRechecks.
    const snapshot = async () => buildInventory(await client.getChats(), { meId });
    const fingerprint = (inv) => JSON.stringify(inv.rows.slice().sort());

    progress.step = 'reading the chat list (client.getChats)';
    let inv = await snapshot();
    let stable = false;
    for (let i = 1; i <= maxRechecks; i++) {
        log(`Read ${inv.groups.length} group(s). Re-checking in ${recheckWaitMs / 1000}s (check ${i}/${maxRechecks})…`);
        await waitOrDisconnect(recheckWaitMs);
        const next = await snapshot();
        if (fingerprint(next) === fingerprint(inv)) { stable = true; inv = next; break; }
        log('  Group list changed since last read - WhatsApp is still syncing.');
        inv = next;
    }
    if (!stable) {
        throw new Error('Group list kept changing; sync not finished. Re-run with a larger SYNC_WAIT_SECONDS.');
    }

    // 6. Confirm we are still connected before trusting the data.
    progress.step = 'checking the connection';
    const state = await client.getState();
    if (disconnectReason || state !== 'CONNECTED') {
        throw new Error(`Connection not healthy after reading chats (state=${state}, disconnect=${disconnectReason}).`);
    }
    if (inv.groups.length === 0) {
        throw new Error('No group chats found. Chats may not have synced yet; refusing to write an empty inventory.');
    }

    // 7. Compare with the last successful run (by group ID).
    progress.step = 'writing the CSV files';
    const previousRows = readPreviousRows(previousFile);
    inv.changes = previousRows ? compareWithPrevious(previousRows, inv.rows) : null;

    // 8. Write details first, groups.csv last: if groups.csv exists, both are complete.
    writeCsvAtomic(detailsFile, inv.detailRows, DETAILS_HEADER);
    writeCsvAtomic(outFile, inv.rows);
    return inv;
}

/** Print the summary, Communities and changes (no participant details). */
function printReport(inv, outFile, log = console.log) {
    const label = (g) => `${g.name || '(no name)'}  [${g.id}, ${g.participants} members]`;

    log('\n=== Groups ===');
    for (const g of inv.groups) {
        const hints = Object.keys(g.hints).length ? JSON.stringify(g.hints) : '-';
        log(`${g.id} | ${g.name || '(no name)'} | participants=${g.participants} | role=${g.role} | admins_only=${g.adminsOnly} | work_number=${g.workNumberRole} | raw=${hints}`);
    }

    log('\n=== Communities (from undocumented WhatsApp fields - verify on the phone) ===');
    if (inv.communities.size === 0) {
        log('No Community links were visible in the data.');
        if (inv.groups.every((g) => g.role === 'unknown')) {
            log('WhatsApp exposed no Community fields at all, so Community membership cannot be determined with this library.');
        }
    }
    for (const c of inv.communities.values()) {
        log(`Community ${c.id}`);
        log(`  container:     ${c.container ? label(c.container) : 'NOT returned by getChats() - only referenced by its groups'}`);
        for (const g of c.announcement) log(`  announcements: ${label(g)}`);
        for (const g of c.groups) log(`  group:         ${label(g)}`);
        const rows = (c.container ? 1 : 0) + c.announcement.length + c.groups.length;
        log(`  -> this Community produced ${rows} row(s) in ${path.basename(outFile)}`);
    }

    if (inv.changes) {
        const ch = inv.changes;
        log('\n=== Changes since last successful run ===');
        if (!ch.added.length && !ch.removed.length && !ch.renamed.length && !ch.countChanged.length) log('No changes.');
        for (const x of ch.added) log(`  NEW:      ${x.name} [${x.id}]`);
        for (const x of ch.removed) log(`  GONE:     ${x.name} [${x.id}]`);
        for (const x of ch.renamed) log(`  RENAMED:  "${x.from}" -> "${x.to}" [${x.id}]`);
        for (const x of ch.countChanged) log(`  MEMBERS:  ${x.name}: ${x.from} -> ${x.to} [${x.id}]`);
    }

    const line = (text, value) => log(`${text.padEnd(48)}${value}`);
    log('\n=== Summary ===');
    line('Group chats discovered (before de-duplication):', inv.groupChatsSeen);
    line('Unique groups:', inv.groups.length);
    line('Duplicate IDs skipped:', inv.duplicates.length + (inv.duplicates.length ? ' -> ' + inv.duplicates.join(', ') : ''));
    line(`Rows exported to ${path.basename(outFile)}:`, inv.rows.length);
    line('Communities seen:', inv.communities.size);
    if (inv.unavailable.length) {
        log(`WARNING: participant count unavailable for ${inv.unavailable.length} group(s) (written as "unavailable"):`);
        for (const u of inv.unavailable) log(`  - ${u.id} (${u.name || 'no name'}): ${u.reason}`);
    } else {
        log('Participant counts available for all groups.');
    }
    if (inv.missingNames.length) {
        log(`WARNING: ${inv.missingNames.length} group(s) had no name (left blank): ${inv.missingNames.join(', ')}`);
    }
    log('NOTE: whatsapp-web.js has no documented Community API; Community roles come from undocumented fields.');
}

// ---------------------------------------------------------------------------
// Entry point when run with `node inventory.js` / `npm start`.
// ---------------------------------------------------------------------------
async function main() {
    // Official whatsapp-web.js code, pinned to a fixed GitHub commit (see vendor/README.md).
    const { Client, LocalAuth } = require('./vendor/whatsapp-web.js-064a3d5');
    const qrcode = require('qrcode-terminal');

    const seconds = (name, fallback) => {
        const n = Number(process.env[name] ?? fallback);
        if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
        return n * 1000;
    };
    const here = (file) => path.resolve(__dirname, file);

    const outFile = here('groups.csv');
    const client = new Client({
        authStrategy: new LocalAuth({ dataPath: here('.wwebjs_auth') }),
        authTimeoutMs: 120000, // wait up to 2 minutes for WhatsApp Web to connect
        qrMaxRetries: 5, // stop after a few unscanned QR codes instead of looping forever
        puppeteer: { headless: true },
    });

    // Ctrl+C: close the browser cleanly so the session files are not corrupted.
    let shuttingDown = false;
    process.on('SIGINT', async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log('\nInterrupted - closing client. groups.csv was NOT produced by this run.');
        await client.destroy().catch(() => {});
        process.exit(130);
    });

    let exitCode = 0;
    const progress = { step: 'starting' };
    try {
        const inv = await runInventory(client, {
            progress,
            outFile,
            previousFile: here('groups.previous.csv'),
            detailsFile: here('groups_details.csv'),
            detailsPreviousFile: here('groups_details.previous.csv'),
            readyTimeoutMs: seconds('READY_TIMEOUT_SECONDS', 180),
            syncWaitMs: seconds('SYNC_WAIT_SECONDS', 60),
            recheckWaitMs: seconds('RECHECK_SECONDS', 15),
            maxRechecks: 3,
            showQr: (qr) => {
                // Shown only on the terminal for the authorised user to scan.
                // The raw QR string is never logged or saved.
                console.log('\nScan this QR code: WhatsApp > Linked devices > Link a device');
                qrcode.generate(qr, { small: true });
            },
        });
        printReport(inv, outFile);
        console.log(`\nSUCCESS: wrote ${outFile}`);
        console.log(`         and ${here('groups_details.csv')}`);
    } catch (err) {
        exitCode = 1;
        // Some errors come from WhatsApp's compressed code (e.g. just "r"), so
        // also show where it happened and a few lines of technical detail.
        const e = err instanceof Error ? err : new Error(String(err));
        console.error(`\nFAILED while ${progress.step}: ${e.message}`);
        console.error(`Error type: ${e.name}`);
        const where = (e.stack || '').split('\n').filter((l) => l.trim().startsWith('at ')).slice(0, 5);
        if (where.length) {
            console.error('Technical detail (where it failed):');
            console.error(where.join('\n'));
        }
        console.error('groups.csv was NOT written by this run.');
    } finally {
        // destroy() closes the browser but keeps the saved session (unlike logout()).
        await Promise.race([client.destroy().catch(() => {}), sleep(15000)]);
    }
    process.exit(exitCode);
}

if (require.main === module) {
    main();
}

module.exports = { runInventory, printReport };
