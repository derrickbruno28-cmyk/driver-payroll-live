const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { Pool } = require('pg');
const { google } = require('googleapis');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'payroll-state.json');
const STORAGE_MODE = (process.env.STORAGE_MODE || 'auto').toLowerCase(); // auto | postgres | file
const BACKUP_CRON = process.env.BACKUP_CRON || '0 * * * *'; // hourly default
const SHEETS_TAB = process.env.GOOGLE_SHEETS_BACKUP_TAB || 'Backups';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

let pool = null;
let sheetsApi = null;
let sharedState = { weeks: [] };
let activeStorage = 'file';

function validState(candidate) {
  return Boolean(candidate && Array.isArray(candidate.weeks));
}

function ensureFileStorage() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(sharedState, null, 2));
  }
}

function loadFileState() {
  ensureFileStorage();
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (validState(parsed)) return parsed;
  } catch (err) {
    console.error('Failed to read file state; using empty default.', err.message);
  }
  return { weeks: [] };
}

function saveFileState(state) {
  ensureFileStorage();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function initPostgres() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing.');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payroll_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state JSONB NOT NULL DEFAULT '{"weeks":[]}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    INSERT INTO payroll_state (id, state)
    VALUES (1, '{"weeks":[]}'::jsonb)
    ON CONFLICT (id) DO NOTHING;
  `);
}

async function loadPostgresState() {
  const result = await pool.query('SELECT state FROM payroll_state WHERE id = 1;');
  const state = result.rows?.[0]?.state;
  return validState(state) ? state : { weeks: [] };
}

async function savePostgresState(state) {
  await pool.query(
    'UPDATE payroll_state SET state = $1::jsonb, updated_at = NOW() WHERE id = 1;',
    [JSON.stringify(state)]
  );
}

function resolveServiceAccount() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }
  if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    return {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
    };
  }
  return null;
}

async function initSheets() {
  if (!process.env.GOOGLE_SHEETS_SPREADSHEET_ID) return;
  const credentials = resolveServiceAccount();
  if (!credentials) {
    console.warn('Sheets backup disabled: missing service account credentials.');
    return;
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  sheetsApi = google.sheets({ version: 'v4', auth });
  console.log('Google Sheets backup enabled.');
}

async function runSheetsBackup(reason) {
  if (!sheetsApi || !process.env.GOOGLE_SHEETS_SPREADSHEET_ID) return;
  try {
    const row = [
      new Date().toISOString(),
      reason,
      activeStorage,
      JSON.stringify(sharedState)
    ];
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
      range: `${SHEETS_TAB}!A:D`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] }
    });
    console.log(`Sheets backup written (${reason}).`);
  } catch (err) {
    console.error('Sheets backup failed:', err.message);
  }
}

function startBackupCron() {
  if (!sheetsApi || !process.env.GOOGLE_SHEETS_SPREADSHEET_ID) return;
  if (!cron.validate(BACKUP_CRON)) {
    console.error(`Invalid BACKUP_CRON expression "${BACKUP_CRON}".`);
    return;
  }
  cron.schedule(BACKUP_CRON, () => {
    runSheetsBackup('cron-hourly');
  });
  console.log(`Backup cron started with "${BACKUP_CRON}".`);
}

async function initializeState() {
  const wantsPg = STORAGE_MODE === 'postgres' || (STORAGE_MODE === 'auto' && process.env.DATABASE_URL);
  if (wantsPg) {
    try {
      await initPostgres();
      sharedState = await loadPostgresState();
      activeStorage = 'postgres';
      console.log('State storage: postgres');
      return;
    } catch (err) {
      if (STORAGE_MODE === 'postgres') throw err;
      console.warn('Postgres unavailable; falling back to file storage:', err.message);
    }
  }
  sharedState = loadFileState();
  activeStorage = 'file';
  console.log('State storage: file');
}

async function persistState() {
  if (!validState(sharedState)) return;
  if (activeStorage === 'postgres' && pool) {
    await savePostgresState(sharedState);
    return;
  }
  saveFileState(sharedState);
}

function broadcastPresence() {
  io.emit('presence:update', { count: io.engine.clientsCount });
}

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'Driver_Payroll.html'));
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, storage: activeStorage });
});

app.use(express.static(__dirname));

io.on('connection', (socket) => {
  socket.emit('state:snapshot', { clientId: socket.id, state: sharedState });
  broadcastPresence();

  socket.on('state:update', async (payload) => {
    if (!payload || !Array.isArray(payload.weeks)) return;
    sharedState = { weeks: payload.weeks };
    try {
      await persistState();
      io.emit('state:updated', { state: sharedState, sourceClientId: socket.id });
    } catch (err) {
      console.error('Failed to persist state update:', err.message);
    }
  });

  socket.on('disconnect', () => {
    broadcastPresence();
  });
});

async function start() {
  await initializeState();
  await initSheets();
  startBackupCron();
  if (String(process.env.BACKUP_RUN_ON_STARTUP || '').toLowerCase() === 'true') {
    runSheetsBackup('startup');
  }
  server.listen(PORT, () => {
    console.log(`Driver Payroll live server running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
