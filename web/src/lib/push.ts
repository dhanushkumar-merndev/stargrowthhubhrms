// Web Push on this device: support checks, subscribe/unsubscribe, and the
// pieces of the inbox that are pure (paging, categories, quiet hours).
//
// iPhone/iPad only allow push for a web app added to the Home Screen
// (iOS 16.4+), so the screen explains that instead of offering a button
// that cannot work.

import { API_BASE, post, rpc } from "./api";

export type PushSupport = "ok" | "unsupported" | "ios-needs-install" | "denied";

interface Env {
  hasSW: boolean;
  hasPush: boolean;
  hasNotification: boolean;
  permission: NotificationPermission | "default";
  ios: boolean;
  standalone: boolean;
}

export function pushSupport(e: Env): PushSupport {
  if (e.ios && !e.standalone) return "ios-needs-install";
  if (!e.hasSW || !e.hasPush || !e.hasNotification) return "unsupported";
  if (e.permission === "denied") return "denied";
  return "ok";
}

export function currentEnv(): Env {
  const nav = typeof navigator === "undefined" ? null : navigator;
  const ua = nav?.userAgent ?? "";
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1);
  const standalone =
    typeof window !== "undefined" &&
    ((window.matchMedia?.("(display-mode: standalone)").matches ?? false) || (nav as Navigator & { standalone?: boolean })?.standalone === true);
  return {
    hasSW: !!nav && "serviceWorker" in nav,
    hasPush: typeof window !== "undefined" && "PushManager" in window,
    hasNotification: typeof Notification !== "undefined",
    permission: typeof Notification !== "undefined" ? Notification.permission : "default",
    ios,
    standalone,
  };
}

/** base64url → bytes for applicationServerKey. */
export function urlB64ToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const INSTALL_KEY = "hrms.installation";

/** Stable random id for this browser profile (rebinding, unsubscribe). */
export function installationId(storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage()): string {
  try {
    const have = storage?.getItem(INSTALL_KEY);
    if (have && /^[0-9a-f-]{36}$/.test(have)) return have;
    const id = crypto.randomUUID();
    storage?.setItem(INSTALL_KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export async function pushPublicKey(): Promise<string | null> {
  const res = await fetch(`${API_BASE}/push/config`, { headers: { "x-requested-with": "hrms-web" }, credentials: "same-origin", cache: "no-store" });
  if (!res.ok) return null;
  const j = (await res.json().catch(() => null)) as { data?: { public_key?: string | null } } | null;
  return j?.data?.public_key ?? null;
}

export class PushSetupError extends Error {}

/** Asks permission (must run from a tap), subscribes and registers. */
export async function enablePush(): Promise<void> {
  const key = await pushPublicKey();
  if (!key) throw new PushSetupError("Notifications are not set up on the server yet. Ask your Admin.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new PushSetupError(permission === "denied" ? "Notifications are blocked for this site. Allow them in the browser's site settings." : "Notifications were not allowed.");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const want = urlB64ToBytes(key);
  if (sub) {
    const have = sub.options?.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
    if (!have || have.length !== want.length || have.some((b, i) => b !== want[i])) {
      await sub.unsubscribe(); // server key rotated
      sub = null;
    }
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want as BufferSource });
  await rpc("register_push_token", { p_installation_id: installationId(), p_token: JSON.stringify(sub.toJSON()), p_platform: "web" });
}

export async function pushEnabledHere(): Promise<boolean> {
  try {
    if (!("serviceWorker" in navigator)) return false;
    const reg = await navigator.serviceWorker.getRegistration();
    return !!(await reg?.pushManager.getSubscription());
  } catch {
    return false;
  }
}

/** Stops pushes to this browser (also used on sign-out; best effort). */
export async function disablePush(): Promise<void> {
  try {
    const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
  } catch {
    /* still revoke on the server */
  }
  await rpc("unregister_push_token", { p_installation_id: installationId() });
}

export const sendTest = () => post("/rpc/send_test_notification", {});

/* ─────────── inbox ─────────── */

export interface Notice {
  id: string;
  event_id: string;
  kind: string;
  title: string;
  body: string | null;
  deep_link: string | null;
  read_at: string | null;
  created_at: string;
}

export const CATEGORIES = [
  { id: "requests", label: "Requests and approvals" },
  { id: "attendance", label: "Attendance" },
  { id: "leave", label: "Leave and holidays" },
  { id: "pay", label: "Salary and payslips" },
  { id: "announcements", label: "Announcements" },
] as const;

export function categoryOf(kind: string): string {
  const head = kind.split(".")[0];
  return head === "request" ? "requests" : head === "payslip" || head === "salary" ? "pay" : head === "announcement" ? "announcements" : head === "attendance" || head === "leave" ? head : "account";
}

/** In-app paths only (mirrors the server and the service worker). */
export function safeLink(link: string | null | undefined): string {
  return link && link.startsWith("/") && !link.startsWith("//") && !link.includes("\\") ? link : "/notifications";
}

/** "Just now", "5 min ago", "3 h ago", "Yesterday", or a date. */
export function ago(iso: string, now = new Date()): string {
  const s = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86400) return "Yesterday";
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/** Quiet hours as typed in two time inputs. */
export function quietErrors(start: string, end: string): string | null {
  if (!start && !end) return null;
  if (!start || !end) return "Give both times or neither.";
  if (start === end) return "Start and end must differ.";
  return null;
}
