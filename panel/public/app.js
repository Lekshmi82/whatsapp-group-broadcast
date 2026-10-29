'use strict';
/* WhatsApp Broadcast Panel - browser side. Talks only to the panel server on this computer. */

const $ = (id) => document.getElementById(id);
const MAX_CHARS = 4096;
const MAX_IMAGE_BYTES = 5 * 1000 * 1000;
const GAP_S = { safe: 120, normal: 60, fast: 15 };

// ---- access key (comes in the URL #t=… from the desktop shortcut) ----
const token = (() => {
  const m = /[#&]t=([a-f0-9]{32})/.exec(location.hash);
  if (m) { try { sessionStorage.setItem('panelToken', m[1]); } catch (e) {} history.replaceState(null, '', '/'); return m[1]; }
  try { return sessionStorage.getItem('panelToken') || ''; } catch (e) { return ''; }
})();
if (!token) $('token-warning').hidden = false;

async function api(method, url, body) {
  const res = await fetch(url, {
    method, headers: { 'X-Panel-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---- state ----
let groups = [];              // [{id,name,members,role,cohort,canPost,reason}]
let groupsLoadedAt = null;
const selected = new Set();
let image = null;             // {name,type,base64,dataUrl}
let lastState = null;
let lastJobFinished = null;

// ---- WhatsApp text formatting preview (safe: escape first, then add tags) ----
function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function formatWhatsApp(text) {
  if (!text.trim()) return '<span class="muted">Your message will appear here.</span>';
  let h = escapeHtml(text);
  const blocks = [];
  h = h.replace(/```([\s\S]+?)```/g, (_, c) => { blocks.push(`<code>${c}</code>`); return `\u0000${blocks.length - 1}\u0000`; });
  h = h.replace(/`([^`\n]+)`/g, (_, c) => { blocks.push(`<code>${c}</code>`); return `\u0000${blocks.length - 1}\u0000`; });
  h = h.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, (u) => { blocks.push(`<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`); return `\u0000${blocks.length - 1}\u0000`; });
  const edge = (mark, tag) => {
    const m = mark.replace(/[*~]/g, '\\$&');
    h = h.replace(new RegExp(`(^|[\\s(])${m}(?!\\s)([^\\n]*?[^\\s])${m}(?=$|[\\s).,!?:;])`, 'gm'), `$1<${tag}>$2</${tag}>`);
  };
  edge('*', 'strong'); edge('_', 'em'); edge('~', 's');
  h = h.replace(/^&gt; (.*)$/gm, '<span style="border-left:3px solid #8a8a8a;padding-left:6px;display:inline-block">$1</span>');
  h = h.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  return h.replace(/\n/g, '<br>');
}

// ---- connection ----
function renderConnection(s) {
  const pill = $('conn-pill');
  const map = {
    starting: ['Starting…', 'pill-wait'], qr: ['Scan QR code', 'pill-wait'], loading: ['Loading…', 'pill-wait'],
    syncing: ['Syncing chats…', 'pill-wait'], connected: ['Connected', 'pill-ok'],
    disconnected: ['Disconnected', 'pill-bad'], error: ['Error', 'pill-bad'],
  };
  const [label, cls] = map[s.status] || ['…', 'pill-wait'];
  pill.textContent = label; pill.className = `pill ${cls}`;
  $('conn-detail').textContent = s.detail || '';
  const qrBox = $('qr-box');
  if (s.status === 'qr' && s.qr) { qrBox.innerHTML = s.qr; qrBox.hidden = false; } else { qrBox.hidden = true; qrBox.textContent = ''; }
  const info = $('conn-info');
  if (s.me && ['syncing', 'connected'].includes(s.status)) {
    info.hidden = false; $('me-last4').textContent = s.me.last4 || '????';
    $('me-name').textContent = s.me.name ? `(${s.me.name})` : '';
    $('wa-version').textContent = s.version ? `WhatsApp Web ${s.version}` : '';
  } else info.hidden = true;
}

// ---- groups ----
async function loadGroups(refresh = false) {
  try {
    const data = refresh ? await api('POST', '/api/groups/refresh') : await api('GET', '/api/groups');
    groups = data.groups.sort((a, b) => Number(b.canPost) - Number(a.canPost) || a.cohort.localeCompare(b.cohort) || a.name.localeCompare(b.name));
    groupsLoadedAt = data.loadedAt;
    for (const id of [...selected]) if (!groups.some((g) => g.id === id && g.canPost)) selected.delete(id);
    renderGroups(); renderTestOptions(); renderSummary();
  } catch (err) { showError(err.message); }
}

function visibleGroups() {
  const q = $('group-search').value.trim().toLowerCase();
  return groups.filter((g) => !q || g.name.toLowerCase().includes(q) || g.cohort.toLowerCase() === q);
}

function renderGroups() {
  const list = $('group-list');
  list.textContent = '';
  for (const g of visibleGroups()) {
    const li = document.createElement('li');
    if (!g.canPost) li.className = 'disabled';
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = selected.has(g.id); cb.disabled = !g.canPost;
    cb.addEventListener('change', () => { if (cb.checked) selected.add(g.id); else selected.delete(g.id); renderSummary(); renderChips(); });
    const name = document.createElement('span'); name.className = 'gname'; name.textContent = g.name;
    if (!g.canPost) name.title = `Can't post: ${g.reason}`;
    const meta = document.createElement('span'); meta.className = 'gmeta';
    meta.textContent = `${Number(g.members).toLocaleString()} members · ${g.role.replace(/_/g, ' ')}`;
    label.append(cb, name, meta); li.append(label); list.append(li);
  }
  if (!list.children.length) { const li = document.createElement('li'); li.className = 'muted'; li.textContent = groups.length ? 'No groups match.' : 'Groups appear here once WhatsApp is connected.'; list.append(li); }
  renderChips();
}

function renderChips() {
  const box = $('cohort-chips');
  box.textContent = '';
  const cohorts = [...new Set(groups.filter((g) => g.canPost).map((g) => g.cohort))].sort((a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b));
  for (const c of cohorts) {
    const ids = groups.filter((g) => g.canPost && g.cohort === c).map((g) => g.id);
    const all = ids.every((id) => selected.has(id));
    const chip = document.createElement('button');
    chip.type = 'button'; chip.className = 'chip'; chip.setAttribute('aria-pressed', String(all));
    chip.textContent = `${c} (${ids.length})`;
    chip.addEventListener('click', () => { ids.forEach((id) => (all ? selected.delete(id) : selected.add(id))); renderGroups(); renderSummary(); });
    box.append(chip);
  }
}

function renderSummary() {
  const chosen = groups.filter((g) => selected.has(g.id));
  const members = chosen.reduce((n, g) => n + (Number(g.members) || 0), 0);
  $('groups-label').textContent = groups.length ? (chosen.length ? `${chosen.length} group(s) selected` : 'Select groups…') : 'Groups are loading…';
  $('groups-summary').textContent = chosen.length
    ? `${chosen.length} group(s) selected · about ${members.toLocaleString()} members (people in several groups are counted more than once)`
    : 'No groups selected.';
  renderEta();
}

function renderTestOptions() {
  const sel = $('test-group'); const keep = sel.value;
  sel.textContent = '';
  sel.append(new Option('Choose a test group…', ''));
  const postable = groups.filter((g) => g.canPost);
  postable.sort((a, b) => Number(/test/i.test(b.name)) - Number(/test/i.test(a.name)) || a.members - b.members);
  for (const g of postable) sel.append(new Option(`${g.name} (${g.members} members)`, g.id));
  if (keep && postable.some((g) => g.id === keep)) sel.value = keep;
}

function speed() { return document.querySelector('input[name=speed]:checked').value; }
function renderEta() {
  const n = selected.size;
  $('eta').textContent = n > 1 ? `About ${Math.ceil(((n - 1) * GAP_S[speed()]) / 60)} minute(s) for ${n} groups at this speed.` : '';
}

// ---- image ----
function readAsDataUrl(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); }
function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That file is not a readable image.')); i.src = src; }); }

async function setImage(file) {
  hideError();
  if (!file) return;
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return showError('Please use a JPG, PNG or WEBP image.');
  let dataUrl = await readAsDataUrl(file);
  let type = file.type; let name = file.name;
  // WEBP can arrive as a sticker on WhatsApp, and very large files are refused: convert to JPG.
  if (type === 'image/webp' || file.size > MAX_IMAGE_BYTES) {
    const img = await loadImg(dataUrl);
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 2048 / Math.max(img.width, img.height));
    canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    let q = 0.92;
    do { dataUrl = canvas.toDataURL('image/jpeg', q); q -= 0.08; } while (dataUrl.length * 0.75 > MAX_IMAGE_BYTES && q > 0.4);
    type = 'image/jpeg'; name = name.replace(/\.[^.]+$/, '') + '.jpg';
  }
  const base64 = dataUrl.split(',')[1];
  if (base64.length * 0.75 > MAX_IMAGE_BYTES) return showError('The image is still over 5 MB. Please use a smaller one.');
  image = { name, type, base64, dataUrl };
  $('image-name').textContent = `${name} · ${Math.round((base64.length * 0.75) / 1000)} KB${file.type === 'image/webp' ? ' (converted from WEBP)' : ''}`;
  $('image-info').hidden = false;
  renderPreview();
}

// ---- preview ----
function renderPreview() {
  const text = $('message').value;
  $('char-count').textContent = text.length;
  $('char-count').style.color = text.length > MAX_CHARS ? 'var(--danger)' : '';
  $('preview-text').innerHTML = formatWhatsApp(text);
  const img = $('preview-img');
  if (image) { img.src = image.dataUrl; img.hidden = false; } else { img.hidden = true; img.removeAttribute('src'); }
}

// ---- errors ----
function showError(msg) { const e = $('send-error'); e.textContent = msg; e.hidden = false; e.scrollIntoView({ block: 'nearest' }); }
function hideError() { $('send-error').hidden = true; }

// ---- sending ----
let currentPlan = null; let currentIsTest = false;

function payload(groupIds) {
  return { groupIds, message: $('message').value, image: image ? { name: image.name, type: image.type, base64: image.base64 } : null };
}

async function review(groupIds, isTest) {
  hideError();
  if (!groupIds.length) return showError(isTest ? 'Choose a test group first.' : 'Select at least one group.');
  if (!$('message').value.trim()) return showError('Write the message first.');
  try {
    currentPlan = await api('POST', '/api/plan', payload(groupIds));
    currentIsTest = isTest;
  } catch (err) { return showError(err.message); }
  const p = currentPlan;
  if (p.toSend.length === 0) return showError('Nothing to send: the selected group(s) already received this exact message and image.');
  $('confirm-title').textContent = isTest ? 'Send a test' : 'Check before sending';
  $('confirm-summary').textContent = `${p.toSend.length} group(s), about ${p.members.toLocaleString()} members · ${p.image ? `image: ${p.image}` : 'no image'} · speed: ${speed()}`;
  const list = $('confirm-list'); list.textContent = '';
  for (const g of p.toSend) { const li = document.createElement('li'); const a = document.createElement('span'); a.textContent = g.name; const b = document.createElement('span'); b.className = 'muted'; b.textContent = `${g.members} members`; li.append(a, b); list.append(li); }
  $('confirm-skipped').textContent = p.skipped.length ? `Skipped (already got this exact message): ${p.skipped.map((s) => s.name).join(', ')}` : '';
  $('confirm-word').textContent = p.confirm;
  $('confirm-input').value = ''; $('confirm-error').hidden = true;
  $('confirm-dialog').showModal(); $('confirm-input').focus();
}

async function confirmSend(ev) {
  ev.preventDefault();
  const typed = $('confirm-input').value.trim().toUpperCase();
  if (typed !== currentPlan.confirm) { $('confirm-error').textContent = `Type ${currentPlan.confirm} exactly.`; $('confirm-error').hidden = false; return; }
  try {
    await api('POST', '/api/send', { planId: currentPlan.planId, confirm: typed, speed: currentIsTest ? 'fast' : speed(), test: currentIsTest });
    $('confirm-dialog').close();
    $('card-progress').hidden = false; $('card-progress').scrollIntoView({ behavior: 'smooth' });
  } catch (err) { $('confirm-error').textContent = err.message; $('confirm-error').hidden = false; }
}

function statusLabel(r) {
  if (r.status === 'SENT') return r.ack >= 3 ? ['Read by someone', 'st-ok'] : r.ack >= 2 ? ['Delivered', 'st-ok'] : ['Sent', 'st-ok'];
  if (r.status === 'FAILED') return [`Failed: ${r.error || ''}`, 'st-bad'];
  return [r.status, 'st-bad'];
}

function renderJob(job) {
  if (!job) return;
  $('card-progress').hidden = false;
  const done = job.results.length; const total = job.total;
  $('progress-bar').style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  const ok = job.results.filter((r) => r.status === 'SENT').length;
  const failed = job.results.filter((r) => r.status !== 'SENT').length;
  $('h-progress').textContent = job.test ? 'Test send' : 'Sending';
  $('progress-text').textContent = job.running
    ? `${done} of ${total} done${job.stopRequested ? ' · stopping after the current group…' : ''} · keep this page and the Chrome window open`
    : `Finished: ${ok} sent${failed ? `, ${failed} failed` : ''}${done < total ? `, ${total - done} not sent` : ''}.`;
  const list = $('progress-list'); list.textContent = '';
  for (const r of job.results) { const [t, c] = statusLabel(r); const li = document.createElement('li'); const a = document.createElement('span'); a.textContent = r.name; const b = document.createElement('span'); b.className = `st ${c}`; b.textContent = t; li.append(a, b); list.append(li); }
  for (const g of job.pending) { const li = document.createElement('li'); const a = document.createElement('span'); a.textContent = g.name; const b = document.createElement('span'); b.className = 'st st-wait'; b.textContent = job.running ? 'Waiting' : 'Not sent'; li.append(a, b); list.append(li); }
  $('btn-stop').hidden = !job.running;
  $('btn-retry').hidden = job.running || (failed === 0 && done === total);
  if (!job.running && job.finishedAt && job.finishedAt !== lastJobFinished) { lastJobFinished = job.finishedAt; loadHistory(); }
  $('btn-review').disabled = job.running; $('btn-test').disabled = job.running;
}

// ---- report ----
let lastReport = null;
async function checkReport() {
  const btn = $('btn-report'); btn.disabled = true; btn.textContent = 'Checking…';
  try {
    lastReport = await api('POST', '/api/report');
    const bars = $('report-cohorts'); bars.textContent = '';
    const max = Math.max(1, ...lastReport.byCohort.map((c) => c.read + c.delivered + c.notRead));
    for (const c of lastReport.byCohort) {
      const row = document.createElement('div'); row.className = 'cbar';
      const name = document.createElement('strong'); name.textContent = c.cohort;
      const track = document.createElement('div'); track.className = 'cbar-track';
      const fill = document.createElement('div'); fill.className = 'cbar-fill'; fill.style.width = `${(c.read / max) * 100}%`; track.append(fill);
      const val = document.createElement('span'); val.textContent = `${c.read.toLocaleString()} read · ${c.groups} group(s)${c.unknown ? ` · ${c.unknown} without data` : ''}`;
      row.append(name, track, val); bars.append(row);
    }
    const tbody = $('report-table').querySelector('tbody'); tbody.textContent = '';
    const show = (v) => (v === null || v === undefined ? '?' : Number(v).toLocaleString());
    for (const r of lastReport.rows) {
      const tr = document.createElement('tr');
      for (const [v, num] of [[r.cohort], [r.name], [show(r.read), 1], [show(r.delivered), 1], [show(r.notRead), 1]]) { const td = document.createElement('td'); td.textContent = v; if (num) td.className = 'num'; tr.append(td); }
      tbody.append(tr);
    }
    $('report-table').hidden = !lastReport.rows.length;
    if (!lastReport.rows.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Nothing sent yet.'; bars.append(p); }
    const link = $('link-csv'); link.href = `/api/report.csv?t=${token}`; link.hidden = false;
    $('btn-copy').hidden = false;
  } catch (err) { showError(err.message); }
  btn.disabled = false; btn.textContent = 'Check read counts';
}

async function copyForSheet() {
  if (!lastReport) return;
  const lines = lastReport.rows.map((r) => [lastReport.checkedAt, r.cohort, r.name, r.groupId, r.sentAt, r.read ?? '', r.delivered ?? '', r.notRead ?? ''].join('\t'));
  try { await navigator.clipboard.writeText(lines.join('\n')); $('btn-copy').textContent = 'Copied! Paste into the sheet at A15'; setTimeout(() => { $('btn-copy').textContent = 'Copy for Google Sheet'; }, 3000); }
  catch (e) { showError('Copy was blocked by the browser. Use Download CSV instead.'); }
}

// ---- history ----
async function loadHistory() {
  try {
    const { history } = await api('GET', '/api/history');
    const tbody = $('history-table').querySelector('tbody'); tbody.textContent = '';
    if (!history.length) { const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 6; td.className = 'muted'; td.textContent = 'Nothing sent yet.'; tr.append(td); tbody.append(tr); return; }
    for (const h of history.slice(0, 50)) {
      const tr = document.createElement('tr');
      const when = new Date(h.lastAt); const whenText = isNaN(when) ? h.lastAt : when.toLocaleString();
      for (const [v, num] of [[whenText], [h.preview ? h.preview.split('\n')[0] : '(sent from PowerShell)'], [h.image || '-'], [h.groups, 1], [h.sent, 1], [h.failed, 1]]) { const td = document.createElement('td'); td.textContent = String(v); if (num) td.className = 'num'; tr.append(td); }
      tbody.append(tr);
    }
  } catch (err) { /* history is optional */ }
}

// ---- live updates ----
function connectEvents() {
  if (!token) return;
  const es = new EventSource(`/api/events?t=${token}`);
  es.onmessage = (ev) => {
    const s = JSON.parse(ev.data);
    lastState = s;
    renderConnection(s);
    if (s.groupsLoadedAt && s.groupsLoadedAt !== groupsLoadedAt) loadGroups();
    if (s.job) renderJob(s.job);
  };
  es.onerror = () => { $('conn-pill').textContent = 'Panel offline?'; $('conn-pill').className = 'pill pill-bad'; $('conn-detail').textContent = 'Lost contact with the panel. Is the "WhatsApp Panel" window still open? This page reconnects by itself.'; };
}

// ---- wire up ----
$('btn-groups').addEventListener('click', () => {
  const panel = $('group-panel'); panel.hidden = !panel.hidden;
  $('btn-groups').setAttribute('aria-expanded', String(!panel.hidden));
  if (!panel.hidden) $('group-search').focus();
});
// Clicks inside the dropdown never close it (some clicks redraw the list, which detaches the clicked element).
$('group-panel').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', (e) => {
  if (!e.target.isConnected || $('group-dropdown').contains(e.target)) return;
  $('group-panel').hidden = true; $('btn-groups').setAttribute('aria-expanded', 'false');
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('group-panel').hidden) { $('group-panel').hidden = true; $('btn-groups').focus(); } });
$('group-search').addEventListener('input', renderGroups);
$('btn-select-visible').addEventListener('click', () => { visibleGroups().filter((g) => g.canPost).forEach((g) => selected.add(g.id)); renderGroups(); renderSummary(); });
$('btn-clear').addEventListener('click', () => { selected.clear(); renderGroups(); renderSummary(); });
$('btn-refresh').addEventListener('click', () => loadGroups(true));

