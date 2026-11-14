import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname } from "next/navigation";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gate } from "@/components/gate";
import { NavBar } from "@/components/nav-bar";
import { Action } from "@/components/screens/action";
import { Explore } from "@/components/screens/explore";
import { Home, firstName, greeting } from "@/components/screens/home";
import { LoginForm } from "@/components/screens/login-form";
import { PasswordForm } from "@/components/screens/password-form";
import { Settings, deviceName } from "@/components/screens/settings";
import { SessionProvider } from "@/lib/session";
import type { Phase } from "@/lib/routing";
import { ctx, fail, mockFetch, ok } from "./helpers";
import { nav } from "./setup";

function Screen() {
  return usePathname() === "/login" ? <LoginForm /> : <Settings />;
}

function wrap(ui: React.ReactNode, phase: Phase = "loading") {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SessionProvider initialPhase={phase}>{ui}</SessionProvider>
    </SWRConfig>,
  );
}

beforeEach(() => {
  nav.path = "/home";
  nav.replace.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("Gate", () => {
  it("sends a signed-out visitor to /login", async () => {
    mockFetch({ "/rpc/get_session_context": () => fail(401, "AUTH_REQUIRED") });
    wrap(<Gate>secret page</Gate>);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByText("secret page")).toBeNull();
  });
  it("a first visit shows no 'session expired' banner; an expired session does", async () => {
    mockFetch({ "/rpc/get_session_context": () => fail(401, "AUTH_REQUIRED") });
    nav.path = "/login";
    wrap(
      <Gate>
        <LoginForm />
      </Gate>,
    );
    await screen.findByRole("button", { name: "Sign in" });
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("forces a temporary password holder to /password-change", async () => {
    mockFetch({ "/rpc/get_session_context": () => ok(ctx("employee", { must_change_password: true })) });
    wrap(<Gate>home</Gate>);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/password-change"));
  });
  it("a credential hold is treated like a required change", async () => {
    mockFetch({ "/rpc/get_session_context": () => ok(ctx("employee", { credential_hold: true })) });
    wrap(<Gate>home</Gate>);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/password-change"));
  });
  it("renders the page for a ready session", async () => {
    mockFetch({ "/rpc/get_session_context": () => ok(ctx("employee")) });
    wrap(<Gate>home content</Gate>);
    expect(await screen.findByText("home content")).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled();
  });
  it("offers a retry when the API is unreachable, and recovers", async () => {
    let down = true;
    mockFetch({ "/rpc/get_session_context": () => (down ? [503, ""] : ok(ctx("employee"))) });
    wrap(<Gate>home content</Gate>);
    const retry = await screen.findByRole("button", { name: "Try again" });
    down = false;
    await userEvent.click(retry);
    expect(await screen.findByText("home content")).toBeInTheDocument();
  });
  it("a later 401 from any call signs the user out", async () => {
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/list_my_sessions": () => fail(401, "AUTH_REQUIRED", "Session expired. Please sign in again."),
    });
    nav.path = "/settings";
    const cache = new Map();
    const tree = () => (
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
        <SessionProvider initialPhase="loading">
          <Gate>
            <Screen />
          </Gate>
        </SessionProvider>
      </SWRConfig>
    );
    const view = render(tree());
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/login"));
    nav.path = "/login";
    view.rerender(tree()); // new elements: React re-renders, state is kept
    expect(await screen.findByRole("status")).toHaveTextContent("Session expired. Please sign in again.");
  });
});

describe("LoginForm", () => {
  it("validates locally before calling the server", async () => {
    const calls = mockFetch({});
    wrap(<LoginForm />, "signedOut");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByText("Enter your employee ID")).toBeInTheDocument();
    expect(screen.getByText("Enter your password")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Employee ID"), "a b");
    expect(screen.getByText("Use letters, digits or -")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
  it("uppercases the ID, shows the server's generic error and clears the password", async () => {
    const calls = mockFetch({ "/auth/login": () => fail(401, "AUTH_FAILED", "Employee ID or password is incorrect.") });
    wrap(<LoginForm />, "signedOut");
    await userEvent.type(screen.getByLabelText("Employee ID"), "emp001");
    expect(screen.getByLabelText("Employee ID")).toHaveValue("EMP001");
    await userEvent.type(screen.getByLabelText("Password"), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Employee ID or password is incorrect.");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(calls[0].body).toEqual({ employee_code: "EMP001", password: "wrong-password" });
  });
  it("shows rate limiting as-is", async () => {
    mockFetch({ "/auth/login": () => fail(429, "RATE_LIMITED", "Too many attempts. Wait a moment and try again.") });
    wrap(<LoginForm />, "signedOut");
    await userEvent.type(screen.getByLabelText("Employee ID"), "EMP001");
    await userEvent.type(screen.getByLabelText("Password"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many attempts");
  });
  it("signs in and loads the session", async () => {
    const calls = mockFetch({
      "/auth/login": () => ok({ must_change_password: false, credential_hold: false }),
      "/rpc/get_session_context": () => ok(ctx("employee")),
    });
    wrap(<LoginForm />, "signedOut");
    await userEvent.type(screen.getByLabelText("Employee ID"), "EMP001");
    await userEvent.type(screen.getByLabelText("Password"), "right-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(calls.map((c) => c.path)).toEqual(["/auth/login", "/rpc/get_session_context"]));
  });
  it("password can be revealed and hidden", async () => {
    mockFetch({});
    wrap(<LoginForm />, "signedOut");
    const pw = screen.getByLabelText("Password");
    expect(pw).toHaveAttribute("type", "password");
    await userEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(pw).toHaveAttribute("type", "text");
    await userEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(pw).toHaveAttribute("type", "password");
  });
});

describe("PasswordForm", () => {
  async function ready() {
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee", { must_change_password: true })),
      "/auth/password": () => ok({ status: "completed" }),
    });
    wrap(<PasswordForm />);
    await screen.findByText(/temporary password/);
    return calls;
  }
  it("checks policy, mismatch and reuse locally", async () => {
    const calls = await ready();
    await userEvent.type(screen.getByLabelText("Current password"), "Temp-Pass-1234");
    await userEvent.type(screen.getByLabelText("New password"), "emp001-is-my-pass");
    await userEvent.type(screen.getByLabelText("Confirm new password"), "different");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(screen.getByText("Do not include your employee ID in the password.")).toBeInTheDocument();
    expect(screen.getByText("Passwords do not match")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("New password"));
    await userEvent.type(screen.getByLabelText("New password"), "Temp-Pass-1234");
    expect(screen.getByText("Choose a password different from the current one.")).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/auth/password")).toHaveLength(0);
  });
  it("shows the server's 'current password is incorrect' on that field and uses a fresh operation id next time", async () => {
    let n = 0;
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee", { must_change_password: true })),
      "/auth/password": () => (++n === 1 ? fail(422, "VALIDATION_FAILED", "Your current password is incorrect.", { current_password: "Incorrect" }) : ok({ status: "completed" })),
    });
    wrap(<PasswordForm />);
    await screen.findByText(/temporary password/);
    const fill = async (cur: string) => {
      await userEvent.type(screen.getByLabelText("Current password"), cur);
      await userEvent.clear(screen.getByLabelText("New password"));
      await userEvent.type(screen.getByLabelText("New password"), "A-Brand-New-Pass-26");
      await userEvent.clear(screen.getByLabelText("Confirm new password"));
      await userEvent.type(screen.getByLabelText("Confirm new password"), "A-Brand-New-Pass-26");
      await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    };
    await fill("wrong-one");
    expect(await screen.findByText("Your current password is incorrect.")).toBeInTheDocument();
    expect(screen.getByLabelText("Current password")).toHaveValue("");
    await fill("Temp-Pass-1234");
    await screen.findByText(/Password changed/);
    const ops = calls.filter((c) => c.path === "/auth/password").map((c) => (c.body as { operation_id: string }).operation_id);
    expect(ops).toHaveLength(2);
    expect(ops[0]).not.toBe(ops[1]);
    expect(ops.every((o) => /^[0-9a-f-]{36}$/.test(o))).toBe(true);
  });
  it("reuses the operation id when the network dropped (safe retry)", async () => {
    let n = 0;
    const ops: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/rpc/get_session_context")) return new Response(JSON.stringify(ok(ctx("employee", { must_change_password: true }))[1]));
        ops.push(JSON.parse(init.body as string).operation_id);
        if (++n === 1) throw new TypeError("offline");
        return new Response(JSON.stringify(ok({ status: "completed" })[1]));
      }),
    );
    wrap(<PasswordForm />);
    await screen.findByText(/temporary password/);
    await userEvent.type(screen.getByLabelText("Current password"), "Temp-Pass-1234");
    await userEvent.type(screen.getByLabelText("New password"), "A-Brand-New-Pass-26");
    await userEvent.type(screen.getByLabelText("Confirm new password"), "A-Brand-New-Pass-26");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/offline/i);
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    await screen.findByText(/Password changed/);
    expect(ops[0]).toBe(ops[1]);
  });
});

