# Driver Payroll (Live Collaboration)

## Setup

1. Open a terminal in this folder.
2. Install dependencies:

```bash
npm install
```

3. Configure Google sign-in as described below. For local development, copy `.env.example` to `.env` and fill in the OAuth credentials, then start with Node 22:

```bash
node --env-file=.env server.js
```

4. Open from browser:

- Local: `http://localhost:3000`
- Team access: use the configured HTTPS deployment URL.

## Google Workspace sign-in

Payroll access requires a verified Google Workspace account with both a hosted domain and email domain matching `GOOGLE_ALLOWED_DOMAIN` (default: `ghlogisticsllc.com`). Payout is Friday following the completed Sunday–Saturday payroll week (Sunday + 12 days). Entering a Friday in the week picker selects the payroll week it pays.

1. In your company's Google Cloud project, configure the Google Auth Platform audience as **Internal** for your Workspace organization. See [Google's OpenID Connect setup](https://developers.google.com/identity/openid-connect/openid-connect).
2. Create an OAuth client with application type **Web application**, named **GH Logistics Driver Payroll**. Add the exact authorized redirect URI: `https://driver-payroll-live.onrender.com/auth/google/callback`. For local development, also add `http://localhost:3000/auth/google/callback`.
3. Set these environment variables on Render:
   - `APP_BASE_URL`: `https://driver-payroll-live.onrender.com`.
   - `GOOGLE_CLIENT_ID`: the web OAuth client ID.
   - `GOOGLE_CLIENT_SECRET`: the client secret (server environment only; never commit it).
   - `GOOGLE_ALLOWED_DOMAIN`: the exact company Workspace email domain.
4. Redeploy, then sign in with a company account. Test that a personal or other-company account cannot access payroll.

The server verifies Google's ID token, including its hosted domain claim; the account chooser's domain hint alone does not grant access. See [Google's token verification guidance](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).

Missing login configuration locks payroll access. The payroll page and Socket.IO data connections require a session; server source and stored data files are not served. Login uses state, nonce, and PKCE checks, and the session cookie is HttpOnly, SameSite=Lax, and Secure on HTTPS. Sessions expire after eight hours; signing out disconnects live connections. Sessions are stored in server memory, so restarting signs everyone out. Use one Render instance with this implementation; multiple instances would require a shared session store.

Run `npm test` for authentication and payout-date checks. A real Google login requires the credentials and redirect registration above.

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
