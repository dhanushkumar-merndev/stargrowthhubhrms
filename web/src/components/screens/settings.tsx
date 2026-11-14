"use client";

// settings_screen.dart + the new "Your devices" section (sessions UI, P10 §7).

import { useState } from "react";
import { ApiError, rpc } from "@/lib/api";
import { roleLabel } from "@/lib/roles";
import { useSession } from "@/lib/session";
import { useRpc } from "@/lib/use-rpc";
import { ActionRow, Banner, Button, ErrorState, LoadingState, PageTitle, SectionCard } from "../ui";

interface DeviceSession {
  id: string;
  created_at: string;
  last_seen_at: string;
  user_agent: string | null;
  current: boolean;
}

/** "Chrome on Android" from a user agent, without fingerprinting detail. */
export function deviceName(ua: string | null): string {
  if (!ua) return "Unknown device";
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad|iOS/i.test(ua) ? "iPhone" : /Mac OS X|Macintosh/i.test(ua) ? "Mac" : /Windows/i.test(ua) ? "Windows" : /Linux/i.test(ua) ? "Linux" : null;
  const browser = /Edg\//.test(ua) ? "Edge" : /SamsungBrowser/i.test(ua) ? "Samsung Internet" : /Firefox|FxiOS/i.test(ua) ? "Firefox" : /Chrome|CriOS/i.test(ua) ? "Chrome" : /Safari/i.test(ua) ? "Safari" : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Unknown device";
}

export function Settings() {
  const { context, logout } = useSession();
  const sessions = useRpc<DeviceSession[]>("list_my_sessions");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function end(id: string | "others") {
    setBusy(id);
    setError(null);
    try {
      if (id === "others") await rpc("end_my_other_sessions");
      else await rpc("end_my_session", { p_session_id: id });
      await sessions.mutate();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not sign that device out.");
    } finally {
      setBusy(null);
    }
  }

  const others = (sessions.data ?? []).filter((s) => !s.current).length;
  return (
    <div className="min-h-dvh">
      <PageTitle title="Settings" back="/explore" />
      <div className="mx-auto flex max-w-xl flex-col gap-4 p-page">
        <SectionCard>
          <p className="text-title-md font-semibold">{context?.employee.name}</p>
          <p className="text-body-md text-text-secondary">
            {context?.employee.code} · {roleLabel(context?.role ?? "employee")}
          </p>
        </SectionCard>
        <ActionRow art="notifications" label="Notifications" subtitle="Turn on alerts, choose what to get, quiet hours" tile="bg-leave-card" href="/settings/notifications" />
        <ActionRow art="holiday_calendar" label="Calendar subscription" subtitle="Holidays and your leave in your calendar app" tile="bg-attendance-card" href="/settings/calendar" />
        <ActionRow art="celebration" label="Birthday and anniversary" subtitle="Choose what colleagues see on Home" tile="bg-people-card" href="/settings/celebrations" />
        <ActionRow art="lock" label="Two-step sign-in" subtitle="A code from your phone at every sign-in" tile="bg-approvals-card" href="/settings/two-step" />
        <ActionRow art="password" label="Change password" subtitle="Signs out your other devices" tile="bg-attendance-card" href="/settings/password" />
        <SectionCard>
          <h2 className="text-title-md font-semibold">Your devices</h2>
          <p className="mt-1 text-body-md text-text-secondary">Places where you are signed in. End any you don&apos;t recognise.</p>
          {error && (
            <div className="mt-3">
              <Banner>{error}</Banner>
            </div>
          )}
          {sessions.error ? (
            <ErrorState message={sessions.error.message} onRetry={() => void sessions.mutate()} />
          ) : !sessions.data ? (
            <LoadingState label="Loading devices" />
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {sessions.data.map((s) => (
                <li key={s.id} className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-body-lg font-medium">
                      {deviceName(s.user_agent)} {s.current && <span className="text-body-sm font-semibold text-success">· This device</span>}
                    </p>
                    <p className="text-body-sm text-text-secondary">Last active {new Date(s.last_seen_at).toLocaleString()}</p>
                  </div>
                  {!s.current && (
                    <Button variant="outlined" busy={busy === s.id} onClick={() => void end(s.id)} aria-label={`Sign out ${deviceName(s.user_agent)}`}>
                      Sign out
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {others > 0 && (
            <Button variant="outlined" className="mt-2 w-full" busy={busy === "others"} onClick={() => void end("others")}>
              Sign out all other devices
            </Button>
          )}
        </SectionCard>
        <Button variant="danger" onClick={() => void logout()}>
          Sign out
        </Button>
      </div>
    </div>
  );
}
