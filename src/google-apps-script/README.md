# Flappy Fish Google Sheets Web App

Deploy `Code.gs` as a Google Apps Script web app with access set to anyone with the link.

The script keeps every play attempt in the `Scores` sheet with these columns:

1. `Name`
2. `Score`
3. `Best Score`
4. `Updated At`

The public web endpoint still returns only the best score per player so the in-game leaderboard stays clean.
