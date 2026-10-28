'use strict';

// send-to-groups.js - send the SAME message (optionally with ONE image) to chosen groups.
//
//   node send-to-groups.js                   LIST: show all groups (read-only) and write
//                                            targets-available.txt (groups you can post to)
//   node send-to-groups.js send              SEND to the group IDs in targets.txt
//   node send-to-groups.js send --all        SEND to every group this number can post to
//   node send-to-groups.js report           how many READ the last message in each group (counts only),
//                                            per group and per cohort; saves read-report.csv. Sends nothing.
//   node send-to-groups.js online [minutes]  stay connected (default 5 min) so phones showing
//                                            "Waiting for this message" can get the keys. Sends nothing.
//
// Extra options for send:
//   --dry-run     do everything except sending (shows the preview)
//   --no-image    send text only even if an image file is present
//   --gap <s>     average seconds between groups (default 60, minimum 15)
//   --targets <file>  use this targets file instead of targets.txt   (e.g. targets-1.txt)
//   --message <file>  use this message file instead of message.txt   (e.g. message-1.txt)
//   --image <file>    send this image (jpg/png/webp) instead of looking for image.jpg/png
//
// Files (all in this folder, all stay on this laptop):
//   targets.txt          one group ID per line (text after the ID is ignored; # = comment)
//   message.txt          the message text; becomes the caption when an image is sent
//   image.jpg / .png     OPTIONAL picture to send with the message (only one image file allowed)
//   send-log.csv         one result line per group, added after every send
//
// Safety: groups are read live from WhatsApp in the same run; every target is
// checked before anything is sent; you must type "SEND <number of groups>";
// groups are sent one at a time with a pause; the run stops at the first problem;
// a group that already received the same message + image is skipped.
//
// Uses the same saved login as inventory.js (.wwebjs_auth). Never run two
// scripts at the same time.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline/promises');
const { buildInventory, csvEscape, parseCsv } = require('./lib');

// Official whatsapp-web.js code with the July 2026 WhatsApp fix (see vendor/README.md).
// The npm copy (1.34.7) fails in getChats() with "r: r" on today's WhatsApp Web.
// This copy also contains the image-sending fix (WhatsApp error "Data passed to getter must
// include an id property"), so no patching is needed.
const { Client, LocalAuth, MessageMedia } = require('./vendor/whatsapp-web.js-064a3d5');

