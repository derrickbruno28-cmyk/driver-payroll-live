const crypto = require('crypto');
const { google } = require('googleapis');

const SESSION_TTL = 8 * 60 * 60 * 1000;
const LOGIN_TTL = 10 * 60 * 1000;

function createAuth(env = process.env, oauthOverride) {
  const domain = (env.GOOGLE_ALLOWED_DOMAIN || 'ghlogisticsllc.com').trim().toLowerCase();
  let base;
  try { base = new URL(env.APP_BASE_URL); } catch { /* Fail closed until configured. */ }
  const secure = base?.protocol === 'https:';
  const validBase = base && (secure || (base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname)));
  const configured = Boolean(validBase && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const origin = configured ? base.origin : null;
  const oauth = oauthOverride || (configured ? new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, `${origin}/auth/google/callback`
  ) : null);
  const sessions = new Map();
  const logins = new Map();
  const sessionCookie = secure ? '__Host-payroll_session' : 'payroll_session';
  const loginCookie = secure ? '__Host-payroll_login' : 'payroll_login';
  const random = () => crypto.randomBytes(32).toString('base64url');
  const cleanup = setInterval(() => {
    for (const map of [sessions, logins]) {
      for (const [key, value] of map) if (value.expires <= Date.now()) map.delete(key);
    }
  }, 60000);
  cleanup.unref();

  function cookie(req, name) {
    const entry = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`));
    return entry?.slice(name.length + 1);
  }
  function setCookie(res, name, value, maxAge) {
    res.cookie(name, value, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge });
  }
  function session(req) {
    const id = cookie(req, sessionCookie);
    const value = sessions.get(id);
    if (!value || value.expires <= Date.now()) {
      sessions.delete(id);
      return null;
    }
    return { ...value, id };
  }
  function requireLogin(req, res, next) {
    if (session(req)) return next();
    res.redirect('/login');
  }
  function sameOrigin(req) { return configured && req.headers.origin === origin; }

  function install(app, io) {
    app.use((_req, res, next) => {
      res.set('Cache-Control', 'no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Referrer-Policy', 'same-origin');
      res.set('X-Frame-Options', 'DENY');
      next();
    });
    app.get('/login', (req, res) => {
      if (session(req)) return res.redirect('/');
      res.sendFile(require('path').join(__dirname, 'Login.html'));
    });
    app.get('/auth/config', (_req, res) => res.json({ configured, domain }));
    app.get('/auth/me', (req, res) => {
      const current = session(req);
      if (!current) return res.status(401).json({ error: 'Sign in required.' });
      res.json({ email: current.email });
    });
    app.get('/auth/google', (_req, res) => {
      if (!configured) return res.status(503).send('Google sign-in setup is incomplete. Contact your administrator.');
      if (logins.size >= 10000) return res.status(503).send('Please try again later.');
      const state = random();
      const nonce = random();
      const verifier = random();
      logins.set(state, { nonce, verifier, expires: Date.now() + LOGIN_TTL });
      setCookie(res, loginCookie, state, LOGIN_TTL);
      res.redirect(oauth.generateAuthUrl({
        scope: ['openid', 'email'], hd: domain, prompt: 'select_account', state, nonce,
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256'
      }));
    });
    app.get('/auth/google/callback', async (req, res) => {
      const state = req.query.state;
      const login = typeof state === 'string' && logins.get(state);
      if (!configured || !login || login.expires <= Date.now() || cookie(req, loginCookie) !== state) {
        return res.redirect('/login?error=expired');
      }
      logins.delete(state);
      setCookie(res, loginCookie, '', 0);
      if (req.query.error || typeof req.query.code !== 'string') return res.redirect('/login?error=cancelled');
      try {
        const { tokens } = await oauth.getToken({ code: req.query.code, codeVerifier: login.verifier });
        const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: env.GOOGLE_CLIENT_ID });
        const user = ticket.getPayload();
        if (!user || user.nonce !== login.nonce || !user.sub || user.email_verified !== true ||
            user.hd?.toLowerCase() !== domain || user.email?.toLowerCase().split('@')[1] !== domain) {
          return res.redirect('/login?error=domain');
        }
        if (sessions.size >= 10000) return res.redirect('/login?error=failed');
        const previousId = cookie(req, sessionCookie);
        sessions.delete(previousId);
        for (const socket of io.sockets.sockets.values()) {
          if (socket.data.sessionId === previousId) socket.disconnect(true);
        }
        const id = random();
        sessions.set(id, { email: user.email, expires: Date.now() + SESSION_TTL });
        setCookie(res, sessionCookie, id, SESSION_TTL);
        res.redirect('/');
      } catch {
        res.redirect('/login?error=failed');
      }
    });
    app.post('/auth/logout', (req, res) => {
      if (!sameOrigin(req)) return res.status(403).json({ error: 'Invalid origin.' });
      const current = session(req);
      if (current) {
        sessions.delete(current.id);
        for (const socket of io.sockets.sockets.values()) {
          if (socket.data.sessionId === current.id) socket.disconnect(true);
        }
      }
      setCookie(res, sessionCookie, '', 0);
      res.sendStatus(204);
    });
  }
  return { configured, domain, install, session, requireLogin, sameOrigin };
}

module.exports = { createAuth };
