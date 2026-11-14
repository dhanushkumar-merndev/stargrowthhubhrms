import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BellBadge, NotificationSettings, NotificationsScreen } from "@/components/screens/notifications";
import { ago, categoryOf, enablePush, installationId, pushSupport, quietErrors, safeLink, urlB64ToBytes } from "@/lib/push";
import { SessionProvider } from "@/lib/session";
import { ctx, fail, mockFetch, ok } from "./helpers";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }), usePathname: () => "/notifications", useSearchParams: () => new URLSearchParams() }));

function wrap(ui: React.ReactNode) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SessionProvider>{ui}</SessionProvider>
    </SWRConfig>,
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});
const NOW = new Date("2026-11-14T06:00:00Z");
const session = { "/rpc/get_session_context": () => ok(ctx("employee")) };
const n = (i: number, over: Record<string, unknown> = {}) => ({ id: `n${i}`, event_id: `e${i}`, kind: "payslip.published", title: `Title ${i}`, body: `Body ${i}`, deep_link: "/payslips", read_at: null, created_at: new Date(NOW.getTime() - i * 60_000).toISOString(), ...over });

describe("push helpers", () => {
  const env = { hasSW: true, hasPush: true, hasNotification: true, permission: "default" as NotificationPermission, ios: false, standalone: false };
  it("support matrix", () => {
    expect(pushSupport(env)).toBe("ok");
    expect(pushSupport({ ...env, ios: true })).toBe("ios-needs-install");
    expect(pushSupport({ ...env, ios: true, standalone: true })).toBe("ok");
    expect(pushSupport({ ...env, hasPush: false })).toBe("unsupported");
    expect(pushSupport({ ...env, hasSW: false })).toBe("unsupported");
    expect(pushSupport({ ...env, permission: "denied" })).toBe("denied");
  });
  it("base64url key decoding", () => {
    expect([...urlB64ToBytes("AQID")]).toEqual([1, 2, 3]);
    expect([...urlB64ToBytes("-_8")]).toEqual([251, 255]);
    expect(urlB64ToBytes("B" + "A".repeat(86)).length).toBe(65);
  });
  it("installation id is stable and survives broken storage", () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    const a = installationId(store);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(installationId(store)).toBe(a);
    m.set("hrms.installation", "garbage");
    expect(installationId(store)).not.toBe("garbage");
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => undefined };
    expect(installationId(broken)).toMatch(/^[0-9a-f-]{36}$/);
    expect(installationId(null)).toMatch(/^[0-9a-f-]{36}$/);
  });
  it.each([
    ["request.submitted", "requests"],
    ["payslip.published", "pay"],
    ["salary.updated", "pay"],
    ["announcement.published", "announcements"],
    ["attendance.absent", "attendance"],
    ["leave.holiday_reconciled", "leave"],
    ["credentials.reset", "account"],
    ["", "account"],
  ])("categoryOf(%s) = %s", (k, c) => expect(categoryOf(k)).toBe(c));
  it.each([
    ["/approvals/1", "/approvals/1"],
    ["//evil.com", "/notifications"],
    ["https://evil.com", "/notifications"],
    ["/\\evil", "/notifications"],
    [null, "/notifications"],
  ])("safeLink(%s)", (l, out) => expect(safeLink(l)).toBe(out));
  it("relative times", () => {
    expect(ago("2026-11-14T05:59:30Z", NOW)).toBe("Just now");
    expect(ago("2026-11-14T05:55:00Z", NOW)).toBe("5 min ago");
    expect(ago("2026-11-14T03:00:00Z", NOW)).toBe("3 h ago");
    expect(ago("2026-11-13T03:00:00Z", NOW)).toBe("Yesterday");
    expect(ago("2026-11-01T03:00:00Z", NOW)).toMatch(/1 Nov/);
    expect(ago("2026-11-14T07:00:00Z", NOW)).toBe("Just now"); // clock skew
  });
  it("quiet hours", () => {
    expect(quietErrors("", "")).toBeNull();
    expect(quietErrors("22:00", "07:00")).toBeNull();
    expect(quietErrors("22:00", "")).toMatch(/both/);
    expect(quietErrors("", "07:00")).toMatch(/both/);
    expect(quietErrors("22:00", "22:00")).toMatch(/differ/);
  });
});

describe("enablePush", () => {
  let subscribe: ReturnType<typeof vi.fn>;
  let existing: { options: { applicationServerKey: ArrayBuffer | null }; unsubscribe: ReturnType<typeof vi.fn>; toJSON: () => unknown } | null;
  const key = "B" + "A".repeat(86);
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: { p256dh: key, auth: "A".repeat(22) } };
  beforeEach(() => {
    existing = null;
    subscribe = vi.fn(async () => ({ toJSON: () => sub }));
    vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn(async () => "granted") });
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { ready: Promise.resolve({ pushManager: { getSubscription: async () => existing, subscribe } }) } });
  });
  it("subscribes with the server key and registers the subscription", async () => {
    const calls = mockFetch({ "/push/config": () => ok({ public_key: key }), "/rpc/register_push_token": () => ok({ registered: true }) });
    await enablePush();
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    const body = calls.find((c) => c.path === "/rpc/register_push_token")!.body as Record<string, string>;
    expect(body.p_platform).toBe("web");
    expect(JSON.parse(body.p_token)).toEqual(sub);
    expect(body.p_installation_id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("re-subscribes when the server key changed", async () => {
    const unsubscribe = vi.fn(async () => true);
    existing = { options: { applicationServerKey: new Uint8Array(65).fill(9).buffer }, unsubscribe, toJSON: () => sub };
    mockFetch({ "/push/config": () => ok({ public_key: key }), "/rpc/register_push_token": () => ok({}) });
    await enablePush();
    expect(unsubscribe).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalled();
  });
  it("reuses a matching subscription", async () => {
    existing = { options: { applicationServerKey: urlB64ToBytes(key).buffer as ArrayBuffer }, unsubscribe: vi.fn(), toJSON: () => sub };
    mockFetch({ "/push/config": () => ok({ public_key: key }), "/rpc/register_push_token": () => ok({}) });
    await enablePush();
    expect(subscribe).not.toHaveBeenCalled();
  });
  it("explains a server without push and a refused permission", async () => {
    mockFetch({ "/push/config": () => ok({ public_key: null }) });
    await expect(enablePush()).rejects.toThrow(/not set up on the server/);
    vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn(async () => "denied") });
    mockFetch({ "/push/config": () => ok({ public_key: key }) });
    await expect(enablePush()).rejects.toThrow(/blocked/);
    expect(subscribe).not.toHaveBeenCalled();
  });
});

