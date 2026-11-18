"use client";

// Asks for notifications on every app screen until they are on for this
// device. "Not now" hides it for this visit only, so it comes back the next
// time HRMS is opened. It never shows where nobody can act on it: browsers
// without push, a server without push keys, and the notification settings
// page (which has the same controls).

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { PushSetupError, currentEnv, enablePush, pushEnabledHere, pushPublicKey, pushSupport } from "@/lib/push";
import { Art, Banner, Button, Sheet } from "./ui";

export type NotificationNeed = "ask" | "blocked" | "install";

const SNOOZE_KEY = "hrms.notification-prompt.snoozed";
const SKIP_PATHS = ["/settings/notifications"];

function snoozed(): boolean {
  try {
    return sessionStorage.getItem(SNOOZE_KEY) === "1";
  } catch {
    return false;
  }
}

function snooze() {
  try {
    sessionStorage.setItem(SNOOZE_KEY, "1");
  } catch {
    /* hidden for now anyway */
  }
}

/** What this device still needs before it can receive notifications, or null. */
export async function notificationNeed(): Promise<NotificationNeed | null> {
  const support = pushSupport(currentEnv());
  if (support === "unsupported") return null;
  const key = await pushPublicKey().catch(() => null);
  if (!key) return null; // push is not set up on the server: nothing to ask for
  if (support === "ios-needs-install") return "install";
  if (support === "denied") return "blocked";
  return (await pushEnabledHere()) ? null : "ask";
}

/** Platform-specific steps to allow notifications that were blocked. */
export function unblockSteps(ua: string, standalone: boolean): string[] {
  if (/Android/i.test(ua) && standalone) {
    return ["Press and hold the HRMS app icon, then tap App info.", "Tap Notifications and turn them on.", "Come back here and tap Check again."];
  }
  if (/Android/i.test(ua)) {
    return ["Tap the icon to the left of the web address.", "Tap Permissions (or Site settings), then Notifications, and choose Allow.", "Come back here and tap Check again."];
  }
  return ["Click the icon to the left of the web address.", "Set Notifications to Allow.", "Reload the page if the browser asks, then click Check again."];
}

const INSTALL_STEPS = [
  "Tap the Share button at the bottom of Safari.",
  "Tap Add to Home Screen, then Add.",
  "Open HRMS from the new Home Screen icon and turn on notifications there.",
];

export function NotificationPrompt() {
  const path = usePathname();
  const [need, setNeed] = useState<NotificationNeed | null>(null);
  const [hidden, setHidden] = useState(snoozed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);

  const check = useCallback(async () => {
    const n = await notificationNeed().catch(() => null);
    if (live.current) setNeed(n);
    return n;
  }, []);

  useEffect(() => {
    live.current = true;
    void check();
    // Re-check when people come back, e.g. after allowing it in site settings.
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live.current = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [check]);

  if (!need || hidden || SKIP_PATHS.includes(path)) return null;

  const later = () => {
    snooze();
    setHidden(true);
  };

  async function turnOn() {
    setBusy(true);
    setError(null);
    try {
      await enablePush();
      setNeed(null);
    } catch (e) {
      setError(e instanceof PushSetupError ? e.message : "Could not turn on notifications. Try again.");
      if (typeof Notification !== "undefined" && Notification.permission === "denied") setNeed("blocked");
    } finally {
      setBusy(false);
    }
  }

  async function checkAgain() {
    setBusy(true);
    setError(null);
    const n = await check();
    setBusy(false);
    if (n === "blocked") setError("Notifications are still blocked. Follow the steps above, then try again.");
  }

  const env = currentEnv();
  const steps = need === "install" ? INSTALL_STEPS : need === "blocked" ? unblockSteps(navigator.userAgent, env.standalone) : [];

  return (
    <Sheet title={need === "blocked" ? "Notifications are blocked" : "Turn on notifications"} onClose={later}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-4">
          <Art name="notifications" size={56} />
          <p className="text-body-md text-text-secondary">
            {need === "ask" && "Get leave approvals, requests, attendance alerts and announcements on this device, even when HRMS is closed."}
            {need === "blocked" && "HRMS can't alert you about approvals, requests and announcements because notifications are blocked for this site."}
            {need === "install" && "On iPhone and iPad, notifications work once HRMS is added to your Home Screen."}
          </p>
        </div>
        {steps.length > 0 && (
          <ol className="flex list-decimal flex-col gap-2 pl-6 text-body-md">
            {steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        )}
        {error && <Banner>{error}</Banner>}
        <div className="flex flex-col gap-2">
          {need === "ask" && (
            <Button busy={busy} onClick={() => void turnOn()}>
              Turn on notifications
            </Button>
          )}
          {need === "blocked" && (
            <Button busy={busy} onClick={() => void checkAgain()}>
              Check again
            </Button>
          )}
          <Button variant="text" onClick={later}>
            Not now
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
