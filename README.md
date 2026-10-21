# 🕊️ Freed

A Notion-style study accountability app. Set tasks, take a start and end photo, rate yourself, and compete on a leaderboard.

## Run it
Serve the folder statically (`python3 -m http.server`). With no setup it runs in **demo mode** (data stays in your browser).

## Connect to Google Sheets
1. Open the [Freed sheet](https://docs.google.com/spreadsheets/d/1sJw0GarGdg2NFJ7SBNDA4s7z-rEgRntO5QDnTabbLh0/edit), then Extensions > Apps Script.
2. Paste `apps-script/Code.gs`, then Deploy > New deployment > Web app (Execute as: Me, Access: Anyone).
3. Paste the `/exec` URL into `config.js` as `FREED_API`.

Each person gets their own tab. A `Leaderboard` tab updates on every save. Photos go to the shared Freed Drive folder.

PINs are a light lock for a trusted group, not strong security.