const FILES = {
    targets: path.join(__dirname, 'targets.txt'),
    message: path.join(__dirname, 'message.txt'),
    available: path.join(__dirname, 'targets-available.txt'),
    log: path.join(__dirname, 'send-log.csv'),
    report: path.join(__dirname, 'read-report.csv'),
};
const MAX_GROUPS_PER_RUN = 30;
const MAX_MESSAGE_LENGTH = 4096;   // WhatsApp's practical limit for text and captions
const IMAGE_NAMES = ['image.jpg', 'image.jpeg', 'image.png', 'image.webp'];
const MAX_IMAGE_MB = 5;
const DEFAULT_GAP_S = 60;          // average pause between groups (random +/- a third)
const MIN_GAP_S = 15;
const ACK_WAIT_MS = 60000;         // how long to wait for WhatsApp's server to confirm each message (images take longer)
// After sending, stay online so recipients' phones can fetch the decryption keys from this
// device. Closing straight away leaves them on "Waiting for this message".
const STAY_ONLINE_MIN_MS = 90000;  // always stay at least 90 s after the last send
const STAY_ONLINE_MAX_MS = 300000; // ...and up to 5 min while waiting for "delivered" (ack 2)
const SYNC_WAIT_MS = 60000;  // time for chats to sync after login
// How long WhatsApp Web may take to connect. Numbers in many large groups load slowly.
const CONNECT_TIMEOUT_MS = (Number(process.env.CONNECT_TIMEOUT_SECONDS) || 600) * 1000;
// Puppeteer gives up on any single request to the page after 3 minutes by default. On the
// company number WhatsApp Web is busy loading 80+ large groups for longer than that
// ("Runtime.callFunctionOn timed out"), so allow much longer.
const PROTOCOL_TIMEOUT_MS = CONNECT_TIMEOUT_MS + 5 * 60 * 1000;
const READY_TIMEOUT_MS = CONNECT_TIMEOUT_MS + 120000;
const RETRY_PAUSE_MS = 60000;   // pause before the one automatic connection retry
const LOG_HEADER = ['time', 'group_id', 'group_name', 'image', 'status', 'ack', 'message_hash', 'message_id', 'error'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Random pause around gapS seconds (between 2/3 and 4/3 of it). */
const makePause = (gapS) => () => sleep(gapS * 1000 * (2 / 3 + Math.random() * 2 / 3));

/** Read the command line after "send". */
function parseSendOptions(args) {
    const opts = { all: false, dryRun: false, noImage: false, gapS: DEFAULT_GAP_S, targetsFile: null, messageFile: null, imageFile: null };
    const fileArg = (name, i) => {
        const v = args[i];
        if (!v || v.startsWith('--')) throw new Error(`${name} needs a file name, e.g. ${name} ${name.slice(2)}-1.txt`);
        return v;
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--all') opts.all = true;
        else if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--no-image') opts.noImage = true;
        else if (a === '--gap') {
            const n = Number(args[++i]);
            if (!Number.isFinite(n) || n < MIN_GAP_S) throw new Error(`--gap must be a number of seconds, at least ${MIN_GAP_S}.`);
            opts.gapS = n;
        } else if (a === '--targets') opts.targetsFile = fileArg(a, ++i);
        else if (a === '--message') opts.messageFile = fileArg(a, ++i);
        else if (a === '--image') opts.imageFile = fileArg(a, ++i);
        else throw new Error(`Unknown option "${a}". Options: --all, --dry-run, --no-image, --gap <seconds>, --targets <file>, --message <file>, --image <file>`);
    }
    if (opts.noImage && opts.imageFile) throw new Error('Use either --image or --no-image, not both.');
    if (opts.all && opts.targetsFile) throw new Error('Use either --all or --targets, not both.');
    return opts;
}

/** Check one image file. Returns { path, name, mb }. */
function loadImage(file) {
    const name = path.basename(file);
    if (!fs.existsSync(file)) throw new Error(`Image ${name} was not found in the project folder.`);
    if (!/\.(jpe?g|png|webp)$/i.test(name)) throw new Error(`${name} must be a .jpg, .jpeg, .png or .webp image.`);
    const mb = fs.statSync(file).size / 1e6;
    if (mb > MAX_IMAGE_MB) throw new Error(`${name} is ${mb.toFixed(1)} MB; keep images under ${MAX_IMAGE_MB} MB.`);
    if (mb === 0) throw new Error(`${name} is empty.`);
    return { path: file, name, mb };
}

/** Find the optional image.jpg/png in the folder. Returns null (text only) or { path, name, mb }. */
function findImage(dir) {
    const found = IMAGE_NAMES.filter((n) => fs.existsSync(path.join(dir, n)));
    if (found.length > 1) throw new Error(`Found more than one image (${found.join(', ')}). Keep only one, or use --no-image.`);
    if (!found.length) return null;
    return loadImage(path.join(dir, found[0]));
}

// ------------------------------------------------------------ report -----

/** "C07" from "100x | C07 | Some webinar", else "Other". */
function cohortOf(name) {
    const m = /\|\s*(C\d{2})\s*\|/i.exec(name || '');
    return m ? m[1].toUpperCase() : 'Other';
}

/** The most recent SENT message per group from send-log.csv: Map group_id -> row. */
function latestSentPerGroup(file) {
    const latest = new Map();
    if (!fs.existsSync(file)) return latest;
    const rows = parseCsv(fs.readFileSync(file, 'utf8'));
    const header = rows.shift() || [];
    const col = (n) => header.indexOf(n);
    for (const r of rows) {
        if (r[col('status')] !== 'SENT' || !r[col('message_id')]) continue;
        latest.set(r[col('group_id')], {
            groupId: r[col('group_id')], name: r[col('group_name')], time: r[col('time')],
            msgId: r[col('message_id')], image: r[col('image')] || '',
        });
    }
    return latest;
}

/** Add up read counts per cohort. rows: [{cohort, read, delivered, notRead}] */
function summarizeByCohort(rows) {
    const sum = new Map();
    for (const r of rows) {
        const s0 = sum.get(r.cohort) || { cohort: r.cohort, groups: 0, read: 0, delivered: 0, notRead: 0, unknown: 0 };
        s0.groups++;
        if (r.read === null) s0.unknown++;
        else { s0.read += r.read; s0.delivered += r.delivered; s0.notRead += r.notRead; }
        sum.set(r.cohort, s0);
    }
    return [...sum.values()].sort((a, b) => a.cohort.localeCompare(b.cohort));
}

// --------------------------------------------------------- input files ----

/** targets.txt -> list of group IDs. Throws on anything unclear. */
function parseTargets(text) {
    const ids = [];
    text.replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const id = trimmed.split(/\s+/)[0];
        if (!/^\d+(-\d+)?@g\.us$/.test(id)) {
            throw new Error(`targets.txt line ${i + 1}: "${id}" is not a group ID (it must end in @g.us).`);
        }
        if (ids.includes(id)) throw new Error(`targets.txt line ${i + 1}: ${id} is listed twice.`);
        ids.push(id);
    });
    if (ids.length === 0) throw new Error('targets.txt has no group IDs. Copy lines from targets-available.txt and remove the # in front.');
    if (ids.length > MAX_GROUPS_PER_RUN) throw new Error(`targets.txt has ${ids.length} groups; the limit per run is ${MAX_GROUPS_PER_RUN}.`);
    return ids;
}

