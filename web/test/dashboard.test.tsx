import { act, render, screen, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gate } from "@/components/gate";
import { Home } from "@/components/screens/home";
import { bareFrame } from "@/components/shell";
import { type Dashboard, hoursLabel, pct, shortcutsFor } from "@/lib/dashboard";
import { SessionProvider } from "@/lib/session";
import { ctx, mockFetch, ok } from "./helpers";

let path = "/home";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }), usePathname: () => path, useSearchParams: () => new URLSearchParams() }));

function wrap(ui: React.ReactNode) {
  return render(ui, {
    wrapper: ({ children }) => (
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <SessionProvider>{children}</SessionProvider>
      </SWRConfig>
    ),
  });
}
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}
beforeEach(() => {
  Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
  path = "/home";
});
afterEach(() => vi.unstubAllGlobals());

const week = (mins: (number | null)[]) => mins.map((m, i) => ({ date: `2026-11-${String(10 + i).padStart(2, "0")}`, worked_minutes: m, in: m !== null }));
const dash = (over: Partial<Dashboard> = {}): Dashboard => ({
  date: "2026-11-16",
  has_machines: true,
  me: {
    today: { first_in_at: "2026-11-16T03:35:00Z", out_at: null, out_source: null, worked_minutes: null, outdoor: null },
    month: { days: 10, worked_minutes: 4800, missed_out: 1 },
    outdoor_days: 2,
    week: week([480, 500, null, null, 470, 455, null]),
    tasks: { open: 3, overdue: 1, due_today: 1 },
    report_minutes_today: 0,
    report_entries_today: 0,
    open_requests: 1,
    pending_fixes: 1,
  },
  team: null,
  org: null,
  ...over,
});
const people = { total: 20, punched_in: 14, in_now: 12, outdoor: 2, on_leave: 1, reports: 9 };

describe("dashboard helpers", () => {
  it("percent and hours", () => {
    expect(pct(3, 4)).toBe(75);
    expect(pct(1, 0)).toBe(0);
    expect(hoursLabel(0)).toBe("0 h");
    expect(hoursLabel(90)).toBe("1.5 h");
    expect(hoursLabel(4800)).toBe("80 h");
  });
  it("HR shortcuts include the review pages", () => {
    expect(shortcutsFor({ isHrOrAdmin: true }).map((s) => s.href)).toEqual(expect.arrayContaining(["/approvals", "/attendance/fixes", "/devices"]));
  });
  it("print and password pages stay full-bleed", () => {
    expect(bareFrame("/attendance/print")).toBe(true);
    expect(bareFrame("/password-change")).toBe(true);
    expect(bareFrame("/tasks")).toBe(false);
  });
});

