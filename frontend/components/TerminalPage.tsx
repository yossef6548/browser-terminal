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

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';

const DEFAULT_TOKEN_STORAGE_KEY = 'browser-terminal-token';
const INPUT_FLUSH_INTERVAL_MS = 20;
const STREAM_STALE_AFTER_MS = 45_000;
const MAX_RECONNECT_ATTEMPTS = 6;

export default function TerminalPage() {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const resizeTimerRef = useRef<NodeJS.Timeout | null>(null);
  const cleanupResizeRef = useRef<(() => void) | null>(null);

  const inputBufferRef = useRef('');
  const inputFlushTimerRef = useRef<NodeJS.Timeout | null>(null);
  const inputInFlightRef = useRef(false);

  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const suppressReconnectRef = useRef(false);
  const lastStreamMessageAtRef = useRef(0);
  const streamWatchdogRef = useRef<NodeJS.Timeout | null>(null);

  const [token, setToken] = useState('');
  const [state, setState] = useState<ConnectionState>('idle');
  const [statusText, setStatusText] = useState('Not connected');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const stateRef = useRef<ConnectionState>('idle');

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const saved = window.localStorage.getItem(DEFAULT_TOKEN_STORAGE_KEY) ?? '';
    setToken(saved);
  }, []);

  const headers = useMemo<Record<string, string>>(() => {
    const result: Record<string, string> = {};
    if (token.trim()) {
      result['x-terminal-token'] = token.trim();
    }
    return result;
  }, [token]);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const clearWatchdog = useCallback(() => {
    if (streamWatchdogRef.current) {
      clearInterval(streamWatchdogRef.current);
      streamWatchdogRef.current = null;
    }
  }, []);

  const closeEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    clearWatchdog();
  }, [clearWatchdog]);

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

  const flushInput = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id || stateRef.current !== 'connected' || inputInFlightRef.current || !inputBufferRef.current) {
      return;
    }

    inputInFlightRef.current = true;
    const payload = inputBufferRef.current;
    inputBufferRef.current = '';

    try {
      await postJson(`/session/${id}/input`, { data: payload });
    } catch (error) {
      xtermRef.current?.writeln(`\r\n[input error] ${error instanceof Error ? error.message : String(error)}`);
      inputBufferRef.current = payload + inputBufferRef.current;
    } finally {
      inputInFlightRef.current = false;
      if (inputBufferRef.current) {
        inputFlushTimerRef.current = setTimeout(() => {
          void flushInput();
        }, INPUT_FLUSH_INTERVAL_MS);
      }
    }
  }, [postJson]);

  const enqueueInput = useCallback(
    (data: string) => {
      if (!data) {
        return;
      }
      inputBufferRef.current += data;
      if (inputFlushTimerRef.current) {
        return;
      }
      inputFlushTimerRef.current = setTimeout(() => {
        inputFlushTimerRef.current = null;
        void flushInput();
      }, INPUT_FLUSH_INTERVAL_MS);
    },
    [flushInput]
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

  const scheduleReconnect = useCallback(() => {
    if (suppressReconnectRef.current || !sessionIdRef.current || !token.trim()) {
      return;
    }

    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      setState('disconnected');
      setStatusText('Disconnected (reconnect limit reached)');
      xtermRef.current?.writeln('\r\n[reconnect failed: maximum attempts reached]');
      return;
    }

    const waitMs = Math.min(8_000, 300 * 2 ** reconnectAttemptsRef.current);
    reconnectAttemptsRef.current += 1;
    setState('reconnecting');
    setStatusText(`Reconnecting in ${Math.ceil(waitMs / 1000)}s...`);

    clearReconnectTimer();
    reconnectTimerRef.current = setTimeout(() => {
      const id = sessionIdRef.current;
      if (!id) {
        return;
      }
      attachStream(id, token.trim());
    }, waitMs);
  }, [clearReconnectTimer, token]);

  const startWatchdog = useCallback(() => {
    clearWatchdog();
    streamWatchdogRef.current = setInterval(() => {
      if (stateRef.current !== 'connected') {
        return;
      }
      if (Date.now() - lastStreamMessageAtRef.current > STREAM_STALE_AFTER_MS) {
        xtermRef.current?.writeln('\r\n[stream appears stale, reconnecting...]');
        closeEventSource();
        scheduleReconnect();
      }
    }, 5_000);
  }, [clearWatchdog, closeEventSource, scheduleReconnect]);

  const attachStream = useCallback((id: string, currentToken: string) => {
    closeEventSource();

    const streamUrl = `/backend/session/${id}/stream?token=${encodeURIComponent(currentToken)}`;
    const source = new EventSource(streamUrl);
    eventSourceRef.current = source;

    source.onopen = () => {
      reconnectAttemptsRef.current = 0;
      lastStreamMessageAtRef.current = Date.now();
      setState('connected');
      setStatusText('Connected');
      startWatchdog();
    };

    source.addEventListener('message', (event) => {
      lastStreamMessageAtRef.current = Date.now();
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
        suppressReconnectRef.current = true;
      } else if (payload.type === 'error') {
        terminal.writeln(`\r\n[stream error] ${payload.message ?? 'Unknown error'}`);
        setState('error');
        setStatusText('Stream error');
      }
    });

    source.onerror = () => {
      closeEventSource();
      scheduleReconnect();
    };
  }, [closeEventSource, scheduleReconnect, startWatchdog]);

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

    suppressReconnectRef.current = false;
    reconnectAttemptsRef.current = 0;
    clearReconnectTimer();

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

      inputBufferRef.current = '';
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
  }, [attachStream, clearReconnectTimer, closeEventSource, postJson, sendResize, token]);

  const disconnect = useCallback(async () => {
    suppressReconnectRef.current = true;
    clearReconnectTimer();
    closeEventSource();

    const terminal = xtermRef.current;
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
  }, [clearReconnectTimer, closeEventSource, postJson]);

  useEffect(() => {
    if (!terminalRef.current || xtermRef.current) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
      fontSize: 14,
      lineHeight: 1.25,
      scrollback: 8_000,
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
    cleanupResizeRef.current = bindResize();

    const inputDisposable = terminal.onData((data) => {
      if (!sessionIdRef.current || stateRef.current !== 'connected') {
        return;
      }
      enqueueInput(data);
    });

    const beforeUnload = () => {
      suppressReconnectRef.current = true;
      closeEventSource();
    };

    window.addEventListener('beforeunload', beforeUnload);

    return () => {
      inputDisposable.dispose();
      window.removeEventListener('beforeunload', beforeUnload);
      cleanupResizeRef.current?.();
      closeEventSource();
      clearReconnectTimer();
      if (inputFlushTimerRef.current) {
        clearTimeout(inputFlushTimerRef.current);
      }
      terminal.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
  }, [bindResize, clearReconnectTimer, closeEventSource, enqueueInput]);

  const stateClass =
    state === 'connected'
      ? styles.success
      : state === 'connecting' || state === 'reconnecting'
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
            <div className={styles.subtitle}>Low-latency buffered input, auto-reconnect stream handling, and a real PTY shell on your Ubuntu box.</div>
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
            <button className={styles.button} onClick={() => void connect()} disabled={state === 'connecting' || state === 'reconnecting'}>
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