/** message.txt -> message text. */
function parseMessage(text) {
    const message = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
    if (!message) throw new Error('message.txt is empty.');
    if (message.length > MAX_MESSAGE_LENGTH) throw new Error(`message.txt is longer than ${MAX_MESSAGE_LENGTH} characters.`);
    return message;
}

/** Short fingerprint of the message (+ image bytes), used to avoid sending the same thing twice. */
function messageHash(message, imageBytes = null) {
    const h = crypto.createHash('sha256').update(message);
    if (imageBytes) h.update(imageBytes);
    return h.digest('hex').slice(0, 12);
}

function readFileOrExplain(file, hint) {
    if (!fs.existsSync(file)) throw new Error(`${path.basename(file)} was not found. ${hint}`);
    return fs.readFileSync(file, 'utf8');
}

// ------------------------------------------------------------ checks ------

/** Can the work number post in this group? */
function canPost(g) {
    if (g.role === 'community_container') {
        return { ok: false, reason: 'is a Community itself (cannot receive messages) - use its Announcements group ID' };
    }
    if (g.adminsOnly === 'yes' && g.workNumberRole !== 'admin') {
        return { ok: false, reason: 'only admins can post there and this account is not an admin' };
    }
    return { ok: true };
}

/** "groupId|hash" for every successful send in send-log.csv. */
function readSentLog(file) {
    const sent = new Set();
    if (!fs.existsSync(file)) return sent;
    const rows = parseCsv(fs.readFileSync(file, 'utf8'));
    const header = rows.shift() || [];
    const col = (name) => header.indexOf(name);
    for (const r of rows) {
        if (r[col('status')] === 'SENT') sent.add(`${r[col('group_id')]}|${r[col('message_hash')]}`);
    }
    return sent;
}

/**
 * Decide what will happen for each target, before anything is sent.
 * Throws (so nothing is sent) if any ID is unknown or not postable.
 */