describe("Home dashboard", () => {
  it("an employee sees their day, month, week and work", async () => {
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_dashboard": () => ok(dash()),
    });
    wrap(<Home now={new Date("2026-11-16T05:30:00Z")} />);
    expect(await screen.findByText("Punched in at 9:05 am · 1 h 55 m so far")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Today" })).getByRole("link", { name: "Punch out" })).toHaveAttribute("href", "/attendance/today");
    const month = screen.getByRole("heading", { name: "This month" }).parentElement!;
    expect(within(month).getByText("12")).toBeInTheDocument(); // 10 machine + 2 outdoor
    expect(within(month).getByText("80 h")).toBeInTheDocument();
    expect(screen.getByText("Not written")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Hours worked on each of the last 7 days" })).toBeInTheDocument();
    expect(screen.getAllByText(/no punch$/, { selector: "li" })).toHaveLength(3);
    expect(screen.queryByText("Everyone today")).not.toBeInTheDocument();
    expect(screen.queryByText("My team today")).not.toBeInTheDocument();
    expect(screen.queryByText("Team today")).not.toBeInTheDocument();
    const quick = screen.getByRole("region", { name: "Quick actions" });
    expect(within(quick).getAllByRole("link").map((a) => a.getAttribute("href"))).toContain("/attendance/today");
  });

  it("a team leader sees their team; HR sees everyone and what waits", async () => {
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("hr")),
      "/rpc/get_dashboard": () =>
        ok(
          dash({
            team: { ...people, total: 5, punched_in: 3, outdoor: 0, on_leave: 0, reports: 2, open_tasks: 4, overdue_tasks: 2 },
            org: {
              ...people,
              waiting: { requests: 3, punch_fixes: 2, outdoor_today: 2, machine_people: 0 },
              week: week([1, 1, 1, 1, 1, 1, 1]).map((w, i) => ({ date: w.date, punched_in: 10 + i, outdoor: 1, on_leave: 1 })),
            },
          }),
        ),
    });
    wrap(<Home now={new Date("2026-11-16T05:30:00Z")} />);
    expect(await screen.findByText("Everyone today")).toBeInTheDocument();
    expect(screen.getByText("80%")).toBeInTheDocument(); // (14 + 2) / 20
    const who = screen.getByRole("link", { name: /Team today/ });
    expect(who).toHaveAttribute("href", "/devices");
    expect(within(who).getByRole("img", { name: "16 of 20 teammates have arrived" })).toBeInTheDocument();
    expect(within(who).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["14In", "2Outdoor", "3Not in yet", "1On leave"]);
    expect(screen.getByRole("img", { name: "In 3, Outdoor 0, On leave 0, Not in 2" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Requests to review\s*3/ })).toHaveAttribute("href", "/approvals");
    expect(screen.getByRole("link", { name: /Punch fix requests\s*2/ })).toHaveAttribute("href", "/attendance/fixes");
    expect(screen.getByText("My team today")).toBeInTheDocument();
    expect(screen.getByText("2/5")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Share of people present on each of the last 7 days" })).toBeInTheDocument();
    const used = screen.getByRole("region", { name: "Shortcuts" });
    expect(within(used).getAllByRole("link").map((a) => a.getAttribute("href"))).toContain("/approvals");
  });

  it("an outdoor day and a missing dashboard are handled", async () => {
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_dashboard": () => ok(dash({ me: { ...dash().me, today: { first_in_at: null, out_at: null, out_source: null, worked_minutes: null, outdoor: "counted" } } })),
    });
    wrap(<Home now={new Date("2026-11-16T05:30:00Z")} />);
    expect(await screen.findByText("Outdoor work today. No punch-in needed.")).toBeInTheDocument();
  });

  it("without a machine it follows the phone shift: check in, exceptions, approvals, payslip and holidays", async () => {
    const summary = {
      today: "2026-11-16",
      org: { name: "Acme", timezone: "Asia/Kolkata" },
      shift: { shift_date: "2026-11-16", kind: "workday", is_required: true, start_at: "2026-11-16T04:30:00Z", end_at: "2026-11-16T13:30:00Z", next_action: "IN", blocked_reason: null, session_state: null },
      team: { on_time: 4, late: 1, not_yet_in: 2, out_of_office: 1, total: 8 },
      upcoming_holidays: [{ date: "2026-12-25", name: "Christmas" }, { date: "2027-01-01", name: "New Year" }],
      extras: { admin_tasks: [], latest_payslip: { salary_month: "2026-10-01" } },
      exception_days: 2,
      pending_reviews: 3,
      unassigned_reviews: 1,
    };
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("hr")),
      "/rpc/get_dashboard": () => ok(dash({ has_machines: false })),
      "/rpc/get_home_summary": () => ok(summary),
    });
    wrap(<Home now={new Date("2026-11-16T05:30:00Z")} />);
    const today = await screen.findByRole("region", { name: "Today" });
    expect(await within(today).findByRole("link", { name: "Check in" })).toHaveAttribute("href", "/punch");
    expect(within(today).getByText("Monday")).toBeInTheDocument();
    expect(within(today).getByText("Office shift")).toBeInTheDocument();
    expect(within(today).getByText("16 November 2026")).toBeInTheDocument();
    expect(within(today).getByText("10:00 am–7:00 pm")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /02 Exception days/ })).toHaveAttribute("href", "/attendance?filter=needs_correction");
    expect(screen.getByRole("link", { name: /3 requests waiting for you.*1 need an approver assigned/ })).toHaveAttribute("href", "/approvals");
    const who = screen.getByRole("link", { name: /Team today/ });
    expect(who).toHaveAttribute("href", "/reports/hours");
    expect(within(who).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["4On time", "1Late", "2Not in yet", "1Away"]);
    expect(screen.getByRole("link", { name: /Payslips.*Oct 2026 is ready/ })).toHaveAttribute("href", "/payslips");
    expect(screen.getByRole("link", { name: /Upcoming holidays.*Christmas · 25 Dec · \+1 more/ })).toHaveAttribute("href", "/holidays");
  });
});

