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

## San Antonio PBR preview

Build the standalone sample payroll preview with `npm run preview:build`. Open `preview/PBR_Payroll_Preview.html` directly in a browser, or serve only that folder locally:

```bash
python3 -m http.server 8765 --bind 127.0.0.1 --directory preview
```

Then open `http://localhost:8765/PBR_Payroll_Preview.html`. This generated artifact disables authentication requests and Socket.IO entirely, uses synthetic drivers, and saves edits only in browser local storage. **Reset sample data** restores the demo. It is not served by the production application.

The **San Antonio PBR** route choices in SATX Local, Dallas, and Memphis TN pay Austin $150, McAllen $350, Corpus Christi $250, Houston $300, Dallas $350, and Amarillo $700 for each complete roundtrip. Record the trip on its departure day; returning loaded or empty does not change pay. Multiple trips are allowed per day. Amounts are saved with each trip, so future catalog changes do not change existing entries.

Add drivers in their terminal section and leave the daily rate blank for PBR-only drivers. All drivers can use **PBR trips** in their Route choices. PBR replaces local/legacy-route pay for that day; switching an existing paid day requires confirmation and clears conflicting entries. Removing the last trip leaves the day unpaid rather than restoring replaced local entries.

Assist is opt-in: no assist, $75, or a custom nonnegative dollar amount. PBR assist applies per trip; local/legacy-route assist applies once per day. Existing miscellaneous payments and legacy routes remain independent and are not converted automatically. Avoid recording the same assist both on a trip/day and as a miscellaneous payment.

New weeks carry driver names and local base rates forward, with no trips or assist copied. Saved weeks gain empty PBR fields when loaded; any roster from the retired dedicated PBR section moves intact into SATX Local on load, with trips and saved amounts preserved. Summary groups repeated driver names using trimmed, case-insensitive matching and includes task-only drivers, keeping task payments counted once. No driver identity migration is included.

Before a future production rollout, retain a backup of saved payroll state and have all users refresh the app so older browser code cannot recreate the retired PBR section. Authentication and Friday payout rules are unchanged. Run `npm test` for payroll regression cases (96 baseline calculations), PBR/assist totals, reload/week-copy behavior, and authentication checks.
