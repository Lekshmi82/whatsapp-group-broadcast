# WhatsApp Group Broadcast

Send one message (optionally with an image) to chosen WhatsApp groups from the work number, and list every group with its ID. Built on whatsapp-web.js. It's unofficial, so keep volume low.

## Quick start (Windows, VS Code terminal)

```
npm.cmd install
npx.cmd puppeteer browsers install chrome
npm.cmd test
```

0. **Link the number** (first time, or to switch numbers): `node .\link.js` opens a Chrome window with the QR code. Scan it on the phone (WhatsApp → Linked devices → Link a device). It prints which number is linked. To switch numbers, first rename `.wwebjs_auth` (e.g. to `.wwebjs_auth_work`) so the old login is kept.
1. **List groups** (read-only).
   ```
   node .\send-to-groups.js
   ```
   This writes `targets-available.txt`, the groups you can post to.
2. **Choose groups:** copy lines from `targets-available.txt` into `targets.txt` and delete the `# ` at the start of each.
3. **Write the message** in `message.txt`. Optionally add one picture named `image.png` or `image.jpg`; the message becomes its caption.
4. **Preview** (sends nothing):
   ```
   node .\send-to-groups.js send --dry-run
   ```
5. **Send:** type `SEND <number>` when asked.
   ```
   node .\send-to-groups.js send
   ```
   Results appear on screen and in `send-log.csv`.

**Verified 28 Oct 2026 on the work number:** text message sent to both LK test Community Announcements groups and received on members' phones (WhatsApp Web 2.3000.1052023215). If phones show "Waiting for this message", run `node .\send-to-groups.js online`. If member counts look too low, relink: rename `.wwebjs_auth`, run `npm.cmd start` and scan the QR again. Image sending: not yet tested on the real account.

**If connecting is slow or stuck:** the script allows 5 minutes, shows loading progress, and retries once automatically. Set `$env:CONNECT_TIMEOUT_SECONDS=600` for longer, or `$env:SHOW_BROWSER=1` to watch WhatsApp Web in a visible Chrome window.

