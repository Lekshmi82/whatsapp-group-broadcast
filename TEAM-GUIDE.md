# WhatsApp Panel: team guide

Send one announcement (message + poster) to many WhatsApp groups from the company number, without typing commands.

## Install (once per laptop, about 10 minutes)
1. Install **Node.js LTS** from https://nodejs.org (click Next through the installer).
2. On this GitHub page click **Code → Download ZIP**, then extract it to your Desktop.
3. Open the extracted folder and double-click **`Setup.bat`**. Wait for "Setup finished".

## Use
1. Double-click **`Start WhatsApp Panel.bat`**. Your browser opens the panel.
   - Keep the black window open while you work.
   - A Chrome window with WhatsApp Web also opens: leave it (minimise it), don't click in it.
2. **First time only:** a QR code appears. On the company phone: **WhatsApp → Settings → Linked devices → Link a device**, scan it.
3. Wait for **Connected** (top right). The first time can take a few minutes.
4. **Choose groups** (cohort buttons C06–C09 select a whole cohort) → **drag the poster in** → **type the message** (check the preview).
5. **Send test** to a test group first and check it on your phone.
6. **Review & send** → type the `SEND <number>` shown → watch the progress.
7. A few hours later: **Check read counts** → Download CSV / Copy for Google Sheet.

## Rules (important)
- **Only one person sends at a time.** The "already sent" memory is stored on each laptop, so two people sending the same announcement could send it twice.
- Use **Safe** or **Normal** speed for big sends. Avoid other bulk sends from the number the same day.
- Never share the `.wwebjs_auth` folder: it is a full login to the company WhatsApp.
- If something fails, the panel stops. Check that group on the phone, then click **Retry failed groups** (groups already sent are skipped).

## Problems
| You see | Do this |
|---|---|
| "Node.js is not installed" | Install it from nodejs.org, then try again |
| Stuck on "Loading" / "Syncing" for over 10 minutes | Click **Reconnect** |
| QR code appears unexpectedly | The phone unlinked this laptop: scan again |
| "Waiting for this message" on phones | Keep the panel open a few more minutes |
