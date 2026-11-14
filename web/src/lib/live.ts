"use client";

// Live updates from the Rust SSE hub (/api/v1/live). One EventSource per tab,
// shared by every screen that listens. Events carry ids only; screens re-read
// through RPCs. The server ends each stream after ~10 minutes and EventSource
// reconnects with Last-Event-ID; if the browser gives up (e.g. a 401 or a
// network error during connect) we reopen with ?after=<last id> and backoff.

import { useEffect, useRef, useState } from "react";
import { API_BASE } from "./api";

export type Conn = "connecting" | "live" | "offline";

export interface LiveEvent {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
}

type Handler = (e: LiveEvent) => void;

interface SourceLike {
  readyState: number;
  onopen: ((ev: Event) => void) | null;
  onerror: ((ev: Event) => void) | null;
  addEventListener(type: string, fn: (ev: MessageEvent) => void): void;
  close(): void;
}
export type SourceFactory = (url: string) => SourceLike;

const CLOSED = 2;

export class LiveClient {
  private source: SourceLike | null = null;
  private handlers = new Map<Handler, Set<string>>();
  private connListeners = new Set<(c: Conn) => void>();
  private kinds = new Set<string>();
  private lastId: number | null = null;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  conn: Conn = "connecting";

  private readonly factory: SourceFactory;
  private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;

  constructor(factory: SourceFactory, schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout) {
    this.factory = factory;
    this.schedule = schedule;
  }

  subscribe(kinds: string[], fn: Handler): () => void {
    this.handlers.set(fn, new Set(kinds));
    const fresh = kinds.filter((k) => !this.kinds.has(k));
    fresh.forEach((k) => this.kinds.add(k));
    if (!this.source) this.open();
    else fresh.forEach((k) => this.listen(this.source!, k));
    return () => {
      this.handlers.delete(fn);
      if (this.handlers.size === 0) this.stop();
    };
  }

  onConn(fn: (c: Conn) => void): () => void {
    this.connListeners.add(fn);
    fn(this.conn);
    return () => this.connListeners.delete(fn);
  }

  private setConn(c: Conn) {
    if (c === this.conn) return;
    this.conn = c;
    this.connListeners.forEach((fn) => fn(c));
  }

  private open() {
    const url = `${API_BASE}/live${this.lastId != null ? `?after=${this.lastId}` : ""}`;
    const s = this.factory(url);
    this.source = s;
    s.onopen = () => {
      this.retry = 0;
      this.setConn("live");
    };
    s.onerror = () => {
      this.setConn("offline");
      if (s.readyState === CLOSED && this.source === s) {
        // The browser stopped retrying: reopen ourselves, resuming after lastId.
        this.source = null;
        const delay = Math.min(30000, 1000 * 2 ** this.retry++);
        this.timer = this.schedule(() => {
          this.timer = null;
          if (this.handlers.size > 0 && !this.source) this.open();
        }, delay);
      }
    };
    this.kinds.forEach((k) => this.listen(s, k));
  }

  private listen(s: SourceLike, kind: string) {
    s.addEventListener(kind, (ev: MessageEvent) => {
      if (s !== this.source) return;
      let e: LiveEvent;
      try {
        e = JSON.parse(String(ev.data)) as LiveEvent;
      } catch {
        return;
      }
      if (typeof e.id !== "number" || (this.lastId != null && e.id <= this.lastId)) return;
      this.lastId = e.id;
      this.handlers.forEach((ks, fn) => ks.has(e.kind) && fn(e));
    });
  }

  private stop() {
    this.source?.close();
    this.source = null;
    this.kinds.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.setConn("connecting");
  }
}

let shared: LiveClient | null = null;
function client(): LiveClient | null {
  if (typeof window === "undefined" || typeof EventSource === "undefined") return null;
  shared ??= new LiveClient((url) => new EventSource(url, { withCredentials: true }));
  return shared;
}

/**
 * Calls `onEvent` (debounced by `debounceMs`, with every id collected) when
 * any of `kinds` arrives. Returns the connection state for a status dot.
 */
export function useLive(kinds: string[], onEvent: (events: LiveEvent[]) => void, debounceMs = 300): Conn {
  const [conn, setConn] = useState<Conn>("connecting");
  const cb = useRef(onEvent);
  useEffect(() => {
    cb.current = onEvent;
  }, [onEvent]);
  const key = kinds.join(",");
  useEffect(() => {
    const c = client();
    if (!c) return;
    let batch: LiveEvent[] = [];
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = c.subscribe(key.split(","), (e) => {
      batch.push(e);
      t ??= setTimeout(() => {
        t = null;
        const b = batch;
        batch = [];
        cb.current(b);
      }, debounceMs);
    });
    const offConn = c.onConn(setConn);
    return () => {
      if (t) clearTimeout(t);
      off();
      offConn();
    };
  }, [key, debounceMs]);
  return conn;
}
