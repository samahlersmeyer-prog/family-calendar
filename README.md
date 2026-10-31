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

## Files

| Path | What it is |
| --- | --- |
| `index.html`, `app.js`, `style.css` | The app |
| `lib/` | Shared code: encryption, .ics reader, schedule text reader, time zones |
| `data/calendar.enc` | Your events and calendars (encrypted) |
| `data/feeds.enc` | Team feed events, written by the Action (encrypted) |
| `scripts/sync-feeds.mjs` | Team feed sync (run by `.github/workflows/sync-feeds.yml`) |
| `scripts/add-events.mjs` | Command-line import used for email: `CAL_PASSCODE=… node scripts/add-events.mjs events.json` |

If you ever change the passcode, update the `CAL_PASSCODE` secret too.
