import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';

const app = express();

const PORT = Number(process.env.PORT || 5000);
const HOST = process.env.HOST || '127.0.0.1';
const TERMINAL_TOKEN = process.env.TERMINAL_TOKEN;
const SHELL = process.env.SHELL_PATH || process.env.SHELL || '/bin/bash';
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS || 1000 * 60 * 60 * 6);
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 3);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';

if (!TERMINAL_TOKEN) {
  console.error('TERMINAL_TOKEN is required');
  process.exit(1);
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '64kb' }));
app.use(
  cors({
    origin: CORS_ORIGIN ? CORS_ORIGIN.split(',').map((v) => v.trim()) : true,
    credentials: false
  })
);

const sessions = new Map();

function getToken(req) {
  return req.header('x-terminal-token') || req.query.token;
}

function requireAuth(req, res, next) {
  if (getToken(req) !== TERMINAL_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function touchSession(session) {
  session.lastActivityAt = Date.now();
}

function serializeSession(session) {
  return {
    sessionId: session.id,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
    cols: session.pty.cols,
    rows: session.pty.rows
  };
}

function closeSession(id, reason = 'closed') {
  const session = sessions.get(id);
  if (!session) {
    return false;
  }

  for (const client of session.clients) {
    try {
      client.write(`data: ${JSON.stringify({ type: 'error', message: `Session ${reason}` })}\n\n`);
      client.end();
    } catch {}
  }

  session.clients.clear();

  try {
    session.pty.kill();
  } catch {}

  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
  }

  sessions.delete(id);
  return true;
}

function scheduleIdleReaper(session) {
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
  }

  session.cleanupTimer = setTimeout(() => {
    const current = sessions.get(session.id);
    if (!current) {
      return;
    }

    if (Date.now() - current.lastActivityAt >= IDLE_TIMEOUT_MS) {
      closeSession(current.id, 'expired');
      return;
    }

    scheduleIdleReaper(current);
  }, Math.min(IDLE_TIMEOUT_MS, 60_000));
}

function createSession({ cols = 120, rows = 35 } = {}) {
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.lastActivityAt - b.lastActivityAt)[0];
    if (oldest) {
      closeSession(oldest.id, 'evicted');
    }
  }

  const id = uuidv4();
  const shell = pty.spawn(SHELL, ['-l'], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: os.homedir(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    }
  });

  const session = {
    id,
    pty: shell,
    clients: new Set(),
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    buffer: '',
    cleanupTimer: null
  };

  shell.onData((data) => {
    session.buffer += data;
    if (session.buffer.length > 500_000) {
      session.buffer = session.buffer.slice(-500_000);
    }

    for (const client of session.clients) {
      client.write(`data: ${JSON.stringify({ type: 'data', data })}\n\n`);
    }

    touchSession(session);
  });

  shell.onExit(({ exitCode }) => {
    for (const client of session.clients) {
      client.write(`data: ${JSON.stringify({ type: 'exit', exitCode })}\n\n`);
      client.end();
    }
    session.clients.clear();
    sessions.delete(id);
  });

  scheduleIdleReaper(session);
  sessions.set(id, session);
  return session;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, sessions: sessions.size });
});

app.get('/sessions', requireAuth, (_req, res) => {
  res.json({ sessions: [...sessions.values()].map(serializeSession) });
});

app.post('/session', requireAuth, (req, res) => {
  const cols = Number(req.body?.cols || 120);
  const rows = Number(req.body?.rows || 35);
  const session = createSession({ cols, rows });
  res.status(201).json({ sessionId: session.id, expiresInMs: IDLE_TIMEOUT_MS });
});

app.get('/session/:id/stream', requireAuth, (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  session.clients.add(res);
  touchSession(session);

  if (session.buffer) {
    res.write(`data: ${JSON.stringify({ type: 'data', data: session.buffer })}\n\n`);
  }

  const heartbeat = setInterval(() => {
    res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
  }, 20_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    session.clients.delete(res);
    touchSession(session);
  });
});

app.post('/session/:id/input', requireAuth, (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const data = typeof req.body?.data === 'string' ? req.body.data : '';
  session.pty.write(data);
  touchSession(session);
  res.json({ ok: true });
});

app.post('/session/:id/resize', requireAuth, (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const cols = Math.max(20, Number(req.body?.cols || 120));
  const rows = Math.max(5, Number(req.body?.rows || 35));
  session.pty.resize(cols, rows);
  touchSession(session);
  res.json({ ok: true });
});

app.delete('/session/:id', requireAuth, (req, res) => {
  const deleted = closeSession(req.params.id, 'closed by client');
  if (!deleted) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.status(204).send();
});

app.listen(PORT, HOST, () => {
  console.log(`Browser terminal backend listening on http://${HOST}:${PORT}`);
});
