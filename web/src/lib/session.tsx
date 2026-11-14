"use client";

import { disablePush } from "./push";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { ApiError, authApi, onSessionProblem, rpc } from "./api";
import { caps, type Caps, type SessionContext } from "./roles";
import type { Phase } from "./routing";

interface SessionState {
  phase: Phase;
  context: SessionContext | null;
  caps: Caps;
  /** Shown on the sign-in screen (e.g. "Session expired"). */
  message: string | null;
  refresh: () => Promise<void>;
  /** Resolves to a challenge when the account needs a two-step code. */
  login: (code: string, password: string) => Promise<{ challenge: string } | void>;
  loginTwoStep: (challenge: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<SessionState | null>(null);

export function phaseFor(ctx: SessionContext): Phase {
  return ctx.must_change_password || ctx.credential_hold ? "mustChangePassword" : "ready";
}

export function SessionProvider({ children, initialPhase = "loading" }: { children: React.ReactNode; initialPhase?: Phase }) {
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [context, setContext] = useState<SessionContext | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { mutate } = useSWRConfig();
  const seq = useRef(0);
  // Only someone who HAD a session sees "session expired" on the sign-in screen.
  const hadSession = useRef(false);

  const clearCache = useCallback(() => mutate(() => true, undefined, { revalidate: false }), [mutate]);

  const load = useCallback(() => {
    const mine = ++seq.current;
    return rpc<SessionContext>("get_session_context").then(
      (ctx) => {
        if (mine !== seq.current) return;
        hadSession.current = true;
        setContext(ctx);
        setPhase(phaseFor(ctx));
      },
      (e: unknown) => {
        if (mine !== seq.current) return;
        if (e instanceof ApiError && e.isSignedOut) {
          setContext(null);
          setPhase("signedOut");
        } else {
          setPhase("unreachable");
        }
      },
    );
  }, []);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  useEffect(() => {
    if (initialPhase === "loading") void load();
  }, [initialPhase, load]);

  // Any API call that discovers a dead session sends the user to sign-in.
  useEffect(
    () =>
      onSessionProblem((e) => {
        if (e.isSignedOut) {
          seq.current++;
          setContext(null);
          if (hadSession.current) setMessage(e.message || "Please sign in again.");
          hadSession.current = false;
          setPhase("signedOut");
          void clearCache();
        } else if (e.needsPasswordChange) {
          setPhase("mustChangePassword");
        }
      }),
    [clearCache],
  );

  const login = useCallback(
    async (code: string, password: string) => {
      const res = await authApi.login(code, password);
      if (res.data?.two_step_required && res.data.challenge) return { challenge: res.data.challenge };
      setMessage(null);
      await clearCache();
      await refresh();
    },
    [clearCache, refresh],
  );

  const loginTwoStep = useCallback(
    async (challenge: string, code: string) => {
      await authApi.loginTwoStep(challenge, code);
      setMessage(null);
      await clearCache();
      await refresh();
    },
    [clearCache, refresh],
  );

  const logout = useCallback(async () => {
    seq.current++;
    hadSession.current = false;
    try {
      // Stop pushes to this browser before the session ends (best effort, short).
      await Promise.race([disablePush().catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]);
      await authApi.logout();
    } finally {
      setContext(null);
      setMessage(null);
      setPhase("signedOut");
      await clearCache();
    }
  }, [clearCache]);

  const value = useMemo<SessionState>(
    () => ({ phase, context, caps: caps(context), message, refresh, login, loginTwoStep, logout }),
    [phase, context, message, refresh, login, loginTwoStep, logout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession outside SessionProvider");
  return v;
}