function planBatch(inv, ids, hash, alreadySent) {
    const problems = [];
    const toSend = [];
    const skipped = [];
    for (const id of ids) {
        const g = inv.groups.find((x) => x.id === id);
        if (!g) { problems.push(`${id}: not found in this WhatsApp account`); continue; }
        const p = canPost(g);
        if (!p.ok) { problems.push(`${id} (${g.name}): ${p.reason}`); continue; }
        if (alreadySent.has(`${id}|${hash}`)) { skipped.push({ group: g, reason: 'already received this exact message (see send-log.csv)' }); continue; }
        toSend.push(g);
    }
    if (problems.length) {
        throw new Error('Nothing was sent. Fix these lines in targets.txt first:\n  - ' + problems.join('\n  - '));
    }
    return { toSend, skipped };
}

// ------------------------------------------------------------ output ------

function appendLog(file, row) {
    if (fs.existsSync(file)) {
        const firstLine = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0];
        if (firstLine !== LOG_HEADER.join(',')) {
            // Older log format: keep it under a new name and start a fresh log.
            fs.renameSync(file, file.replace(/\.csv$/, `.old-${Date.now()}.csv`));
        }
    }
    if (!fs.existsSync(file)) fs.writeFileSync(file, LOG_HEADER.join(',') + '\r\n', 'utf8');
    fs.appendFileSync(file, row.map(csvEscape).join(',') + '\r\n', 'utf8');
}

function availableTargetsText(inv) {
    const lines = [
        '# Groups this account can post to. To choose a group, copy its line into targets.txt',
        '# and delete the "# " at the start. Text after the ID is only a reminder of the name.',
        '',
    ];
    for (const g of inv.groups) {
        if (canPost(g).ok) lines.push(`# ${g.id}  ${g.name || '(no name)'}  [${g.role}, ${g.participants} members]`);
    }
    return lines.join('\r\n') + '\r\n';
}

function printGroups(inv) {
    console.log(`\nFound ${inv.groups.length} group(s):\n`);
    console.log('CAN POST  ROLE                     MEMBERS  GROUP ID                    NAME');
    for (const g of inv.groups) {
        console.log(`${(canPost(g).ok ? 'yes' : 'no').padEnd(9)} ${g.role.padEnd(24)} ${String(g.participants).padEnd(8)} ${g.id.padEnd(27)} ${g.name || '(no name)'}`);
    }
}

// ----------------------------------------------------------- sending ------

/**
 * Send one message and wait until WhatsApp's server confirms it (ack >= 1).
 * ack: 0 = pending, 1 = server received, 2 = delivered, 3 = read.
 */
async function sendOne(client, groupId, message, ackWaitMs = ACK_WAIT_MS, media = null) {
    const acks = new Map();
    let onAck = null;
    const listener = (m, a) => {
        const id = m && m.id && (m.id._serialized || m.id.$1);
        if (!id) return;
        acks.set(id, Math.max(a, acks.get(id) ?? -1));
        if (onAck) onAck(id);
    };
    client.on('message_ack', listener); // listen BEFORE sending so a fast confirmation is not missed
    try {
        const sent = media
            ? await client.sendMessage(groupId, media, { caption: message, sendSeen: false, waitUntilMsgSent: true })
            : await client.sendMessage(groupId, message, { sendSeen: false, linkPreview: false, waitUntilMsgSent: true });
        const msgId = sent && sent.id && (sent.id._serialized || sent.id.$1);
        if (!msgId) throw new Error('WhatsApp did not return a message ID');
        const best = () => Math.max(typeof sent.ack === 'number' ? sent.ack : 0, acks.get(msgId) ?? 0);
        if (best() < 1) {
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, ackWaitMs);
                onAck = (id) => { if (id === msgId && best() >= 1) { clearTimeout(timer); resolve(); } };
            });
        }
        return { msgId, ack: best() };
    } finally {
        client.removeListener('message_ack', listener);
    }
}

/**
 * Send to each group in order. Stops at the first failure or unconfirmed send.
 * Every attempt is written to the log. Returns one result per attempted group.
 */
