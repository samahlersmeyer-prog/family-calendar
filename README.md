# Family Calendar

A shared family calendar that runs free on GitHub Pages.

- **List and month views**, color-coded by calendar, built for phones (add it to your Home Screen).
- **Drag and drop** `.ics` calendar files and schedule **PDFs** anywhere on the page, or paste a schedule from an email. Everything is shown for review before it's added.
- **Team feeds**: paste a GameChanger, SportsYou, TeamSnap or Google Calendar sync link into a calendar in Settings. A GitHub Action pulls them every 2 hours.
- **Email**: ask Claude to "scan my email for schedules" and it adds what it finds (via `scripts/add-events.mjs`).
- **Private**: all calendar data is encrypted with the family passcode before it's saved to this repo. Relatives get the link + passcode and can view; editors also add a GitHub token on their device.

## One-time setup

1. **Settings → Pages**: Source = *Deploy from a branch*, Branch = `main`, folder `/ (root)`. Save.
2. Open `https://<you>.github.io/family-calendar/`. Pick a family passcode and paste a GitHub token
   ([create a fine-grained token](https://github.com/settings/personal-access-tokens/new): only this repo; **Contents**, **Actions** and **Workflows** = Read and write).
3. **Settings → Secrets and variables → Actions → New repository secret**: name `CAL_PASSCODE`, value = the family passcode. (Needed for team feed syncing.)
4. In the app, open ⚙︎ Settings and paste each team's calendar link.

## Echo Show / kitchen display

**Kitchen display:** on the Echo Show say “Alexa, open Silk Browser”, go to `samahlersmeyer-prog.github.io/family-calendar/tv` and enter the family code. Tap once for full screen. It shows today in big type, the next six days, who's driving, and updates live. It shows what relatives see; tap “sign in” at the bottom to include the Family calendar too.

**Alexa's own calendar (Google Calendar copy):** every 30 minutes the Action copies the calendar into a Google Calendar, which you link in the Alexa app so events show on the Echo's home screen and Alexa can answer “what's on the calendar?”. One-time setup:

1. Google Calendar → **+ Other calendars → Create new calendar** named `Family Calendar (Echo)`. In its settings, copy the **Calendar ID**.
2. [console.cloud.google.com](https://console.cloud.google.com) → project **family-calendar-513401** → **APIs & Services → Library** → enable **Google Calendar API**.
3. **IAM & Admin → Service Accounts → Create service account** named `echo-sync`. Give it the role **Cloud Datastore Viewer** (read-only; lets it read private events). Open it → **Keys → Add key → JSON** (downloads a file).
4. Back in the new calendar's settings → **Share with specific people** → add the service account's email → **Make changes to events**.
5. GitHub → **Settings → Secrets and variables → Actions**: add `GOOGLE_SA_KEY` (paste the whole JSON file) and `GOOGLE_CALENDAR_ID`.
6. **Actions → Sync team feeds → Run workflow** to fill it now.
7. Alexa app → **More → Settings → Calendar & Email → Add account → Google**, then turn on only `Family Calendar (Echo)`.

The copy is one-way: change events in this app, not in Google. To leave out the Family calendar and 🔒 events, add `ECHO_INCLUDE_PRIVATE: 'false'` to that workflow step's `env`.

## Files

| Path | What it is |
| --- | --- |
| `index.html`, `app.js`, `style.css` | The app |
| `lib/` | Shared code: encryption, .ics reader, schedule text reader, time zones |
| `data/calendar.enc` | Your events and calendars (encrypted) |
| `data/feeds.enc` | Team feed events, written by the Action (encrypted) |
| `scripts/sync-feeds.mjs` | Team feed sync (run by `.github/workflows/sync-feeds.yml`) |
| `scripts/sync-google.mjs` | Copies the calendar into a Google Calendar for Alexa (same workflow) |
| `tv/` | Kitchen display for the Echo Show |
| `lib/events.js` | Repeating events and team-feed merging, shared by the app, display and sync |
| `scripts/add-events.mjs` | Command-line import used for email: `CAL_PASSCODE=… node scripts/add-events.mjs events.json` |

If you ever change the passcode, update the `CAL_PASSCODE` secret too.
