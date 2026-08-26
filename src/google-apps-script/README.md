# Flappy Fish Google Sheets Sync

This script writes Flappy Fish leaderboard updates to:

https://docs.google.com/spreadsheets/d/199bPYl_Z3sJnb-8XEMWIe-4u-GDvHuYlNkAzRyOM0uM/edit

Deploy it as a Google Apps Script web app:

1. Open the Google Sheet.
2. Go to Extensions > Apps Script.
3. Paste `Code.gs`.
4. Deploy > New deployment > Web app.
5. Set "Execute as" to "Me".
6. Set "Who has access" to "Anyone".
7. Copy the `/exec` URL into `scoreEndpoint` in `web/config.js`.

After that, the game saves each changed best score to the `Scores` tab through the web app URL. The browser uses `GET` with `action=save`, so it works from a static page without cross-origin `POST` problems.
