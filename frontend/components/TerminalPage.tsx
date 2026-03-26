'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import 'xterm/css/xterm.css';
import styles from './TerminalPage.module.css';

type CreateSessionResponse = {
  sessionId: string;
  expiresInMs: number;
};

type BackendMessage = {
  type: 'data' | 'exit' | 'heartbeat' | 'error';
  data?: string;
  exitCode?: number;
  message?: string;
};

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

const DEFAULT_TOKEN_STORAGE_KEY = 'browser-terminal-token';

export default function TerminalPage() {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const resizeTimerRef = useRef<NodeJS.Timeout | null>(null);

  const [token, setToken] = useState('');
  const [state, setState] = useState<ConnectionState>('idle');
  const [statusText, setStatusText] = useState('Not connected');
  const [sessionId, setSessionId] = useState<string | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem(DEFAULT_TOKEN_STORAGE_KEY) ?? '';
    setToken(saved);
  }, []);

  useEffect(() => {
    if (!terminalRef.current || xtermRef.current) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
      fontSize: 14,
      lineHeight: 1.25,
      scrollback: 5000,
      convertEol: false,
      theme: {
        background: '#020617',
        foreground: '#e5e7eb',
        cursor: '#93c5fd',
        selectionBackground: 'rgba(147, 197, 253, 0.25)'
      }
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalRef.current);
    fitAddon.fit();
    terminal.writeln('Browser terminal ready. Paste your token and press Connect.');

    xtermRef.current = terminal;
    fitRef.current = fitAddon;

    return () => {
      closeEventSource();
      terminal.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
  }, []);

  const headers = useMemo<Record<string, string>>(() => {
    const result: Record<string, string> = {};
    if (token.trim()) {
      result['x-terminal-token'] = token.trim();
    }
    return result;
  }, [token]);

  const closeEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const postJson = useCallback(
    async (path: string, body?: unknown, method = 'POST') => {
      const requestHeaders: Record<string, string> = {
        'content-type': 'application/json',
        ...headers
      };

      const response = await fetch(`/backend${path}`, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body)
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        return response.json();
      }
      return response.text();
    },
    [headers]
  );

  const sendResize = useCallback(async () => {
    const sessionIdValue = sessionIdRef.current;
    const terminal = xtermRef.current;
    const fitAddon = fitRef.current;
    if (!sessionIdValue || !terminal || !fitAddon) {
      return;
    }

    fitAddon.fit();
    try {
      await postJson(`/session/${sessionIdValue}/resize`, {
        cols: terminal.cols,
        rows: terminal.rows
      });
    } catch {
      // ignore transient resize errors
    }
  }, [postJson]);

  const bindResize = useCallback(() => {
    const handler = () => {
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
      }
      resizeTimerRef.current = setTimeout(() => {
        void sendResize();
      }, 100);
    };

    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [sendResize]);

  useEffect(() => bindResize(), [bindResize]);

  const attachStream = useCallback((id: string, currentToken: string) => {
    closeEventSource();

    const streamUrl = `/backend/session/${id}/stream?token=${encodeURIComponent(currentToken)}`;
    const source = new EventSource(streamUrl);
    eventSourceRef.current = source;

    source.onopen = () => {
      setState('connected');
      setStatusText('Connected');
    };

    source.addEventListener('message', (event) => {
      const terminal = xtermRef.current;
      if (!terminal) {
        return;
      }

      let payload: BackendMessage;
      try {
        payload = JSON.parse(event.data) as BackendMessage;
      } catch {
        terminal.write(event.data);
        return;
      }

      if (payload.type === 'data' && payload.data) {
        terminal.write(payload.data);
      } else if (payload.type === 'exit') {
        terminal.writeln(`\r\n[process exited${payload.exitCode !== undefined ? ` with code ${payload.exitCode}` : ''}]`);
        setState('disconnected');
        setStatusText('Shell exited');
      } else if (payload.type === 'error') {
        terminal.writeln(`\r\n[stream error] ${payload.message ?? 'Unknown error'}`);
        setState('error');
        setStatusText('Stream error');
      }
    });

    source.onerror = () => {
      if (state === 'connected') {
        setState('disconnected');
        setStatusText('Disconnected');
        xtermRef.current?.writeln('\r\n[connection lost]');
      }
      closeEventSource();
    };
  }, [closeEventSource, state]);

  const connect = useCallback(async () => {
    const terminal = xtermRef.current;
    if (!terminal) {
      return;
    }
    if (!token.trim()) {
      setState('error');
      setStatusText('Token is required');
      terminal.writeln('\r\n[error] Enter the backend token first.');
      return;
    }

    window.localStorage.setItem(DEFAULT_TOKEN_STORAGE_KEY, token.trim());
    setState('connecting');
    setStatusText('Creating session...');

    try {
      closeEventSource();
      if (sessionIdRef.current) {
        try {
          await postJson(`/session/${sessionIdRef.current}`, undefined, 'DELETE');
        } catch {
          // ignore cleanup failures
        }
      }

      terminal.reset();
      terminal.writeln('Connecting...');

      const fitAddon = fitRef.current;
      fitAddon?.fit();
      const result = (await postJson('/session', {
        cols: xtermRef.current?.cols ?? 120,
        rows: xtermRef.current?.rows ?? 35
      })) as CreateSessionResponse;

      sessionIdRef.current = result.sessionId;
      setSessionId(result.sessionId);
      setStatusText('Attaching stream...');
      attachStream(result.sessionId, token.trim());
      await sendResize();

    } catch (error) {
      setState('error');
      setStatusText('Failed to connect');
      terminal.writeln(`\r\n[error] ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [attachStream, closeEventSource, postJson, sendResize, token]);

  const disconnect = useCallback(async () => {
    const terminal = xtermRef.current;
    closeEventSource();

    if (sessionIdRef.current) {
      try {
        await postJson(`/session/${sessionIdRef.current}`, undefined, 'DELETE');
      } catch (error) {
        terminal?.writeln(`\r\n[warning] Failed to close session cleanly: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    sessionIdRef.current = null;
    setSessionId(null);
    setState('idle');
    setStatusText('Disconnected');
    terminal?.writeln('\r\n[disconnected]');
  }, [closeEventSource, postJson]);

  useEffect(() => {
    const terminal = xtermRef.current;
    if (!terminal) {
      return;
    }

    const disposable = terminal.onData((data) => {
      const id = sessionIdRef.current;
      if (!id || state !== 'connected') {
        return;
      }

      void postJson(`/session/${id}/input`, { data }).catch((error) => {
        terminal.writeln(`\r\n[input error] ${error instanceof Error ? error.message : String(error)}`);
      });
    });

    return () => disposable.dispose();
  }, [postJson, state]);

  const stateClass =
    state === 'connected'
      ? styles.success
      : state === 'connecting'
        ? styles.warning
        : state === 'error'
          ? styles.error
          : undefined;

  return (
    <main className={styles.page}>
      <section className={styles.card}>
        <div className={styles.header}>
          <div className={styles.titleBlock}>
            <div className={styles.title}>Browser Terminal</div>
            <div className={styles.subtitle}>Up arrow, tab completion, Ctrl+C, colors, and interactive shells come from the real PTY on your Ubuntu box.</div>
          </div>
          <div className={styles.controls}>
            <input
              className={styles.input}
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Backend token"
              autoComplete="off"
            />
            <button className={styles.button} onClick={() => void connect()} disabled={state === 'connecting'}>
              Connect
            </button>
            <button className={`${styles.button} ${styles.secondary}`} onClick={() => void disconnect()}>
              Disconnect
            </button>
          </div>
        </div>
        <div className={styles.statusBar}>
          <span className={stateClass}>{statusText}</span>
          <span>Session: {sessionId ?? '—'}</span>
        </div>
        <div className={styles.terminalWrap}>
          <div ref={terminalRef} className={styles.terminal} />
        </div>
      </section>
    </main>
  );
}