describe("inbox", () => {
  it("shows unread state, opens the link and marks just that one read", async () => {
    const calls = mockFetch({ ...session, "/rpc/list_notifications": () => ok({ unread: 1, rows: [n(1), n(2, { read_at: "2026-11-14T00:00:00Z", deep_link: "//evil" })] }), "/rpc/mark_notifications_read": () => ok({ marked: 1 }) });
    wrap(<NotificationsScreen now={NOW} />);
    expect(await screen.findByText("Title 1")).toBeInTheDocument();
    expect(screen.getByText("(unread)")).toBeInTheDocument();
    expect(screen.getByText("1 min ago")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Title 1"));
    expect(push).toHaveBeenCalledWith("/payslips");
    await waitFor(() => expect(calls.find((c) => c.path === "/rpc/mark_notifications_read")?.body).toEqual({ p_ids: ["n1"] }));
    expect(screen.queryByText("(unread)")).toBeNull();
    await userEvent.click(screen.getByText("Title 2"));
    expect(push).toHaveBeenLastCalledWith("/notifications");
    expect(calls.filter((c) => c.path === "/rpc/mark_notifications_read")).toHaveLength(1);
  });
  it("mark all read and keyset paging", async () => {
    const first = Array.from({ length: 25 }, (_, i) => n(i));
    const calls = mockFetch({
      ...session,
      "/rpc/list_notifications": (b) => ok((b as { p_before_id: string | null }).p_before_id ? { unread: 0, rows: [n(30, { title: "Old one" })] } : { unread: 25, rows: first }),
      "/rpc/mark_notifications_read": () => ok({ marked: 25 }),
    });
    wrap(<NotificationsScreen now={NOW} />);
    await userEvent.click(await screen.findByRole("button", { name: "Load older" }));
    expect(await screen.findByText("Old one")).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/rpc/list_notifications").at(-1)?.body).toMatchObject({ p_before_id: "n24", p_before_created_at: first[24].created_at });
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/rpc/mark_notifications_read")?.body).toEqual({ p_ids: null }));
  });
  it("empty and error states", async () => {
    mockFetch({ ...session, "/rpc/list_notifications": () => ok({ unread: 0, rows: [] }) });
    const { unmount } = wrap(<NotificationsScreen now={NOW} />);
    expect(await screen.findByText("You're all caught up")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark all read" })).toBeNull();
    unmount();
    mockFetch({ ...session, "/rpc/list_notifications": () => fail(500, "INTERNAL") });
    wrap(<NotificationsScreen now={NOW} />);
    expect(await screen.findByText("Could not load notifications.")).toBeInTheDocument();
  });
  it("bell badge caps at 99+ and hides at zero", () => {
    const { rerender, container } = render(<BellBadge count={0} />);
    expect(container.textContent).toBe("");
    rerender(<BellBadge count={7} />);
    expect(screen.getByLabelText("7 unread")).toHaveTextContent("7");
    rerender(<BellBadge count={150} />);
    expect(screen.getByLabelText("150 unread")).toHaveTextContent("99+");
  });
});

describe("notification settings", () => {
  const prefs = { muted: ["announcements"], quiet_start: null, quiet_end: null, timezone: "Asia/Kolkata", devices: 0, categories: [] };
  it("explains iPhone install and blocked permission instead of offering a dead button", async () => {
    mockFetch({ ...session, "/rpc/get_notification_prefs": () => ok(prefs) });
    const { unmount } = wrap(<NotificationSettings support="ios-needs-install" />);
    expect(await screen.findByText(/Add to Home Screen/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn on notifications" })).toBeNull();
    unmount();
    wrap(<NotificationSettings support="denied" />);
    expect(await screen.findByText(/blocked for this site/)).toBeInTheDocument();
  });
  it("saves categories and validates quiet hours", async () => {
    const calls = mockFetch({ ...session, "/rpc/get_notification_prefs": () => ok(prefs), "/rpc/set_notification_prefs": () => ok({ ...prefs, muted: ["announcements", "pay"] }) });
    wrap(<NotificationSettings support="unsupported" />);
    const pay = await screen.findByLabelText("Salary and payslips");
    expect(pay).toBeChecked();
    expect(screen.getByLabelText("Announcements")).not.toBeChecked();
    await userEvent.click(pay);
    await userEvent.type(screen.getByLabelText("From"), "22:00");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findAllByText("Give both times or neither.")).length).toBeGreaterThan(0);
    expect(calls.some((c) => c.path === "/rpc/set_notification_prefs")).toBe(false);
    await userEvent.type(screen.getByLabelText("To"), "07:00");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/rpc/set_notification_prefs")?.body).toEqual({ p_muted: ["announcements", "pay"], p_quiet_start: "22:00", p_quiet_end: "07:00" }));
  });
});