Never commit or share `.wwebjs_auth/` (it's the WhatsApp login) or any CSV/txt/image output. `.gitignore` already excludes them.

---

## Background: Task 03 inventory

Task 03 · *WhatsApp: List Work Number Groups*.

This script links to the **work number** through WhatsApp Web, lists every group the number is in, and writes:

| File | Contents |
|---|---|
| `groups.csv` | Exactly what the brief asks for: `group_id, group_name, participants` |
| `groups_details.csv` | The same rows plus planning columns for future automation (see below) |

It **only reads**. It never sends, forwards, deletes, edits or changes anything.

> ⚠️ **Unofficial tool.** `whatsapp-web.js` controls WhatsApp Web in a hidden Chrome window. It is not made or approved by WhatsApp. Its own README warns that accounts *can* be blocked and that WhatsApp updates can break it. Use only the work number, run it occasionally (not in a loop), and keep the pinned versions.

---

## Brief → how to check it

| Done when… | How the script helps | How to check |
|---|---|---|
| Script creates `groups.csv` on its own | `npm start` writes it automatically | The file appears in the folder |
| Both test communities are in it | Every group row is included. A **Communities** section lists each Community and its rows | Find `LK Test Community 1` and `2` in the CSV and in the Communities section |
| Member counts for 3 groups match the phone | `participants` = members WhatsApp returns, including the work number | Phone → open group → Group info → "N members" |
| You can explain it | See [Plain-English answers](#plain-english-answers) | — |

**Test setup from the brief:** each test Community has Naren, your number and the work number. So its announcement group should show **3 members**, unless the phone shows otherwise. The phone is the truth.

---

## Files

| File | What it is |
|---|---|
| `inventory.js` | The program: start → QR or saved login → wait → read groups → write CSVs → close |
| `lib.js` | Helper functions with no WhatsApp access: CSV writing and reading, duplicates, member counts, Community grouping, change report |
| `test/` | 33 automatic tests (`npm test`). They use a fake WhatsApp, so they never touch the real account |
| `vendor/whatsapp-web.js-064a3d5/` | The WhatsApp library: official GitHub code at a fixed commit, unmodified, as plain `.js` files (see [Library version](#library-version-why-a-github-build) and `vendor/README.md`) |
| `.gitignore` | Stops the login folder, outputs and `node_modules` from ever being committed |
| `package.json` / `package-lock.json` | Exact versions of everything npm installs (Puppeteer 24.38.0 and the library's other helpers, `qrcode-terminal 0.12.0`), with checksums |

Created when you run it (private, keep on the laptop): `.wwebjs_auth/` (the login), `.wwebjs_cache/`, `node_modules/`, `groups*.csv`.

---

## How to run (VS Code terminal, inside the project folder)

On Windows PowerShell, type `npm.cmd` instead of `npm` (PowerShell blocks plain `npm`).

```
npm.cmd install                              (once: downloads the libraries)
npx.cmd puppeteer browsers install chrome    (once: downloads the private Chrome)
npm.cmd test                                 (safe offline tests: expect "pass 33" and "fail 0")
npm.cmd start                                (the real run)
```

Newer npm versions skip Puppeteer's own Chrome download (`npm warn install-scripts … puppeteer`), which is why the `npx.cmd puppeteer browsers install chrome` line is needed.

**First run:** a QR code appears. On the work phone go to **WhatsApp → Settings → Linked devices → Link a device** and scan it. Then wait: the script needs about 2 minutes to sync and check before it prints the results.

**Later runs:** no QR code; it uses the saved login.

**If groups are missing** (WhatsApp hadn't finished syncing), give it longer:
- Command Prompt: `set SYNC_WAIT_SECONDS=180` then `npm start`
- PowerShell: `$env:SYNC_WAIT_SECONDS=180` then `npm.cmd start`

| Setting | Default | Meaning |
|---|---|---|
| `SYNC_WAIT_SECONDS` | 60 | Wait after login before the first read |
| `RECHECK_SECONDS` | 15 | Gap between the consistency checks |
| `READY_TIMEOUT_SECONDS` | 180 | Give up if not logged in by then (e.g. QR not scanned) |

### Output files and failed runs
- At the start of each run, old outputs are renamed to `groups.previous.csv` and `groups_details.previous.csv`.
- New files are written only after every check passes. `groups.csv` is written last.
- **If a run fails, there is no `groups.csv`.** So if you see `groups.csv`, it came from the most recent run, and that run succeeded.

### Error messages
| Message | Meaning / fix |
|---|---|
| `Authentication failed` | Saved login rejected. Delete the `.wwebjs_auth` folder and run again to rescan. |
| `not ready within …s` | QR not scanned in time, or WhatsApp Web didn't load. Run again. |
| `Client disconnected (…)` | Device was unlinked on the phone, or the internet dropped. Run again. |
| `Group list kept changing` | Still syncing. Use a larger `SYNC_WAIT_SECONDS`. |
| `No group chats found` | Probably not synced yet. The script refuses to write an empty list. |
| `Failed to launch the browser process` / `Could not find Chrome` | Run `npx.cmd puppeteer browsers install chrome`. |
| `FAILED while reading the chat list (client.getChats): r` | WhatsApp Web changed its internals and the library can't read it. Seen on 27 Oct 2026 with npm 1.34.7; fixed by the vendored build. If it comes back, WhatsApp changed again: check GitHub for a newer library fix. |

Every failure names the **step** it happened in and prints a few "where it failed" lines (code locations only, no messages or numbers). Paste them when asking for help.

---

## Library version: why a GitHub build

**What happened (27 Oct 2026):** the first real run logged in fine, then failed while reading chats with just `r`, a short name from WhatsApp's compressed code.

**Cause (evidence):**
- In July 2026 WhatsApp Web renamed an internal ID field from `_serialized` to `$1`.
- The newest npm release, `whatsapp-web.js 1.34.7` (24 Apr 2026), predates that change. It passes an empty ID to WhatsApp while reading group details, and WhatsApp's code throws.
- The maintainers fixed it on GitHub in commit `58ddf15` (26 Sep 2026): *"fix(client): add fallback for WhatsApp id._serialized renamed to id.$1"*. It hasn't been published to npm yet.
- The repeated "Authenticated" lines were a separate known bug, fixed in `1780711` (24 Jun 2026).

**What we use:** the official repository at commit `064a3d5a5a3dce1281a6a12740b5a7051339d154` (latest `main`, 28 Sep 2026). It contains both fixes. Its runtime files (`index.js`, `index.d.ts`, `src/`, `package.json`, licence, readme) are copied **unmodified** into `vendor/whatsapp-web.js-064a3d5/` and checked file-by-file against the commit. `inventory.js` loads the library from there. Its helper packages are listed at the same exact versions in our `package.json`, so npm installs them normally.
- Why a folder and not an archive file: the first attempt shipped the library as a `.tgz` inside the ZIP. Lekshmi's laptop silently dropped it, probably a security rule against archives inside archives. Plain `.js` files avoid that.
- The functions this script uses (`getChats`, `getState`, `destroy`, `LocalAuth`) are unchanged in that commit.
- Puppeteer is the same version (24.38.0), so the Chrome you already downloaded still works.
- Your own code also accepts both ID formats (`widString()` in `lib.js`). That covers participant IDs and Community fields, which the library doesn't normalise.

**When npm publishes a version newer than 1.34.7**, follow the switch-back steps in `vendor/README.md`.

---

## What makes it scalable

The brief needs a list today. The webinar automation later will need it for many groups and will need to trust it. So:

1. **IDs are the key.** Names can be changed by anyone and can repeat; IDs never change. Every comparison uses the ID.
2. **Change report on every run.** The script compares with the last successful run and prints groups that are **NEW**, **GONE**, **RENAMED**, or whose **MEMBERS** count changed. With 100+ groups, that shows what to review.
3. **`groups_details.csv` for planning.** Same rows plus:

   | Column | Meaning |
   |---|---|
   | `community_role` | `community_container`, `community_announcement`, `community_group`, `standalone_group` or `unknown` |
   | `community_id` / `community_name` | Which Community the group belongs to (name only if the container itself was returned) |
   | `admins_only_messages` | `yes` if only admins can send messages (documented `isReadOnly`) |
   | `work_number_role` | `admin`, `member` or `unknown`. Admin-only announcement groups are only postable if the work number is an admin |

4. **Gentle on WhatsApp.** Each read refreshes every group's details, so the script reads only twice in a normal run (at most 4 times), with no endless polling. Requests grow with the number of groups, not with run time.
5. **Safe to rerun anytime.** No stale files, clear failures, and the login is reused.

`groups.csv` deliberately stays at exactly three columns, as the brief says.

---

## Communities: what the library can and can't do

**Evidence (checked 27 Oct 2026 in the library's code, v1.34.7):**
- The official `whatsapp-web.js` README lists **"Communities 🔜"**, meaning not supported yet.
- There is no Community object and no "list communities" function. Chats are only private chats, groups or channels.
- No documented group field says which Community a group belongs to.
- `getChatById()` looked like a way to look up a Community by ID, but internally it may **create** a chat (`findOrCreateLatestChat`). That breaks the read-only rule, so the script doesn't use it, and a test blocks it.

**What the script does instead:** WhatsApp Web's own internal group data sometimes carries Community fields (for example `isParentGroup`, `parentGroup`, `defaultSubgroup`). The library passes these through without documenting them. The script reads them, labels each group's role, and groups rows by Community in the console. Because these fields are undocumented, **verify against the phone** (Communities tab).

**Possible outcomes of your real run:**
| What you see | What it means |
|---|---|
| Container row and announcement row, both named like the Community | The Community shows as several rows: the container plus its groups, each with its own ID |
| Only the announcement group row(s), with the container shown as "NOT returned by getChats()" | WhatsApp references the container but doesn't list it as a chat. The Community appears through its groups only |
| Role `unknown` everywhere | WhatsApp exposed no Community fields. Rows still appear, but which Community they belong to can't be shown with this library. Report that honestly |

Write down which outcome you got. That's your answer for the brief's last question.

---

## Test plan (on the work number; send no messages)

✅ = already tested automatically (`npm test`, 33 passing). The rest needs the real phone.

| # | Test | How | Pass when | Result |
|---|---|---|---|---|
| 1 | First QR login | Delete `.wwebjs_auth`, `npm start`, scan | `Authenticated`, then `Client is ready.` | |
| 2 | Saved login | `npm start` again | No QR code | |
| 3 | All groups present | Compare `groups.csv` with the phone's groups | Each group exactly once | |
| 4 | Test Communities | Find both in the CSV and the Communities section; compare with the phone's Communities tab | Note which outcome above you got | |
| 5 | IDs and names | IDs end in `@g.us`; names match the phone | Exact match | |
| 6 | Member counts (3 groups) | Group info → "N members" | CSV number = N | |
| 7 | No duplicate IDs | Summary says `Duplicate IDs skipped: 0` | ✅ logic tested | |
| 8 | Special characters | By hand on the phone, rename a **test** group to `Test, "quoted" 🚀`, rerun, open the CSV in Excel | Name in one cell, shown correctly. Change report says RENAMED. ✅ tested | |
| 9 | Missing member data | Look for `unavailable` and a warning | Never a guessed number. ✅ tested | |
| 10 | Failures | Unlink the device mid-run / turn off wifi / press Ctrl+C | `FAILED` message, and no `groups.csv`. ✅ simulated | |
| 11 | Read-only | `npm test` safety checks; afterwards confirm on the phone that nothing changed | Nothing changed. ✅ tested | |

---

## Plain-English answers

**What happens when the script runs?**
It opens a hidden Chrome window with WhatsApp Web, logs in as the work number, waits for chats to sync, and reads the chat list twice to make sure it's complete. It keeps only the groups and writes their ID, name and member count to `groups.csv`. Then it closes Chrome. It never types or sends anything.

**Why a QR code the first time but not after?**
Scanning the QR code tells the phone "trust this Chrome as a linked device", like logging into WhatsApp Web on a computer. The library saves that Chrome's login in `.wwebjs_auth/`. Next time it opens the same login, so WhatsApp still recognises it. You'll need to rescan only if the device is removed under Linked devices, the phone is offline for a long time, or the folder is deleted.

**Why must `.wwebjs_auth/` stay on the laptop?**
It *is* the login. Anyone with a copy can use the work number without scanning anything. Never put it on Drive, in a zip, or in chat. If it ever leaks, remove the device under **Linked devices** on the phone.

**Group ID vs group name?**
The ID (e.g. `120363…@g.us`) is WhatsApp's permanent, unique key for the group; the app never shows it. The name is the label people see; it can be changed and can repeat. Automation must use IDs.

**Why does a community show up as more than one row (or why doesn't it)?**
A Community isn't one chat. It's a container that holds an announcement group and possibly other groups, and each has its own ID. Every one the work number is in becomes its own row, so one Community can produce several rows, often with the same name. Whether the container itself appears as a row depends on what WhatsApp returns. The library doesn't officially support Communities, so your real run decides (see the outcomes table).

---

## What's verified and what isn't
**Verified:**
- 33 automatic tests pass, including the new `$1` ID format and step-named errors: CSV format and read-back, duplicates, missing data, Community grouping, admin check, change report, a full fake run including every failure case, and the read-only safety checks.
- The vendored library loads from `vendor/`, starts Chrome, and fails cleanly when WhatsApp can't be reached.
- On Lekshmi's laptop: QR login and "Client is ready" worked (27 Oct 2026). Reading chats then failed with npm 1.34.7 (see above).

**Not verified yet (needs your phone):**
- That the vendored library fixes the `r` error on the real account, session reuse, real groups, real member counts, how the test Communities actually appear, and whether `work_number_role` matches correctly. If WhatsApp formats IDs differently, `work_number_role` shows `unknown` rather than guessing.

---

## send-to-groups.js: send the same message (+ optional image) to many groups

> `inventory.js` (Task 03) still never sends. `send-to-groups.js` is the separate announcement tool. Use it only with permission to send from the work number.

| Command | What it does |
|---|---|
| `node .\send-to-groups.js` | **LIST** (read-only): shows all groups and writes `targets-available.txt` (groups you can post to) |
| `node .\send-to-groups.js send --dry-run` | Reads groups live, shows the full preview, **sends nothing** |
| `node .\send-to-groups.js send` | Sends to the group IDs in `targets.txt` |
| `node .\send-to-groups.js send --all` | Sends to **every** group the number can post to (max 30 per run) |

Options: `--no-image` (text only even if an image is present), `--gap <seconds>` (default 60, minimum 15).

Files in the project folder:
- `message.txt`: the text. It becomes the caption when an image is sent.
- `image.jpg` / `image.png` (optional, one only, under 5 MB): the picture to send with the message.
- `targets.txt`: one group ID per line (not needed with `--all`).
- `send-log.csv`: one line per attempt (`SENT`, `UNCONFIRMED` or `FAILED`, with the error).

Safety built in:
- Groups are read live from WhatsApp in the same run. **IDs only**, never names. Community containers and admin-only groups (where the number isn't an admin) are excluded.
- **Every target is checked first;** if one is wrong, nothing is sent.
- **You must type `SEND <number of groups>`.**
- **One group at a time,** with ~60 s random gaps.
- **Stops at the first failure.** A rerun skips groups that already got the same message **and** image.

**Library fixes:** the `vendor/` copy (commit `064a3d5`) contains both WhatsApp July–Sept 2026 fixes: `r: r` in `getChats()` and image sending (*"Data passed to getter must include an id property"*). No `node_modules` patching is needed.
