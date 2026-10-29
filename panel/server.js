'use strict';

// WhatsApp Broadcast Panel: a small web app that runs on THIS computer only.
//
//   node panel/server.js        (or double-click "Start WhatsApp Panel.bat" on Windows)
//
// It keeps ONE WhatsApp connection open, and serves a page at http://localhost:3939
// where you pick groups, add an image and a message, send, and see read counts.
// The WhatsApp login (.wwebjs_auth) never leaves this computer. The server only
// listens on 127.0.0.1 and every API call needs the secret token in .panel-token.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { buildInventory, widString } = require('../lib');
const engine = require('../send-to-groups');
const { qrSvg } = require('./qr');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(__dirname, 'public');
const DEFAULT_PORT = Number(process.env.PANEL_PORT) || 3939;
const SPEEDS = { safe: 120, normal: 60, fast: 15 }; // average seconds between groups
const MAX_BODY_BYTES = 9 * 1024 * 1024; // 5 MB image as base64 + message
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errMsg = (err) => (err instanceof Error ? err.message : String(err)).split('\n')[0];

// ------------------------------------------------------------- helpers ----

/** Read or create the secret token that the page must send with every API call. */
function loadToken(dir) {
    const file = path.join(dir, '.panel-token');
    try {
        const t = fs.readFileSync(file, 'utf8').trim();
        if (/^[a-f0-9]{32}$/.test(t)) return t;
    } catch (e) { /* create below */ }
    const t = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(file, t, { encoding: 'utf8', mode: 0o600 });
    return t;
}

/** One row per group in a form the page can use directly. */
function groupView(g) {
    const p = engine.canPost(g);
    return {
        id: g.id, name: g.name || '(no name)', members: g.participants, role: g.role,
        cohort: engine.cohortOf(g.name), canPost: p.ok, reason: p.ok ? '' : p.reason,
    };
}

/** Summarise send-log.csv into one entry per message (newest first). */
function historyFromLog(logFile, messagesDir) {
    if (!fs.existsSync(logFile)) return [];
    const rows = require('../lib').parseCsv(fs.readFileSync(logFile, 'utf8'));
    const header = rows.shift() || [];
    const col = (n) => header.indexOf(n);
    const byHash = new Map();
    for (const r of rows) {
        const hash = r[col('message_hash')];
        if (!hash) continue;
        const status = r[col('status')];
        const h = byHash.get(hash) || { hash, firstAt: r[col('time')], lastAt: r[col('time')], image: r[col('image')] || '', groups: new Map() };
        h.lastAt = r[col('time')];
        const prev = h.groups.get(r[col('group_id')]);
        // keep the most informative status per group: SENT/DELIVERED beat FAILED from an earlier try
        const rank = { FAILED: 1, UNCONFIRMED: 2, NOT_DELIVERED_YET: 3, SENT: 4, DELIVERED: 5 };
        if (!prev || (rank[status] || 0) >= (rank[prev] || 0)) h.groups.set(r[col('group_id')], status);
        byHash.set(hash, h);
    }
    return [...byHash.values()].map((h) => {
        const statuses = [...h.groups.values()];
        let preview = '';
        try { preview = fs.readFileSync(path.join(messagesDir, `${h.hash}.txt`), 'utf8').slice(0, 160); } catch (e) { /* not sent from the panel */ }
        return {
            hash: h.hash, firstAt: h.firstAt, lastAt: h.lastAt, image: h.image, preview,
            groups: statuses.length,
            sent: statuses.filter((s) => s === 'SENT' || s === 'DELIVERED' || s === 'NOT_DELIVERED_YET').length,
            failed: statuses.filter((s) => s === 'FAILED' || s === 'UNCONFIRMED').length,
        };
    }).sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
}

function defaultMakeClient(authDir) {
    // Same settings that proved reliable from the command line on the company number.
    const { Client, LocalAuth } = require('../vendor/whatsapp-web.js-064a3d5');
    return new Client({
        authStrategy: new LocalAuth({ dataPath: authDir }),
        authTimeoutMs: 10 * 60 * 1000,
        webVersionCache: { type: 'none' },
        qrMaxRetries: 0, // keep showing fresh QR codes until someone scans
        puppeteer: { headless: Boolean(process.env.HEADLESS), defaultViewport: null, protocolTimeout: 15 * 60 * 1000 },
    });
}

