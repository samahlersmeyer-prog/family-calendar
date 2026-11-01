// The app installs this into .github/workflows/ during setup (folders starting
// with "." are easy to miss when uploading through the GitHub website).
export const WORKFLOW_PATH = '.github/workflows/sync-feeds.yml';
export const WORKFLOW_YML = `name: Sync team feeds

on:
  schedule:
    - cron: '*/30 * * * *'   # every 30 minutes
  workflow_dispatch:
  push:
    paths: ['data/calendar.enc']

permissions:
  contents: write

concurrency:
  group: sync-feeds
  cancel-in-progress: false

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Pull GameChanger / SportsYou / other calendar feeds
        run: node scripts/sync-feeds.mjs
        env:
          CAL_PASSCODE: \${{ secrets.CAL_PASSCODE }}
      - name: Save
        run: |
          git config user.name "calendar-bot"
          git config user.email "calendar-bot@users.noreply.github.com"
          git add -A data/
          if git diff --cached --quiet; then echo "No changes"; exit 0; fi
          git commit -m "Sync team feeds"
          git pull --rebase
          git push
`;
