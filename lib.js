'use strict';

// Pure helper functions. Nothing in this file talks to WhatsApp, so it can be
// tested offline.

const fs = require('fs');

// groups.csv: exactly the three columns the brief asks for.
const CSV_HEADER = ['group_id', 'group_name', 'participants'];

// groups_details.csv: same rows plus extra facts for future planning.
const DETAILS_HEADER = [
    'group_id',
    'group_name',
    'participants',
    'community_role',
    'community_id',
    'community_name',
    'admins_only_messages',
    'work_number_role',
];

// Written when the library gave us no usable value. We never guess.
const UNAVAILABLE = 'unavailable';
const UNKNOWN = 'unknown';

// ---------------------------------------------------------------- CSV ----

/**
 * Escape one CSV field (RFC 4180 style).
 * If the value contains a comma, double quote, CR or LF, wrap it in quotes
 * and double any quotes inside it.  Sales, "VIP"  ->  "Sales, ""VIP"""
 */
function csvEscape(value) {
    const text = value === null || value === undefined ? '' : String(value);
    if (/[",\r\n]/.test(text)) {
        return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
}

/** Turn a header + rows into CSV text (CRLF line endings, opens fine in Excel). */
function toCsv(rows, header = CSV_HEADER) {
    return [header, ...rows]
        .map((row) => row.map(csvEscape).join(','))
        .join('\r\n') + '\r\n';
}

/**
 * Read CSV text back into arrays (used to compare with the previous run).
 * Handles quoted fields containing commas, quotes and line breaks.
 */
function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') inQuotes = false;
            else field += c;
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === ',') {
            row.push(field); field = '';
        } else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field); rows.push(row); row = []; field = '';
        } else {
            field += c;
        }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
}

// --------------------------------------------------------- per group -----

/**
 * Read a WhatsApp ID object as text, e.g. "120363...@g.us".
 * WhatsApp Web renamed the field from `_serialized` to `$1` in July 2026, so
 * we accept either. Returns '' if neither is present - never a made-up ID.
 */
function widString(id) {
    if (typeof id === 'string') return id;
    if (!id || typeof id !== 'object') return '';
    if (typeof id._serialized === 'string') return id._serialized;
    if (typeof id.$1 === 'string') return id.$1;
    return '';
}

/**
 * Participant count for one group chat.
 * Returns { count: number } or { count: null, reason: string }.
 * An empty list counts as unavailable: the work number itself is a member of
 * every group it can see, so 0 means the data did not load.
 */
function participantCount(chat) {
    const list = chat.participants;
    if (!Array.isArray(list)) {
        return { count: null, reason: 'participant list not provided by library' };
    }
    if (list.length === 0) {
        return { count: null, reason: 'participant list was empty (metadata not loaded or hidden)' };
    }
    return { count: list.length };
}

/**
 * Is the work number an admin or a plain member of this group?
 * Uses the documented participant fields (id, isAdmin, isSuperAdmin).
 * Returns 'admin', 'member' or 'unknown'. Never reveals other people's numbers.
 */
function workNumberRole(chat, meId) {
    if (!meId || !Array.isArray(chat.participants)) return UNKNOWN;
    const meUser = String(meId).split('@')[0];
    const me = chat.participants.find((p) => {
        const id = p && p.id;
        if (!id) return false;
        return widString(id) === meId || id.user === meUser;
    });
    if (!me) return UNKNOWN;
    return me.isAdmin || me.isSuperAdmin ? 'admin' : 'member';
}

// ------------------------------------------------- Community (raw) -------
// whatsapp-web.js has NO documented Community API. The fields below come from
// WhatsApp Web's own internal group metadata, which the library passes
// through unchanged. They may be missing or renamed at any time, so every
// label based on them is a clue to verify on the phone, not a guarantee.

const COMMUNITY_KEY = /parent|communit|subgroup|grouptype|linked/i;

/** Does the raw metadata contain any Community-related field at all? */
function hasCommunityFields(groupMetadata) {
    if (!groupMetadata || typeof groupMetadata !== 'object') return false;
    return Object.keys(groupMetadata).some((k) => COMMUNITY_KEY.test(k));
}

/**
 * Copy small Community-related values out of the raw metadata.
 * IDs become strings. Lists of group IDs (ending @g.us) are kept, because
 * they are not personal data. Any other list is reduced to its length.
 */
function communityHints(groupMetadata) {
    const hints = {};
    if (!groupMetadata || typeof groupMetadata !== 'object') return hints;
    for (const [key, value] of Object.entries(groupMetadata)) {
        if (!COMMUNITY_KEY.test(key) && key !== 'announce') continue;
        if (value === null || value === undefined) continue;
        if (Array.isArray(value)) {
            const ids = value.map((v) => widString(v) || null);
            hints[key] = ids.every((id) => typeof id === 'string' && id.endsWith('@g.us'))
                ? ids
                : `[list of ${value.length}]`;
        } else if (typeof value === 'object' && widString(value)) {
            hints[key] = widString(value);
        } else if (typeof value !== 'object') {
            hints[key] = value;
        }
    }
    return hints;
}

/**
 * Role inside a Community, based on the raw hints:
 * community_container | community_announcement | community_group |
 * standalone_group | unknown
 */
function communityRole(hints, fieldsPresent) {
    const type = String(hints.groupType || '').toUpperCase();
    if (hints.isParentGroup === true || type === 'COMMUNITY') return 'community_container';
    if (hints.defaultSubgroup === true || type === 'LINKED_ANNOUNCEMENT_GROUP') return 'community_announcement';
    if (hints.parentGroup || type === 'LINKED_SUBGROUP' || type === 'LINKED_GENERAL_GROUP') return 'community_group';
    if (!fieldsPresent) return UNKNOWN; // WhatsApp gave no Community fields: can't tell
    return 'standalone_group';
}