function makeMedia(mimetype, base64, filename) {
    const { MessageMedia } = require('../vendor/whatsapp-web.js-064a3d5');
    return new MessageMedia(mimetype, base64, filename);
}

// --------------------------------------------------------------- panel ----

/**
 * Create the panel. Everything that touches the outside world can be swapped in
 * tests: makeClient (WhatsApp), makeMediaFn, syncWaitMs, pauseFor.
 */
function createPanel({
    dir = ROOT,
    makeClient = () => defaultMakeClient(path.join(dir, '.wwebjs_auth')),
    makeMediaFn = makeMedia,
    syncWaitMs = (Number(process.env.PANEL_SYNC_SECONDS) || 60) * 1000,
    pauseFor = (gapS) => sleep(gapS * 1000 * (2 / 3 + Math.random() * 2 / 3)),
    token = loadToken(dir),
    log = (...a) => console.log(...a),
} = {}) {
    const files = {
        log: path.join(dir, 'send-log.csv'),
        report: path.join(dir, 'read-report.csv'),
        messages: path.join(dir, 'sent-messages'),
        auth: path.join(dir, '.wwebjs_auth'),
    };
    const state = {
        status: 'starting', // starting | qr | loading | syncing | connected | disconnected | error
        detail: 'Starting WhatsApp…', qr: null, percent: null, me: null, version: null,
        groupsLoadedAt: null,
    };
    let inventory = null;   // result of buildInventory()
    let client = null;
    let job = null;         // the running or last send job
    const plans = new Map(); // planId -> plan (kept 30 min)
    const acks = new Map();  // messageId -> best ack
    const listeners = new Set();

    // ---- live updates to the page (Server-Sent Events) ----
    function publicState() {
        return {
            ...state,
            groupsCount: inventory ? inventory.groups.length : 0,
            job: job && {
                id: job.id, running: job.running, total: job.groups.length, stopRequested: job.stopRequested,
                startedAt: job.startedAt, finishedAt: job.finishedAt, test: job.test,
                results: job.results.map((r) => ({ ...r, ack: Math.max(r.ack || 0, acks.get(r.msgId) || 0) })),
                pending: job.groups.slice(job.results.length).map((g) => ({ id: g.id, name: g.name })),
            },
        };
    }
    function emit() {
        const data = `data: ${JSON.stringify(publicState())}\n\n`;
        for (const res of listeners) res.write(data);
    }

    // ---- WhatsApp connection ----
    async function loadGroups() {
        const meId = client.info && widString(client.info.wid);
        inventory = buildInventory(await client.getChats(), { meId });
        state.groupsLoadedAt = new Date().toISOString();
    }

    async function start() {
        client = makeClient();
        const c = client;
        Object.assign(state, { status: 'starting', detail: 'Starting WhatsApp…', qr: null, percent: null });
        emit();
        c.on('qr', (qr) => {
            if (c !== client) return;
            Object.assign(state, { status: 'qr', detail: 'Scan this QR code with the phone: WhatsApp > Settings > Linked devices > Link a device', qr: qrSvg(qr) });
            emit();
        });
        c.on('authenticated', () => {
            if (c !== client) return;
            Object.assign(state, { status: 'loading', detail: 'Login accepted, loading WhatsApp…', qr: null });
            emit();
        });
        c.on('loading_screen', (percent) => {
            if (c !== client) return;
            if (state.status !== 'connected') Object.assign(state, { status: 'loading', percent, detail: `Loading WhatsApp ${percent}%…` });
            emit();
        });
        c.on('message_ack', (m, a) => {
            const id = m && m.id && (m.id._serialized || m.id.$1);
            if (id) { acks.set(id, Math.max(a, acks.get(id) || 0)); if (job) emit(); }
        });
        c.on('disconnected', (reason) => {
            if (c !== client) return;
            Object.assign(state, { status: 'disconnected', detail: `WhatsApp disconnected (${reason}). Click Reconnect.`, qr: null });
            emit();
        });
        c.on('ready', async () => {
            if (c !== client) return;
            const user = (c.info && c.info.wid && c.info.wid.user) || '';
            state.me = { last4: user.slice(-4), name: (c.info && c.info.pushname) || '' };
            state.version = await c.getWWebVersion().catch(() => null);
            Object.assign(state, { status: 'syncing', detail: `Connected. Letting chats sync for ${Math.round(syncWaitMs / 1000)}s…`, qr: null, percent: null });
            emit();
            await sleep(syncWaitMs);
            if (c !== client) return;
            try {
                await loadGroups();
                Object.assign(state, { status: 'connected', detail: 'Connected and ready.' });
            } catch (err) {
                Object.assign(state, { status: 'connected', detail: `Connected, but loading groups failed (${errMsg(err)}). Click Refresh groups.` });
            }
            emit();
        });
        try {
            await c.initialize();
        } catch (err) {
            if (c !== client) return;
            Object.assign(state, { status: 'error', detail: `Could not start WhatsApp: ${errMsg(err)}. Click Reconnect.` });
            emit();
        }
    }

    async function stopClient() {
        const c = client;
        client = null;
        inventory = null;
        if (c) await Promise.race([c.destroy().catch(() => {}), sleep(15000)]);
    }

    // ---- sending ----
    function makePlan({ groupIds, message, image }) {
        if (!inventory) throw new Error('Groups are not loaded yet. Wait until the panel says "Connected and ready".');
        if (!Array.isArray(groupIds) || groupIds.length === 0) throw new Error('Select at least one group.');
        const ids = [...new Set(groupIds)];
        if (ids.length > engine.MAX_GROUPS_PER_RUN) throw new Error(`Select at most ${engine.MAX_GROUPS_PER_RUN} groups per send.`);
        const text = engine.parseMessage(String(message || ''));
        let media = null; let imageBytes = null; let imageName = '';
        if (image && image.base64) {
            if (!ALLOWED_IMAGE_TYPES.includes(image.type)) throw new Error('The image must be a JPG or PNG.');
            imageBytes = Buffer.from(image.base64, 'base64');
            if (imageBytes.length === 0) throw new Error('The image is empty.');
            if (imageBytes.length > engine.MAX_IMAGE_MB * 1e6) throw new Error(`The image must be under ${engine.MAX_IMAGE_MB} MB.`);
            imageName = String(image.name || 'image').replace(/[^\w.\- ]/g, '_').slice(0, 80);
            media = makeMediaFn(image.type, image.base64, imageName);
        }
        const hash = engine.messageHash(text, imageBytes);
        let toSend; let skipped;
        try {
            ({ toSend, skipped } = engine.planBatch(inventory, ids, hash, engine.readSentLog(files.log)));
        } catch (err) {
            throw new Error(String(err.message).replace('Fix these lines in targets.txt first:', 'Untick these groups first:'));
        }
        const id = crypto.randomBytes(8).toString('hex');
        const plan = { id, toSend, skipped, text, media, imageName, hash, createdAt: Date.now() };
        plans.set(id, plan);
        for (const [k, p] of plans) if (Date.now() - p.createdAt > 30 * 60 * 1000) plans.delete(k);
        return plan;
    }

    async function runJob(plan, speed, test) {
        const gapS = SPEEDS[speed] || SPEEDS.safe;
        fs.mkdirSync(files.messages, { recursive: true });
        fs.writeFileSync(path.join(files.messages, `${plan.hash}.txt`), plan.text, 'utf8');
        job = {
            id: plan.id, groups: plan.toSend, results: [], running: true, stopRequested: false, test,
            startedAt: new Date().toISOString(), finishedAt: null,
        };
        emit();
        try {
            await engine.runBatch(client, plan.toSend, plan.text, {
                hash: plan.hash, logFile: files.log, media: plan.media, imageName: plan.imageName,
                pause: () => pauseFor(gapS),
                log: (line) => log(line),
                shouldStop: () => job.stopRequested,
                onResult: (r) => { job.results.push({ id: r.group.id, name: r.group.name, status: r.status, ack: r.ack, error: r.error, msgId: r.msgId }); emit(); },
            });
        } catch (err) {
            log(`Send job error: ${errMsg(err)}`);
        } finally {
            job.running = false;
            job.finishedAt = new Date().toISOString();
            plans.delete(plan.id);
            emit();
        }
    }

    // ---- HTTP ----
    function send(res, code, body, type = 'application/json; charset=utf-8') {
        res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    }

    function readJson(req) {
        return new Promise((resolve, reject) => {
            let size = 0; const chunks = [];
            req.on('data', (c) => {
                size += c.length;
                if (size > MAX_BODY_BYTES) { reject(new Error('Request too large (image must be under 5 MB).')); req.destroy(); return; }
                chunks.push(c);
            });
            req.on('end', () => {
                try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('Bad request.')); }
            });
            req.on('error', reject);
        });
    }

    const STATIC = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
    const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

    async function handle(req, res) {
        const url = new URL(req.url, 'http://localhost');
        // Only answer requests addressed to this computer (blocks DNS-rebinding tricks).
        const host = String(req.headers.host || '').replace(/:\d+$/, '');
        if (!['localhost', '127.0.0.1'].includes(host)) return send(res, 403, { error: 'Forbidden host.' });

        if (req.method === 'GET' && STATIC[url.pathname]) {
            const file = path.join(PUBLIC, STATIC[url.pathname]);
            return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)]);
        }
        if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });

        // Every API call needs the secret token (header, or ?t= for the live-update stream).
        const given = req.headers['x-panel-token'] || url.searchParams.get('t') || '';
        const ok = given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
        if (!ok) return send(res, 401, { error: 'Open the panel from the desktop shortcut (missing or wrong token).' });

        try {
            if (req.method === 'GET' && url.pathname === '/api/events') {
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
                res.write(`data: ${JSON.stringify(publicState())}\n\n`);
                listeners.add(res);
                const ping = setInterval(() => res.write(': ping\n\n'), 25000);
                req.on('close', () => { clearInterval(ping); listeners.delete(res); });
                return undefined;
            }
            if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, publicState());
            if (req.method === 'GET' && url.pathname === '/api/groups') {
                return send(res, 200, { loadedAt: state.groupsLoadedAt, groups: inventory ? inventory.groups.map(groupView) : [] });
            }
            if (req.method === 'POST' && url.pathname === '/api/groups/refresh') {
                if (!client || state.status !== 'connected') return send(res, 409, { error: 'WhatsApp is not connected yet.' });
                await loadGroups();
                emit();
                return send(res, 200, { loadedAt: state.groupsLoadedAt, groups: inventory.groups.map(groupView) });
            }
            if (req.method === 'POST' && url.pathname === '/api/plan') {
                const body = await readJson(req);
                const plan = makePlan(body);
                return send(res, 200, {
                    planId: plan.id, confirm: `SEND ${plan.toSend.length}`, hash: plan.hash, image: plan.imageName,
                    toSend: plan.toSend.map(groupView), skipped: plan.skipped.map((s) => ({ ...groupView(s.group), reason: s.reason })),
                    members: plan.toSend.reduce((n, g) => n + (Number(g.participants) || 0), 0),
                });
            }
            if (req.method === 'POST' && url.pathname === '/api/send') {
                const body = await readJson(req);
                if (job && job.running) return send(res, 409, { error: 'A send is already running.' });
                if (!client || state.status !== 'connected') return send(res, 409, { error: 'WhatsApp is not connected.' });
                const plan = plans.get(body.planId);
                if (!plan) return send(res, 400, { error: 'This preview expired. Click "Review & send" again.' });
                if (plan.toSend.length === 0) return send(res, 400, { error: 'Nothing to send: every selected group already got this exact message.' });
                if (String(body.confirm || '').trim().toUpperCase() !== `SEND ${plan.toSend.length}`) {
                    return send(res, 400, { error: `Type SEND ${plan.toSend.length} exactly to confirm.` });
                }
                if (!SPEEDS[body.speed]) return send(res, 400, { error: 'Choose a speed: safe, normal or fast.' });
                runJob(plan, body.speed, Boolean(body.test)); // runs in the background; progress goes to /api/events
                return send(res, 202, { started: true, total: plan.toSend.length });
            }
            if (req.method === 'POST' && url.pathname === '/api/stop') {
                if (!job || !job.running) return send(res, 409, { error: 'No send is running.' });
                job.stopRequested = true;
                emit();
                return send(res, 200, { stopping: true });
            }
            if (req.method === 'GET' && url.pathname === '/api/history') {
                return send(res, 200, { history: historyFromLog(files.log, files.messages) });
            }
            if (req.method === 'POST' && url.pathname === '/api/report') {
                if (!client || state.status !== 'connected') return send(res, 409, { error: 'WhatsApp is not connected.' });
                const sent = [...engine.latestSentPerGroup(files.log).values()];
                const rows = await engine.collectReadCounts(client, sent);
                const header = ['checked_at', 'cohort', 'group_name', 'group_id', 'sent_at', 'read', 'delivered_not_read', 'not_read_yet'];
                const now = new Date().toISOString();
                const { csvEscape } = require('../lib');
                fs.writeFileSync(files.report, [header, ...rows.map((r) => [now, r.cohort, r.name, r.groupId, r.sentAt, r.read ?? '', r.delivered ?? '', r.notRead ?? ''])]
                    .map((row) => row.map(csvEscape).join(',')).join('\r\n') + '\r\n', 'utf8');
                return send(res, 200, { checkedAt: now, rows, byCohort: engine.summarizeByCohort(rows) });
            }
            if (req.method === 'GET' && url.pathname === '/api/report.csv') {
                if (!fs.existsSync(files.report)) return send(res, 404, { error: 'No report yet. Click "Check read counts" first.' });
                res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="read-report.csv"' });
                return res.end(fs.readFileSync(files.report));
            }
            if (req.method === 'POST' && url.pathname === '/api/reconnect') {
                if (job && job.running) return send(res, 409, { error: 'Wait until the current send finishes.' });
                await stopClient();
                start();
                return send(res, 200, { restarting: true });
            }
            if (req.method === 'POST' && url.pathname === '/api/switch-number') {
                const body = await readJson(req);
                if (job && job.running) return send(res, 409, { error: 'Wait until the current send finishes.' });
                if (String(body.confirm || '').trim().toUpperCase() !== 'SWITCH') return send(res, 400, { error: 'Type SWITCH to confirm.' });
                await stopClient();
                // Keep the old login (renamed) so it can be restored; never delete it.
                if (fs.existsSync(files.auth)) {
                    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
                    fs.renameSync(files.auth, `${files.auth}_saved_${stamp}`);
                }
                state.me = null;
                start();
                return send(res, 200, { switching: true });
            }
            return send(res, 404, { error: 'Not found.' });
        } catch (err) {
            // Full message (it can list several groups), never a stack trace.
            return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
    }

    const server = http.createServer((req, res) => {
        handle(req, res).catch((err) => { try { send(res, 500, { error: errMsg(err) }); } catch (e) { /* already sent */ } });
    });

    return {
        server, token, state, start, stopClient,
        _internals: { get inventory() { return inventory; }, get job() { return job; }, files },
    };
}

// ----------------------------------------------------------------- main ---

function openBrowser(url) {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
        : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch (e) { /* user can open it by hand */ }
}

if (require.main === module) {
    const panel = createPanel();
    const url = `http://localhost:${DEFAULT_PORT}/#t=${panel.token}`;
    panel.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log('The panel is already running. Opening it in your browser…');
            if (!process.env.NO_BROWSER) openBrowser(url);
            setTimeout(() => process.exit(0), 1500);
            return;
        }
        console.error(`Could not start the panel: ${err.message}`);
        process.exit(1);
    });
    panel.server.listen(DEFAULT_PORT, '127.0.0.1', () => {
        console.log('WhatsApp Broadcast Panel is running.');
        console.log(`Open: ${url}`);
        console.log('Keep this window open while you use the panel. Close it to stop.');
        console.log('A Chrome window with WhatsApp Web also opens: leave it (you can minimise it).');
        if (!process.env.NO_BROWSER) openBrowser(url);
        panel.start();
    });
    const shutdown = async () => { console.log('\nClosing WhatsApp…'); await panel.stopClient(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

module.exports = { createPanel, historyFromLog, groupView, SPEEDS };
