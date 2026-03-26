require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const os = require('os');
const pty = require('node-pty');

const app = express();

const PORT = Number(process.env.PORT || 3001);
const TERMINAL_TOKEN = process.env.TERMINAL_TOKEN || '';
const SHELL = process.env.SHELL_PATH || process.env.SHELL || '/bin/bash';
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS || 1000 * 60 * 60 * 6);
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 3);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
const MAX_INPUT_SIZE_BYTES = Number(process.env.MAX_INPUT_SIZE_BYTES || 16_384);
const MAX_BUFFER_CHARS = Number(process.env.MAX_BUFFER_CHARS || 500_000);
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 15_000);

if (!TERMINAL_TOKEN) {
  console.error('TERMINAL_TOKEN is required');
  process.exit(1);
}

app.use(express.json({ limit: '64kb' }));

if (CORS_ORIGIN) {
  const allowedOrigins = CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    }
  }));
} else {
  app.use(cors());
}

const sessions = new Map();

function now() {
  return Date.now();
}

function touchSession(session) {
  session.lastActivityAt = now();
}

function requireAuth(req, res, next) {
  const headerToken = req.header('x-terminal-token');
  const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
  const token = headerToken || queryToken;

  if (token !== TERMINAL_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

function getSession(id) {
  return sessions.get(id) || null;
}

function destroySession(id) {
  const session = sessions.get(id);
  if (!session) {
    return;
  }

  if (session.heartbeatTimer) {
    clearInterval(session.heartbeatTimer);
  }

  for (const client of session.clients) {
    try {
      client.write(`data: ${JSON.stringify({ type: 'exit', exitCode: session.exitCode ?? 0 })}\n\n`);
      client.end();
    } catch {}
  }

  try {
    session.pty.kill();
  } catch {}

  sessions.delete(id);
}

function createSession({ cols = 120, rows = 35 } = {}) {
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error(`Maximum number of sessions reached (${MAX_SESSIONS})`);
  }

  const id = crypto.randomUUID();
  const shell = pty.spawn(SHELL, ['-l'], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.env.HOME || os.homedir(),
    env: {
      ...process.env,
      TERM: 'xterm-256color'
    }
  });

  const session = {
    id,
    pty: shell,
    buffer: '',
    clients: new Set(),
    createdAt: now(),
    lastActivityAt: now(),
    exitCode: null,
    heartbeatTimer: null
  };

  shell.onData((data) => {
    session.buffer += data;
    if (session.buffer.length > MAX_BUFFER_CHARS) {
      session.buffer = session.buffer.slice(-MAX_BUFFER_CHARS);
    }

    for (const client of session.clients) {
      try {
        client.write(`data: ${JSON.stringify({ type: 'data', data })}\n\n`);
      } catch {}
    }
  });

  shell.onExit(({ exitCode }) => {
    session.exitCode = exitCode;
    for (const client of session.clients) {
      try {
        client.write(`data: ${JSON.stringify({ type: 'exit', exitCode })}\n\n`);
        client.end();
      } catch {}
    }

    if (session.heartbeatTimer) {
      clearInterval(session.heartbeatTimer);
    }

    sessions.delete(id);
  });

  session.heartbeatTimer = setInterval(() => {
    for (const client of session.clients) {
      try {
        client.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
      } catch {}
    }
  }, HEARTBEAT_INTERVAL_MS);

  sessions.set(id, session);
  return session;
}

setInterval(() => {
  const cutoff = now() - IDLE_TIMEOUT_MS;
  for (const [id, session] of sessions.entries()) {
    if (session.lastActivityAt < cutoff) {
      destroySession(id);
    }
  }
}, 60_000);

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    sessions: sessions.size
  });
});

app.post('/session', requireAuth, (req, res) => {
  try {
    const cols = Number(req.body?.cols || 120);
    const rows = Number(req.body?.rows || 35);

    const session = createSession({
      cols: Number.isFinite(cols) ? cols : 120,
      rows: Number.isFinite(rows) ? rows : 35
    });

    res.json({
      sessionId: session.id,
      expiresInMs: IDLE_TIMEOUT_MS
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/session/:id/stream', requireAuth, (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  touchSession(session);

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);

  if (session.buffer) {
    res.write(`data: ${JSON.stringify({ type: 'data', data: session.buffer })}\n\n`);
  }

  session.clients.add(res);

  req.on('close', () => {
    session.clients.delete(res);
  });
});

app.post('/session/:id/input', requireAuth, (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const data = typeof req.body?.data === 'string' ? req.body.data : '';
  if (!data) {
    return res.status(400).json({ error: 'Input payload missing' });
  }

  if (Buffer.byteLength(data, 'utf8') > MAX_INPUT_SIZE_BYTES) {
    return res.status(413).json({ error: `Input payload too large (max ${MAX_INPUT_SIZE_BYTES} bytes)` });
  }

  session.pty.write(data);
  touchSession(session);
  res.json({ ok: true });
});

app.post('/session/:id/resize', requireAuth, (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const cols = Number(req.body?.cols || 120);
  const rows = Number(req.body?.rows || 35);

  try {
    session.pty.resize(
      Number.isFinite(cols) ? cols : 120,
      Number.isFinite(rows) ? rows : 35
    );
    touchSession(session);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete('/session/:id', requireAuth, (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.json({ ok: true });
  }

  destroySession(session.id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`browser-terminal backend listening on port ${PORT}`);
});