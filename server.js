const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'payroll-state.json');

let sharedState = { weeks: [] };

function ensureStorage() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(sharedState, null, 2));
    return;
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.weeks)) {
      sharedState = parsed;
    }
  } catch (err) {
    console.error('Failed to load state file, starting fresh.', err.message);
  }
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(sharedState, null, 2));
}

function broadcastPresence() {
  io.emit('presence:update', { count: io.engine.clientsCount });
}

ensureStorage();

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'Driver_Payroll.html'));
});

app.use(express.static(__dirname));

io.on('connection', (socket) => {
  socket.emit('state:snapshot', { clientId: socket.id, state: sharedState });
  broadcastPresence();

  socket.on('state:update', (payload) => {
    if (!payload || !Array.isArray(payload.weeks)) return;
    sharedState = { weeks: payload.weeks };
    saveState();
    io.emit('state:updated', { state: sharedState, sourceClientId: socket.id });
  });

  socket.on('disconnect', () => {
    broadcastPresence();
  });
});

server.listen(PORT, () => {
  console.log(`Driver Payroll live server running on http://localhost:${PORT}`);
});