describe("tabs", () => {
  it("nav bar marks the current tab", () => {
    nav.path = "/explore";
    render(<NavBar />);
    expect(screen.getByRole("link", { name: "Explore" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
  });

  it("Explore cards expand one at a time and show their actions", async () => {
    mockFetch({ "/rpc/get_session_context": () => ok(ctx("employee")) });
    wrap(<Explore />);
    await waitFor(() => expect(screen.getAllByRole("button", { expanded: false }).length).toBeGreaterThan(0));
    const leave = screen.getByRole("button", { name: /Leave/ });
    await userEvent.click(leave);
    expect(leave).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "Apply Leave" })).toHaveAttribute("href", "/leave/apply");
    await userEvent.click(screen.getByRole("button", { name: /Salary/ }));
    expect(leave).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "Apply Leave" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Admin/ })).toBeNull();
  });

  it("Action shows HR and Admin groups only to those roles", async () => {
    mockFetch({ "/rpc/get_session_context": () => ok(ctx("hr")) });
    wrap(<Action />);
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["User", "HR"]);
    await userEvent.click(tabs[1]);
    expect(screen.getByRole("link", { name: /Review requests/ })).toHaveAttribute("href", "/approvals");
    expect(screen.queryByRole("link", { name: /Organization/ })).toBeNull();
  });

  it("Home greets by first name and time of day", async () => {
    mockFetch({ "/rpc/get_session_context": () => ok(ctx("employee")) });
    wrap(<Home now={new Date(2026, 10, 14, 9, 0)} />);
    expect(await screen.findByText("Asha")).toBeInTheDocument();
    expect(screen.getByText("Good morning,")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "My profile" })).toHaveTextContent("AR");
    expect(screen.getByRole("link", { name: "Check in / out" })).toHaveAttribute("href", "/punch");
  });
});

