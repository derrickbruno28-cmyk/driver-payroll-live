# Driver Payroll (Live Collaboration)

## Setup

1. Open a terminal in this folder.
2. Install dependencies:

```bash
npm install
```

3. Start the app:

```bash
npm start
```

4. Open from browser:

- Local: `http://localhost:3000`
- Team access: `http://<your-computer-ip>:3000`

## Notes

- All connected users see edits live.
- Shared data is saved to `data/payroll-state.json`.
- To reset all shared data, stop server and delete `data/payroll-state.json`.

## Postgres + Hourly Google Sheets Backup

This app now supports:

- Postgres-backed shared state (primary)
- File fallback state (if Postgres is unavailable in `auto` mode)
- Hourly Google Sheets backups via cron

### Required environment (Render recommended)

- `STORAGE_MODE=postgres` (or `auto`)
- `DATABASE_URL=<Render Postgres connection string>`

### Google Sheets backup environment

- `GOOGLE_SHEETS_SPREADSHEET_ID=<sheet id>`
- `GOOGLE_SHEETS_BACKUP_TAB=Backups` (optional; defaults to `Backups`)
- `BACKUP_CRON=0 * * * *` (optional; hourly default)

Service account credentials (choose one option):

1. `GOOGLE_SERVICE_ACCOUNT_JSON=<full JSON string>`
2. `GOOGLE_SERVICE_ACCOUNT_EMAIL=<service account email>` and `GOOGLE_PRIVATE_KEY=<private key with \\n escapes>`

Optional:

- `BACKUP_RUN_ON_STARTUP=true` (runs one backup at boot)

### Postgres schema

The server auto-creates:

- Table: `payroll_state`
- Single row key: `id=1`
- JSONB column `state` storing `{ "weeks": [...] }`

## Deploy To Render (24/7)

1. Push this folder to a GitHub repo.
2. Create a Render Postgres instance.
3. Create a Render Web Service from this repo.
4. Set env vars listed above (`DATABASE_URL`, `STORAGE_MODE`, and Sheets backup vars).
5. Deploy and share your URL (for example `https://driver-payroll-live.onrender.com`).

### Important

- If Postgres is enabled, it is used as primary state storage.
- File storage remains available as fallback in `auto` mode.
- Hourly Sheets backup depends on valid service account credentials.
