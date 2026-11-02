# Family Calendar

A shared family calendar that runs free on GitHub Pages.

- **List and month views**, color-coded by calendar, built for phones (add it to your Home Screen).
- **Drag and drop** `.ics` calendar files and schedule **PDFs** anywhere on the page, or paste a schedule from an email. Everything is shown for review before it's added.
- **Team feeds**: paste a GameChanger, SportsYou, TeamSnap or Google Calendar sync link into a calendar in Settings. A GitHub Action pulls them every 2 hours.
- **Email**: ask Claude to "scan my email for schedules" and it adds what it finds (via `scripts/add-events.mjs`).
- **Practices hidden for relatives**: every event has a type (game, practice, concert/program, church, school, other), guessed from the title or picked when you add it. Relatives see everything except practices unless they tap **Practices**; Sam & Emily see it all.
- **Lists**: a shared grocery list and chores (assign to a kid, once / every day / every week). They show on the kitchen display, where anyone can tap to check things off.
- **Notifications**: each phone can turn on reminders (30 min, 1 hr, 2 hr or the evening before), alerts when a time or place changes or something is cancelled, and a Sunday-night “week ahead”. On iPhone this only works from the Home Screen app.
- **Weekly email**: every Sunday evening relatives can get an email with the week’s games, concerts, church and school events (Settings → Weekly email).
- **Private**: all calendar data is encrypted with the family passcode before it's saved to this repo. Relatives get the link + passcode and can view; editors also add a GitHub token on their device.

## One-time setup

1. **Settings → Pages**: Source = *Deploy from a branch*, Branch = `main`, folder `/ (root)`. Save.
2. Open `https://<you>.github.io/family-calendar/`. Pick a family passcode and paste a GitHub token
   ([create a fine-grained token](https://github.com/settings/personal-access-tokens/new): only this repo; **Contents**, **Actions** and **Workflows** = Read and write).
3. **Settings → Secrets and variables → Actions → New repository secret**: name `CAL_PASSCODE`, value = the family passcode. (Needed for team feed syncing.)
4. In the app, open ⚙︎ Settings and paste each team's calendar link.

## Turning on lists, notifications and the weekly email (one time)

These need the new database rules. In the [Firebase console](https://console.firebase.google.com/project/family-calendar-513401/firestore/rules) → **Firestore Database → Rules**, replace everything with the contents of `firestore.rules` and tap **Publish**.

Notifications are sent by `.github/workflows/notify.yml` every 10 minutes using the secrets that are already there. Its first run makes the push keys (`data/vapid.enc`, `data/vapid-public.txt`). GitHub sometimes runs scheduled jobs late, so a reminder can be a few minutes off. To test the Sunday summary any time: **Actions → Notifications → Run workflow → Send the week-ahead summary now**.

For the weekly email, open Settings → Weekly email, list the addresses, and paste a Gmail [app password](https://myaccount.google.com/apppasswords) (needs 2-Step Verification). Only editors can read it.

## Echo Show / kitchen display

**Kitchen display:** on the Echo Show say “Alexa, open Silk Browser”, go to `samahlersmeyer-prog.github.io/family-calendar/tv` and enter the family code. Tap once for full screen. It shows today in big type, the next six days, who's driving, chores and groceries (tap to check off), and updates live. It shows what relatives see (no practices — add `?practices=1` to the address to include them); tap “sign in” at the bottom to include the Family calendar too.

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
| `scripts/notify.mjs` | Reminders, change alerts, Sunday summary and weekly email (run by `.github/workflows/notify.yml`) |
| `scripts/firestore.mjs` | Reads Firebase as the service account (used by `notify.mjs`) |
| `tv/` | Kitchen display for the Echo Show |
| `lib/events.js` | Repeating events and team-feed merging, shared by the app, display and sync |
| `scripts/add-events.mjs` | Command-line import used for email: `CAL_PASSCODE=… node scripts/add-events.mjs events.json` |

If you ever change the passcode, update the `CAL_PASSCODE` secret too.
