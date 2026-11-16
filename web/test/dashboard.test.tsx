import { render, screen, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gate } from "@/components/gate";
import { Home } from "@/components/screens/home";
import { bareFrame } from "@/components/shell";
import { type Dashboard, hoursLabel, pct, readUsage, recordVisit, shortcutsFor, topShortcuts } from "@/lib/dashboard";
import { SessionProvider } from "@/lib/session";
import { ctx, mockFetch, ok } from "./helpers";

let path = "/home";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }), usePathname: () => path, useSearchParams: () => new URLSearchParams() }));

function wrap(ui: React.ReactNode) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SessionProvider>{ui}</SessionProvider>
    </SWRConfig>,
  );
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
  it("counts visits to shortcut pages and orders by use", () => {
    const list = shortcutsFor({ isHrOrAdmin: false });
    expect(topShortcuts(list, readUsage(), 3).map((s) => s.label)).toEqual(["My punch", "Apply leave", "Tasks"]);
    recordVisit("/payslips");
    recordVisit("/payslips");
    recordVisit("/work");
    recordVisit("/work/123"); // sub-pages do not count
    recordVisit("/nowhere");
    expect(readUsage()).toEqual({ "/payslips": 2, "/work": 1 });
    expect(topShortcuts(list, readUsage(), 3).map((s) => s.label)).toEqual(["Payslips", "Daily report", "My punch"]);
  });
  it("broken storage falls back to the default order", () => {
    window.localStorage.setItem("hrms.usage.v1", "{not json");
    expect(readUsage()).toEqual({});
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
    wrap(<Home now={new Date(2026, 10, 16, 11, 0)} />);
    expect(await screen.findByText("Punched in at 9:05 am")).toBeInTheDocument();
    const month = screen.getByRole("heading", { name: "This month" }).parentElement!;
    expect(within(month).getByText("12")).toBeInTheDocument(); // 10 machine + 2 outdoor
    expect(within(month).getByText("80 h")).toBeInTheDocument();
    expect(screen.getByText("Not written")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Hours worked on each of the last 7 days" })).toBeInTheDocument();
    expect(screen.getAllByText(/no punch$/, { selector: "li" })).toHaveLength(3);
    expect(screen.queryByText("Everyone today")).not.toBeInTheDocument();
    expect(screen.queryByText("My team today")).not.toBeInTheDocument();
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
    wrap(<Home now={new Date(2026, 10, 16, 11, 0)} />);
    expect(await screen.findByText("Everyone today")).toBeInTheDocument();
    expect(screen.getByText("80%")).toBeInTheDocument(); // (14 + 2) / 20
    expect(screen.getByRole("img", { name: "In 14, Outdoor 2, On leave 1, Not in 3" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Requests to review\s*3/ })).toHaveAttribute("href", "/approvals");
    expect(screen.getByRole("link", { name: /Punch fix requests\s*2/ })).toHaveAttribute("href", "/attendance/fixes");
    expect(screen.getByText("My team today")).toBeInTheDocument();
    expect(screen.getByText("2/5")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Share of people present on each of the last 7 days" })).toBeInTheDocument();
    const quick = screen.getByRole("region", { name: "Quick actions" });
    expect(within(quick).getAllByRole("link").map((a) => a.getAttribute("href"))).toContain("/approvals");
  });

  it("an outdoor day and a missing dashboard are handled", async () => {
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_dashboard": () => ok(dash({ me: { ...dash().me, today: { first_in_at: null, out_at: null, out_source: null, worked_minutes: null, outdoor: "counted" } } })),
    });
    wrap(<Home now={new Date(2026, 10, 16, 11, 0)} />);
    expect(await screen.findByText("Outdoor work today")).toBeInTheDocument();
  });
});

describe("sidebar", () => {
  it("signed-in pages get the sidebar with tabs and most used pages", async () => {
    path = "/tasks";
    mockFetch({ "/rpc/get_session_context": () => ok(ctx("hr")) });
    wrap(<Gate>tasks page</Gate>);
    expect(await screen.findByText("tasks page")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Sidebar" });
    expect(within(nav).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/home");
    expect(within(nav).getByRole("link", { name: "Tasks" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Review requests" })).toBeInTheDocument();
    expect(readUsage()).toEqual({ "/tasks": 1 });
  });
  it("print pages have no sidebar", async () => {
    path = "/attendance/print";
    mockFetch({ "/rpc/get_session_context": () => ok(ctx("hr")) });
    wrap(<Gate>printable</Gate>);
    expect(await screen.findByText("printable")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Sidebar" })).not.toBeInTheDocument();
  });
});