describe("sidebar", () => {
  it("signed-in pages get the sidebar with tabs and fixed shortcuts", async () => {
    path = "/tasks";
    mockFetch({ "/rpc/get_session_context": () => ok(ctx("hr")) });
    wrap(<Gate>tasks page</Gate>);
    expect(await screen.findByText("tasks page")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Sidebar" });
    expect(within(nav).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/home");
    expect(within(nav).getByRole("link", { name: "Tasks" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Review requests" })).toBeInTheDocument();
  });
  it("print pages have no sidebar", async () => {
    path = "/attendance/print";
    mockFetch({ "/rpc/get_session_context": () => ok(ctx("hr")) });
    wrap(<Gate>printable</Gate>);
    expect(await screen.findByText("printable")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Sidebar" })).not.toBeInTheDocument();
  });
});

const EMPLOYEE_SHORTCUTS = ["/attendance/today", "/leave/apply", "/tasks", "/work", "/attendance", "/requests", "/payslips", "/holidays"];
const STAFF_SHORTCUTS = ["/attendance/today", "/leave/apply", "/tasks", "/work", "/approvals", "/attendance/fixes", "/employees", "/devices", "/work?tab=team", "/attendance/outdoor", "/attendance", "/requests", "/payslips", "/holidays"];

// Flush the old deferred usage read too, so these tests catch a reorder that
// happens just after the initial render rather than passing on the first frame.
const settled = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const hrefs = (element: HTMLElement) => within(element).getAllByRole("link").map((a) => a.getAttribute("href"));

describe("shortcut positions", () => {
  it.each(["employee", "hr", "admin"] as const)("keeps sidebar links fixed for %s across page changes and reloads", async (role) => {
    window.localStorage.setItem("hrms.usage.v1", JSON.stringify({ "/holidays": 40, "/devices": 30, "/requests": 20 }));
    mockFetch({ "/rpc/get_session_context": () => ok(ctx(role)) });
    const expected = role === "employee" ? EMPLOYEE_SHORTCUTS : STAFF_SHORTCUTS;
    const sidebarLinks = () => screen.getByRole("list", { name: "Shortcuts" });
    const view = wrap(<Gate>current page</Gate>);
    await screen.findByText("current page");
    await settled();
    expect(hrefs(sidebarLinks())).toEqual(expected);

    for (const next of ["/requests", "/holidays", "/tasks", "/home"]) {
      path = next;
      view.rerender(<Gate>current page</Gate>);
      await settled();
      expect(hrefs(sidebarLinks())).toEqual(expected);
      if (next !== "/home") {
        expect(within(sidebarLinks()).getAllByRole("link").find((a) => a.getAttribute("href") === next)).toHaveAttribute("aria-current", "page");
      }
    }

    view.unmount();
    window.localStorage.setItem("hrms.usage.v1", JSON.stringify({ "/payslips": 100 }));
    wrap(<Gate>reloaded page</Gate>);
    await screen.findByText("reloaded page");
    await settled();
    expect(hrefs(sidebarLinks())).toEqual(expected);
  });

  it.each(["employee", "hr", "admin"] as const)("keeps dashboard cards fixed for %s when visit history changes", async (role) => {
    window.localStorage.setItem("hrms.usage.v1", JSON.stringify({ "/holidays": 40, "/devices": 30 }));
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx(role)),
      "/rpc/get_dashboard": () => ok(dash()),
    });
    const expected = role === "employee" ? EMPLOYEE_SHORTCUTS : STAFF_SHORTCUTS;
    const cards = () => within(screen.getByRole("region", { name: "Shortcuts" })).getAllByRole("link").filter((a) => a.getAttribute("href") !== "/action").map((a) => a.getAttribute("href"));
    const view = wrap(<Home now={new Date("2026-11-16T05:30:00Z")} />);
    await screen.findByText("Hello Asha 👋");
    await settled();
    expect(cards()).toEqual(expected);

    view.unmount();
    window.localStorage.setItem("hrms.usage.v1", JSON.stringify({ "/requests": 100, "/payslips": 50 }));
    wrap(<Home now={new Date("2026-11-16T05:30:00Z")} />);
    await screen.findByText("Hello Asha 👋");
    await settled();
    expect(cards()).toEqual(expected);
  });
});