// ------------------------------------------------------ inventory --------

/**
 * Convert chat objects into rows plus a report.
 * - keeps only chats where chat.isGroup === true (documented property)
 * - removes duplicate IDs (first one wins; duplicates are reported)
 * - meId: the work number's own ID (client.info.wid._serialized), optional
 */
function buildInventory(chats, { meId } = {}) {
    const byId = new Map();
    const duplicates = [];
    const unavailable = [];
    const missingNames = [];
    let groupChatsSeen = 0;

    for (const chat of chats) {
        if (!chat || chat.isGroup !== true) continue;
        groupChatsSeen++;

        const id = widString(chat.id);
        if (!id) {
            throw new Error('A group chat had no ID (neither id._serialized nor id.$1); refusing to guess an ID.');
        }
        if (byId.has(id)) {
            duplicates.push(id);
            continue;
        }

        const name = typeof chat.name === 'string' ? chat.name : '';
        if (!name) missingNames.push(id);

        const pc = participantCount(chat);
        if (pc.count === null) unavailable.push({ id, name, reason: pc.reason });

        const hints = communityHints(chat.groupMetadata);
        const role = communityRole(hints, hasCommunityFields(chat.groupMetadata));
        let communityId = '';
        if (role === 'community_container') communityId = id;
        else if (typeof hints.parentGroup === 'string') communityId = hints.parentGroup;

        byId.set(id, {
            id,
            name,
            participants: pc.count === null ? UNAVAILABLE : pc.count,
            role,
            communityId,
            adminsOnly: typeof chat.isReadOnly === 'boolean' ? (chat.isReadOnly ? 'yes' : 'no') : UNKNOWN,
            workNumberRole: workNumberRole(chat, meId),
            hints,
        });
    }

    const groups = [...byId.values()];
    const communities = groupCommunities(groups);
    for (const g of groups) {
        const c = communities.get(g.communityId);
        g.communityName = c && c.container ? c.container.name : '';
    }

    return {
        groups,
        communities,
        rows: groups.map((g) => [g.id, g.name, g.participants]),
        detailRows: groups.map((g) => [
            g.id, g.name, g.participants, g.role, g.communityId, g.communityName, g.adminsOnly, g.workNumberRole,
        ]),
        groupChatsSeen,
        duplicates,
        unavailable,
        missingNames,
    };
}

/**
 * Group rows by Community ID. A container that is referenced by other groups
 * but was not itself returned by getChats() gets container = null.
 */
function groupCommunities(groups) {
    const map = new Map();
    const get = (cid) => {
        if (!map.has(cid)) map.set(cid, { id: cid, container: null, announcement: [], groups: [] });
        return map.get(cid);
    };
    for (const g of groups) {
        if (!g.communityId) continue;
        const c = get(g.communityId);
        if (g.role === 'community_container') c.container = g;
        else if (g.role === 'community_announcement') c.announcement.push(g);
        else c.groups.push(g);
    }
    return map;
}

/**
 * Compare this run's rows with the previous groups.csv (both by group_id).
 * Returns lists of added, removed, renamed and count-changed groups.
 */
function compareWithPrevious(previousRows, rows) {
    const prev = new Map(previousRows.map((r) => [r[0], r]));
    const now = new Map(rows.map((r) => [r[0], r.map(String)]));
    const result = { added: [], removed: [], renamed: [], countChanged: [] };
    for (const [id, r] of now) {
        const p = prev.get(id);
        if (!p) { result.added.push({ id, name: r[1] }); continue; }
        if (p[1] !== r[1]) result.renamed.push({ id, from: p[1], to: r[1] });
        if (p[2] !== r[2]) result.countChanged.push({ id, name: r[1], from: p[2], to: r[2] });
    }
    for (const [id, p] of prev) {
        if (!now.has(id)) result.removed.push({ id, name: p[1] });
    }
    return result;
}

/** Load a previous groups.csv; returns rows without the header, or null. */
function readPreviousRows(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
    const header = rows.shift() || [];
    if (header.join(',') !== CSV_HEADER.join(',')) return null; // not our format
    return rows.filter((r) => r.length === CSV_HEADER.length);
}

// ------------------------------------------------------------ files ------

/**
 * Write a CSV safely: write "<file>.tmp", then rename it over the real file.
 * A crash halfway never leaves a half-written CSV behind.
 */
function writeCsvAtomic(filePath, rows, header = CSV_HEADER) {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, toCsv(rows, header), { encoding: 'utf8' });
    fs.renameSync(tmp, filePath);
}

/**
 * At the start of a run, move an old output file to its ".previous" name.
 * If this run then fails, the output file does not exist, so old data can't
 * be mistaken for this run's result.
 */
function setAsidePreviousOutput(filePath, previousPath) {
    if (fs.existsSync(filePath)) {
        fs.renameSync(filePath, previousPath);
        return true;
    }
    return false;
}

module.exports = {
    CSV_HEADER,
    DETAILS_HEADER,
    UNAVAILABLE,
    csvEscape,
    toCsv,
    parseCsv,
    widString,
    participantCount,
    workNumberRole,
    hasCommunityFields,
    communityHints,
    communityRole,
    buildInventory,
    groupCommunities,
    compareWithPrevious,
    readPreviousRows,
    writeCsvAtomic,
    setAsidePreviousOutput,
};