const dz = $('dropzone');
dz.addEventListener('click', () => $('file-input').click());
dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file-input').click(); } });
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('drag'); setImage(e.dataTransfer.files[0]).catch((err) => showError(err.message)); });
$('file-input').addEventListener('change', (e) => { setImage(e.target.files[0]).catch((err) => showError(err.message)); e.target.value = ''; });
$('btn-remove-image').addEventListener('click', () => { image = null; $('image-info').hidden = true; renderPreview(); });

$('message').addEventListener('input', renderPreview);
document.querySelectorAll('input[name=speed]').forEach((r) => r.addEventListener('change', renderEta));
$('btn-review').addEventListener('click', () => review([...selected], false));
$('btn-test').addEventListener('click', () => review($('test-group').value ? [$('test-group').value] : [], true));
$('confirm-form').addEventListener('submit', confirmSend);
$('btn-confirm-cancel').addEventListener('click', () => $('confirm-dialog').close());
$('btn-stop').addEventListener('click', () => api('POST', '/api/stop').catch((err) => showError(err.message)));
$('btn-retry').addEventListener('click', () => review([...selected], false));
$('btn-report').addEventListener('click', checkReport);
$('btn-copy').addEventListener('click', copyForSheet);
$('btn-reconnect').addEventListener('click', async () => {
  if (!confirm('Reconnect to WhatsApp? This restarts the WhatsApp window.')) return;
  try { await api('POST', '/api/reconnect'); } catch (err) { showError(err.message); }
});
$('btn-switch').addEventListener('click', async () => {
  const typed = prompt('Switch to another WhatsApp number?\nThe current login is kept (renamed), and a new QR code appears to scan with the other phone.\n\nType SWITCH to continue:');
  if (!typed) return;
  try { await api('POST', '/api/switch-number', { confirm: typed }); groups = []; selected.clear(); renderGroups(); renderSummary(); }
  catch (err) { showError(err.message); }
});

renderPreview(); renderSummary(); renderGroups(); loadHistory(); connectEvents();