async function runBatch(client, groups, message, { hash, logFile, pause = makePause(DEFAULT_GAP_S), ackWaitMs = ACK_WAIT_MS, log = console.log, media = null, imageName = '' }) {
    const results = [];
    for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        if (i > 0) { log('   waiting before the next group…'); await pause(); }
        let status; let ack = ''; let msgId = ''; let error = '';
        try {
            ({ msgId, ack } = await sendOne(client, g.id, message, ackWaitMs, media));
            status = ack >= 1 ? 'SENT' : 'UNCONFIRMED';
        } catch (err) {
            status = 'FAILED';
            error = (err instanceof Error ? err.message : String(err)).split('\n')[0];
        }
        appendLog(logFile, [new Date().toISOString(), g.id, g.name, imageName, status, ack, hash, msgId, error]);
        results.push({ group: g, status, ack, error, msgId });
        log(`[${i + 1}/${groups.length}] ${status.padEnd(11)} ${g.name}  (${g.id})${error ? ' - ' + error : ''}`);
        if (status !== 'SENT') {
            log('Stopping here so nothing is sent twice by mistake. Check this group on the phone.');
            break;
        }
    }
    return results;
}

/**
 * Stay connected until every sent message is delivered to a phone (ack >= 2), or the
 * maximum time passes. Always stays at least minMs. acks: Map of messageId -> best ack.
 * Returns Map of messageId -> final ack.
 */
async function waitForDelivery(acks, msgIds, { minMs = STAY_ONLINE_MIN_MS, maxMs = STAY_ONLINE_MAX_MS, tickMs = 5000, log = console.log } = {}) {
    const start = Date.now();
    const delivered = () => msgIds.every((id) => (acks.get(id) ?? 0) >= 2);
    log(`\nStaying online so the phones can receive and unlock the message (at least ${Math.round(minMs / 1000)}s, up to ${Math.round(maxMs / 60000)} min)…`);
    while (Date.now() - start < maxMs) {
        if (Date.now() - start >= minMs && delivered()) break;
        await sleep(tickMs);
    }
    return new Map(msgIds.map((id) => [id, acks.get(id) ?? 0]));
}

function ackLabel(ack) {
    if (ack >= 3) return 'READ';
    if (ack >= 2) return 'DELIVERED';
    if (ack >= 1) return 'SERVER ONLY (not yet on any phone)';
    return 'PENDING';
}

// ------------------------------------------------------- WhatsApp ---------

async function connect(client) {
    const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`WhatsApp was not ready within ${Math.round(READY_TIMEOUT_MS / 60000)} minutes.`)), READY_TIMEOUT_MS);
        client.once('ready', () => { clearTimeout(timer); resolve(); });
        client.once('auth_failure', (m) => { clearTimeout(timer); reject(new Error(`Login failed: ${m}`)); });
        client.once('disconnected', (r) => { clearTimeout(timer); reject(new Error(`Disconnected: ${r}`)); });
    });
    client.on('qr', () => console.log('A QR code was requested: the saved login was not accepted. Run "node .\\link.js" to scan it.'));
    // Show progress so a slow or stuck connection is visible.
    let lastPercent = -1;
    client.on('loading_screen', (percent) => {
        if (percent !== lastPercent) console.log(`  loading WhatsApp: ${percent}%`);
        lastPercent = percent;
    });
    client.on('change_state', (state) => console.log(`  connection state: ${state}`));
    client.on('authenticated', () => console.log('  saved login accepted, loading chats…'));
    console.log(`Starting WhatsApp Web (saved login, up to ${Math.round(CONNECT_TIMEOUT_MS / 60000)} min to connect)…`);
    try {
        await Promise.race([ready, client.initialize().then(() => ready)]);
    } catch (err) {
        let msg = err instanceof Error ? err.message : String(err);
        // Puppeteer hides the real reason of "Waiting failed" in err.cause; show it.
        if (err && err.cause) msg += `: ${err.cause.message || err.cause}`;
        if (/Waiting failed|auth timeout/.test(msg)) {
            throw new Error(`WhatsApp Web did not finish connecting within ${Math.round(CONNECT_TIMEOUT_MS / 60000)} min (${msg}).`);
        }
        throw err;
    }
    const version = await client.getWWebVersion().catch(() => 'unknown');
    console.log(`WhatsApp is ready (WhatsApp Web version ${version}, loaded live).`);
}

