"use client";

// settings_screen.dart + the new "Your devices" section (sessions UI, P10 §7).

import Link from "next/link";
import { useState } from "react";
import { ApiError, rpc } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useRpc } from "@/lib/use-rpc";
import { ActionRow, Art, Banner, Button, ErrorState, KeyValue, LoadingState, PageTitle, SectionCard, Sheet } from "../ui";

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
  const [confirmOut, setConfirmOut] = useState(false);

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
      <div className="mx-auto flex max-w-xl md:max-w-2xl flex-col gap-4 p-page">
        <SectionCard>
          <p className="text-title-md font-medium">{context?.employee.name}</p>
          <p className="text-body-md text-text-secondary">
            {context?.employee.code} · {context?.org.name}
          </p>
          <Link href="/settings/password" className="mt-3 flex min-h-12 items-center justify-center gap-2 rounded-button border border-border font-semibold text-primary">
            <Art name="password" size={22} />
            Change password
          </Link>
        </SectionCard>
        <section aria-labelledby="notif-h" className="flex flex-col gap-2">
          <h2 id="notif-h" className="px-1 text-title-sm font-semibold">
            Notifications
          </h2>
          <ActionRow art="notifications" label="Notifications" subtitle="Turn on alerts, choose what to get, quiet hours" tile="bg-leave-card" href="/settings/notifications" />
          <ActionRow art="holiday_calendar" label="Calendar subscription" subtitle="Holidays and your leave in your calendar app" tile="bg-attendance-card" href="/settings/calendar" />
          <ActionRow art="celebration" label="Birthday and anniversary" subtitle="Choose what colleagues see on Home" tile="bg-people-card" href="/settings/celebrations" />
        </section>
        <section aria-labelledby="security-h" className="flex flex-col gap-2">
          <h2 id="security-h" className="px-1 text-title-sm font-semibold">
            Sign-in security
          </h2>
          <ActionRow art="lock" label="Two-step sign-in" subtitle="A code from your phone at every sign-in" tile="bg-approvals-card" href="/settings/two-step" />
        </section>
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
        <SectionCard>
          <h2 className="text-title-sm font-semibold">About</h2>
          <div className="mt-2">
            <KeyValue k="App" v="HRMS web app" />
            <KeyValue k="Environment" v={process.env.NODE_ENV === "production" ? "Production" : "Development"} />
            <KeyValue k="Help" v={context?.org.support_contact || "Contact HR"} />
          </div>
        </SectionCard>
        <Button variant="danger" className="mt-4" onClick={() => setConfirmOut(true)}>
          Sign out
        </Button>
        {confirmOut && (
          <Sheet title="Sign out?" onClose={() => setConfirmOut(false)}>
            <p className="text-body-md text-text-secondary">You will need your password to sign in again on this device.</p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="text" onClick={() => setConfirmOut(false)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => void logout()}>
                Sign out
              </Button>
            </div>
          </Sheet>
        )}
      </div>
    </div>
  );
}
