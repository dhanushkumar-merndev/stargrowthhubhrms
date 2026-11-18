import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationPrompt, notificationNeed, unblockSteps } from "@/components/notification-prompt";
import { mockFetch, ok } from "./helpers";
import { nav } from "./setup";

const key = "B" + "A".repeat(86);
const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: { p256dh: key, auth: "A".repeat(22) } };
let existing: unknown;
let subscribe: ReturnType<typeof vi.fn>;

/** A browser that supports push, with the given permission. */
function browser(permission: NotificationPermission) {
  vi.stubGlobal("PushManager", function PushManager() {});
  vi.stubGlobal("Notification", { permission, requestPermission: vi.fn(async () => "granted") });
  const reg = { pushManager: { getSubscription: async () => existing, subscribe } };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { ready: Promise.resolve(reg), getRegistration: async () => reg },
  });
}

const server = (publicKey: string | null = key) =>
  mockFetch({ "/push/config": () => ok({ public_key: publicKey }), "/rpc/register_push_token": () => ok({ registered: true }) });

beforeEach(() => {
  existing = null;
  subscribe = vi.fn(async () => ({ toJSON: () => sub }));
  nav.path = "/home";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  sessionStorage.clear();
});

describe("notification prompt", () => {
  it("asks until notifications are on, then goes away", async () => {
    browser("default");
    const calls = server();
    render(<NotificationPrompt />);
    expect(await screen.findByRole("dialog", { name: "Turn on notifications" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Turn on notifications" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(subscribe).toHaveBeenCalled();
    expect(calls.some((c) => c.path === "/rpc/register_push_token")).toBe(true);
  });

  it("'Not now' hides it for this visit only", async () => {
    browser("default");
    server();
    const first = render(<NotificationPrompt />);
    await userEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    first.unmount();
    render(<NotificationPrompt />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    sessionStorage.clear(); // a new visit
    render(<NotificationPrompt />);
    expect(await screen.findByRole("dialog", { name: "Turn on notifications" })).toBeInTheDocument();
  });

  it("explains how to unblock and checks again", async () => {
    browser("denied");
    server();
    render(<NotificationPrompt />);
    expect(await screen.findByRole("dialog", { name: "Notifications are blocked" })).toBeInTheDocument();
    expect(screen.getByText("Set Notifications to Allow.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn on notifications" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText(/still blocked/)).toBeInTheDocument();

    vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn(async () => "granted") });
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("dialog", { name: "Turn on notifications" })).toBeInTheDocument();
  });

  it("stays out of the notification settings page", async () => {
    browser("default");
    const calls = server();
    nav.path = "/settings/notifications";
    render(<NotificationPrompt />);
    await waitFor(() => expect(calls.some((c) => c.path === "/push/config")).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("notificationNeed", () => {
  it("is null when notifications are already on", async () => {
    browser("granted");
    server();
    existing = { toJSON: () => sub };
    expect(await notificationNeed()).toBeNull();
  });

  it("is null when the browser cannot do push, without calling the server", async () => {
    const calls = server();
    expect(await notificationNeed()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("is null when the server has no push keys", async () => {
    browser("default");
    server(null);
    expect(await notificationNeed()).toBeNull();
  });

  it("asks, or explains a block", async () => {
    browser("default");
    server();
    expect(await notificationNeed()).toBe("ask");
    browser("denied");
    expect(await notificationNeed()).toBe("blocked");
  });
});

describe("unblock steps", () => {
  it("fits the device", () => {
    const android = "Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile";
    expect(unblockSteps(android, true)[0]).toMatch(/App info/);
    expect(unblockSteps(android, false)[1]).toMatch(/Permissions/);
    expect(unblockSteps("Mozilla/5.0 (Windows NT 10.0) Chrome/130", false)[1]).toBe("Set Notifications to Allow.");
  });
});