async function readGroups(client) {
    console.log(`Waiting ${SYNC_WAIT_MS / 1000}s for chats to sync…`);
    await sleep(SYNC_WAIT_MS);
    const meId = client.info && client.info.wid && (client.info.wid._serialized || client.info.wid.$1);
    const inv = buildInventory(await client.getChats(), { meId });
    if ((await client.getState()) !== 'CONNECTED') throw new Error('Connection lost while reading groups.');
    if (inv.groups.length === 0) throw new Error('No groups found yet; WhatsApp may still be syncing. Try again.');
    return inv;
}

// ----------------------------------------------------------- main ---------

async function main() {
    const [mode = 'list', ...rest] = process.argv.slice(2);
    const usage = 'Use:  node send-to-groups.js                  (list groups)\n'
        + '      node send-to-groups.js send             (send to targets.txt)\n'
        + '      node send-to-groups.js send --all       (send to every group you can post to)\n'
        + '      node send-to-groups.js report           (how many read the last message per group)\n'
        + '      node send-to-groups.js online [minutes] (stay connected, sends nothing)\n'
        + 'Options for send: --dry-run  --no-image  --gap <seconds>';
    let onlineMinutes = 5;
    if (mode === 'online') {
        if (rest.length > 1 || (rest.length === 1 && !(Number(rest[0]) >= 1 && Number(rest[0]) <= 30))) {
            console.error('online takes an optional number of minutes from 1 to 30, e.g.  node send-to-groups.js online 5');
            process.exit(2);
        }
        if (rest.length === 1) onlineMinutes = Number(rest[0]);
    }
    if (!['list', 'send', 'online', 'report'].includes(mode) || ((mode === 'list' || mode === 'report') && rest.length)) {
        console.error(usage);
        process.exit(2);
    }

    // SEND: check options and files before opening WhatsApp at all.
    let opts; let ids = null; let message; let image = null; let media = null; let hash;
    if (mode === 'send') {
        try {
            opts = parseSendOptions(rest);
            if (!opts.dryRun && !process.stdin.isTTY) throw new Error('SEND must be run by a person in a terminal (it asks for confirmation).');
            const inFolder = (f) => path.resolve(__dirname, f);
            if (!opts.all) {
                ids = parseTargets(readFileOrExplain(opts.targetsFile ? inFolder(opts.targetsFile) : FILES.targets,
                    'Run LIST first and create the targets file from targets-available.txt, or use: send --all'));
            }
            message = parseMessage(readFileOrExplain(opts.messageFile ? inFolder(opts.messageFile) : FILES.message, 'Create the message file with the text to send.'));
            image = opts.noImage ? null : (opts.imageFile ? loadImage(inFolder(opts.imageFile)) : findImage(__dirname));
            const imageBytes = image ? fs.readFileSync(image.path) : null;
            if (image) media = MessageMedia.fromFilePath(image.path);
            hash = messageHash(message, imageBytes);
        } catch (err) {
            console.error(`ERROR: ${err.message}\n\n${usage}`);
            process.exit(2);
        }
    }

    const acks = new Map(); // messageId -> best ack seen, for the delivery check after sending
    const makeClient = () => {
        const c = new Client({
            authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
            authTimeoutMs: CONNECT_TIMEOUT_MS,
            webVersionCache: { type: 'none' }, // always load the live (latest) WhatsApp Web, never a cached copy
            qrMaxRetries: 1,
            // Visible Chrome window by default: on the company number, hidden (headless) mode
            // repeatedly failed to load WhatsApp Web while the visible window connected at once.
            // Set HEADLESS=1 to hide the window.
            puppeteer: { headless: Boolean(process.env.HEADLESS), defaultViewport: null, protocolTimeout: PROTOCOL_TIMEOUT_MS },
        });
        c.on('message_ack', (m, a) => {
            const id = m && m.id && (m.id._serialized || m.id.$1);
            if (id) acks.set(id, Math.max(a, acks.get(id) ?? 0));
        });
        return c;
    };
    let client = null;
    let sending = false;
    process.on('SIGINT', async () => {
        console.log(sending ? '\nStopped. Check send-log.csv for what was already sent.' : '\nCancelled. Nothing was sent.');
        if (client) await client.destroy().catch(() => {});
        process.exit(130);
    });

    let exitCode = 0;
    try {
        // Connect, with ONE automatic retry if WhatsApp Web is slow (nothing has been sent yet).
        for (let attempt = 1; attempt <= 2; attempt++) {
            client = makeClient();
            try {
                await connect(client);
                break;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                await Promise.race([client.destroy().catch(() => {}), sleep(15000)]);
                if (attempt === 2 || !/did not finish connecting|not ready within|timed out/.test(msg)) throw err;
                console.log(`\n${msg}\nTrying once more in ${RETRY_PAUSE_MS / 1000}s (nothing has been sent)…\n`);
                await sleep(RETRY_PAUSE_MS);
            }
        }
        if (mode === 'online') {
            console.log(`Staying connected for ${onlineMinutes} minute(s) so phones can fetch any pending message keys. Nothing will be sent.`);
            await sleep(onlineMinutes * 60000);
            console.log('Done. Check the groups on the phones again.');
            return;
        }
        if (mode === 'report') {
            const sent = [...latestSentPerGroup(FILES.log).values()];
            if (!sent.length) {
                console.log('send-log.csv has no sent messages yet. Nothing to report.');
                return;
            }
            console.log(`Waiting ${SYNC_WAIT_MS / 1000}s so WhatsApp can load the latest read receipts…`);
            await sleep(SYNC_WAIT_MS);
            const rows = [];
            for (const e of sent) {
                let info = null;
                try {
                    const m = await client.getMessageById(e.msgId);
                    info = m ? await m.getInfo() : null;
                } catch (err) {
                    info = null;
                }
                rows.push({
                    cohort: cohortOf(e.name), name: e.name, groupId: e.groupId, sentAt: e.time,
                    read: info && Array.isArray(info.read) ? info.read.length : null,
                    delivered: info && Array.isArray(info.delivery) ? info.delivery.length : null,
                    notRead: info && typeof info.readRemaining === 'number' ? info.readRemaining : null,
                });
            }
            rows.sort((a, b) => a.cohort.localeCompare(b.cohort) || a.name.localeCompare(b.name));
            const show = (v) => (v === null ? '?' : String(v));
            console.log('\nREAD    DELIVERED  NOT READ  COHORT  GROUP');
            for (const r of rows) {
                console.log(`${show(r.read).padEnd(7)} ${show(r.delivered).padEnd(10)} ${show(r.notRead).padEnd(9)} ${r.cohort.padEnd(7)} ${r.name}`);
            }
            console.log('\nBy cohort:');
            for (const c of summarizeByCohort(rows)) {
                console.log(`  ${c.cohort.padEnd(6)} ${c.groups} group(s): ${c.read} read, ${c.delivered} delivered but not read yet${c.unknown ? `, ${c.unknown} group(s) without data` : ''}`);
            }
            const header = ['checked_at', 'cohort', 'group_name', 'group_id', 'sent_at', 'read', 'delivered_not_read', 'not_read_yet'];
            const now = new Date().toISOString();
            fs.writeFileSync(FILES.report, [header, ...rows.map((r) => [now, r.cohort, r.name, r.groupId, r.sentAt, r.read ?? '', r.delivered ?? '', r.notRead ?? ''])]
                .map((row) => row.map(csvEscape).join(',')).join('\r\n') + '\r\n', 'utf8');
            console.log('\nSaved read-report.csv. "Read" counts only people with read receipts on, so the real number is higher.');
            return;
        }
        const inv = await readGroups(client);
        printGroups(inv); // live list from WhatsApp, in the same run
        fs.writeFileSync(FILES.available, availableTargetsText(inv), 'utf8');

        if (mode === 'list') {
            console.log(`\nWrote ${path.basename(FILES.available)} (groups you can post to).`);
            console.log('LIST finished. Nothing was sent.');
        } else {
            if (opts.all) {
                ids = inv.groups.filter((g) => canPost(g).ok).map((g) => g.id);
                if (ids.length > MAX_GROUPS_PER_RUN) {
                    throw new Error(`--all would send to ${ids.length} groups; the limit per run is ${MAX_GROUPS_PER_RUN}. Put the groups in targets.txt in batches.`);
                }
            }
            const { toSend, skipped } = planBatch(inv, ids, hash, readSentLog(FILES.log));

            console.log('\n================ PREVIEW ================');
            console.log(image
                ? `Image:   ${image.name} (${(image.mb * 1000).toFixed(0)} KB) - message.txt is the caption`
                : 'Image:   none (text only)');
            console.log('Message:\n------------------------------------------');
            console.log(message);
            console.log('------------------------------------------');
            console.log(`Will send to ${toSend.length} group(s)${opts.all ? ' (--all: every group this number can post to)' : ''}:`);
            toSend.forEach((g, i) => console.log(`  ${i + 1}. ${g.name}  (${g.id}, ${g.role}, ${g.participants} members)`));
            for (const sk of skipped) console.log(`  SKIP: ${sk.group.name} (${sk.group.id}) - ${sk.reason}`);
            if (toSend.length > 1) {
                console.log(`About ${opts.gapS}s between groups: roughly ${Math.ceil(((toSend.length - 1) * opts.gapS) / 60)} minute(s) in total.`);
            }

            if (toSend.length === 0) {
                console.log('\nNothing to send.');
            } else if (opts.dryRun) {
                console.log('\nDRY RUN: nothing was sent.');
            } else {
                const expected = `SEND ${toSend.length}`;
                const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                const answer = await rl.question(`\nType  ${expected}  to send, or press Enter to cancel: `);
                rl.close();
                if (answer.trim().toUpperCase() !== expected) {
                    console.log('Cancelled. Nothing was sent.');
                } else {
                    sending = true;
                    console.log('');
                    const results = await runBatch(client, toSend, message, {
                        hash, logFile: FILES.log, pause: makePause(opts.gapS), media, imageName: image ? image.name : '',
                    });
                    const ok = results.filter((r) => r.status === 'SENT').length;
                    const sentResults = results.filter((r) => r.status === 'SENT');
                    if (sentResults.length) {
                        const final = await waitForDelivery(acks, sentResults.map((r) => r.msgId));
                        console.log('\nDelivery:');
                        for (const r of sentResults) {
                            const a = Math.max(final.get(r.msgId) ?? 0, r.ack || 0);
                            console.log(`  ${ackLabel(a).padEnd(36)} ${r.group.name}  (${r.group.id})`);
                            appendLog(FILES.log, [new Date().toISOString(), r.group.id, r.group.name, image ? image.name : '', a >= 2 ? 'DELIVERED' : 'NOT_DELIVERED_YET', a, hash, r.msgId, '']);
                        }
                        if (sentResults.some((r) => Math.max(final.get(r.msgId) ?? 0, r.ack || 0) < 2)) {
                            console.log('Some messages reached WhatsApp but no phone yet. Run  node .\\send-to-groups.js online  to stay connected longer.');
                        }
                    }
                    console.log(`\nRESULT: ${ok} of ${toSend.length} group(s) sent. Details: send-log.csv`);
                    if (ok !== toSend.length) exitCode = 1;
                }
            }
        }
    } catch (err) {
        exitCode = 1;
        console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`);
        console.error(sending ? 'Check send-log.csv for what was already sent.' : 'Nothing was sent.');
    } finally {
        if (client) await Promise.race([client.destroy().catch(() => {}), sleep(15000)]);
        process.exit(exitCode); // always exit here, including after "online" mode
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    parseTargets, parseMessage, parseSendOptions, findImage, loadImage, cohortOf, latestSentPerGroup, summarizeByCohort, messageHash, canPost, readSentLog, planBatch,
    appendLog, availableTargetsText, sendOne, runBatch, waitForDelivery, ackLabel, MAX_GROUPS_PER_RUN, LOG_HEADER,
};