describe("greeting / names", () => {
  it.each([
    [0, "Good evening"], [4, "Good evening"], [5, "Good morning"], [11, "Good morning"],
    [12, "Good afternoon"], [16, "Good afternoon"], [17, "Good evening"], [23, "Good evening"],
  ])("%i h -> %s", (h, t) => expect(greeting(h).text).toBe(t));
  it("first name handles spaces and empties", () => {
    expect(firstName("  Asha   Rao ")).toBe("Asha");
    expect(firstName("")).toBe("");
    expect(firstName(undefined)).toBe("");
  });
});

describe("Settings: your devices", () => {
  it("lists sessions, ends one and refreshes", async () => {
    let list = [
      { id: "s1", created_at: "2026-11-01T00:00:00Z", last_seen_at: "2026-11-14T00:00:00Z", user_agent: "Mozilla/5.0 (Linux; Android 14) Chrome/140", current: true },
      { id: "s2", created_at: "2026-11-02T00:00:00Z", last_seen_at: "2026-11-13T00:00:00Z", user_agent: "Mozilla/5.0 (iPhone) Safari/605", current: false },
    ];
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/list_my_sessions": () => ok(list),
      "/rpc/end_my_session": (b) => {
        list = list.filter((s) => s.id !== (b as { p_session_id: string }).p_session_id);
        return ok({ ended: true });
      },
    });
    wrap(<Settings />);
    const items = await screen.findAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText(/This device/)).toBeInTheDocument();
    expect(within(items[0]).queryByRole("button")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Sign out Safari on iPhone" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    expect(calls.find((c) => c.path === "/rpc/end_my_session")?.body).toEqual({ p_session_id: "s2" });
    expect(screen.queryByRole("button", { name: "Sign out all other devices" })).toBeNull();
  });

  it("sign out calls logout and clears the session", async () => {
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/list_my_sessions": () => ok([]),
      "/auth/logout": () => ok({ signed_out: true }),
    });
    nav.path = "/settings";
    wrap(
      <Gate>
        <Settings />
      </Gate>,
    );
    const btn = await screen.findByRole("button", { name: "Sign out" });
    await userEvent.click(btn);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/login"));
    expect(calls.some((c) => c.path === "/auth/logout")).toBe(true);
  });

  it.each([
    [null, "Unknown device"],
    ["Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/140 Safari/537 Edg/140", "Edge on Windows"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14) Firefox/140", "Firefox on Mac"],
    ["Mozilla/5.0 (Linux; Android 14; SM) SamsungBrowser/27 Chrome/130", "Samsung Internet on Android"],
    ["curl/8", "Unknown device"],
  ])("deviceName(%j) = %s", (ua, name) => expect(deviceName(ua)).toBe(name));
});
