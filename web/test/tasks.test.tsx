import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskDetail, TaskNew, TasksHome, WorkHome, PersonWork } from "@/components/screens/tasks";
import { actionScopes } from "@/lib/menu";
import { caps } from "@/lib/roles";
import { addDays, dueLabel, minutesLabel, nextStatuses, parseDuration, taskErrors, workErrors, type Task, type WorkLog } from "@/lib/tasks";
import { SessionProvider } from "@/lib/session";
import { ctx, fail, mockFetch, ok } from "./helpers";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: push, back: vi.fn() }), usePathname: () => "/tasks", useSearchParams: () => new URLSearchParams() }));

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

const NOW = new Date("2026-11-16T06:00:00Z"); // 16 Nov in Asia/Kolkata
const TODAY = "2026-11-16";
const me = { id: "m1", code: "EMP0001", name: "Asha Rao" };
const lead = { id: "l1", code: "EMP0002", name: "Lead Person" };
const task = (over: Partial<Task> = {}): Task => ({
  id: "t1", title: "Fix the report", description: "All columns", due_date: "2026-11-18", priority: "high", status: "todo", completed_at: null,
  created_at: "2026-11-15T04:00:00Z", updated_at: "2026-11-15T04:00:00Z", version: 1, assigned_to: me, assigned_by: lead,
  is_mine: true, can_manage: false, overdue: false, logged_minutes: 0, ...over,
});
const log = (over: Partial<WorkLog> = {}): WorkLog => ({
  id: "w1", work_date: TODAY, title: "Customer calls", details: "Called three customers.", minutes: 90, task: null,
  created_at: "2026-11-16T05:00:00Z", updated_at: "2026-11-16T05:00:00Z", version: 1, can_edit: true, ...over,
});
const access = (over = {}) => ({ can_view_team: false, leads_teams: 0, can_assign_others: false, ...over });

describe("task and report rules", () => {
  it("parses durations in hours, h:mm and minutes", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("1.5")).toBe(90);
    expect(parseDuration("2h")).toBe(120);
    expect(parseDuration("1:30")).toBe(90);
    expect(parseDuration("45m")).toBe(45);
    expect(parseDuration("45 min")).toBe(45);
    expect(parseDuration("1:75")).toBeNaN();
    expect(parseDuration("abc")).toBeNaN();
  });
  it("labels minutes", () => {
    expect(minutesLabel(0)).toBe("");
    expect(minutesLabel(null)).toBe("");
    expect(minutesLabel(45)).toBe("45 m");
    expect(minutesLabel(120)).toBe("2 h");
    expect(minutesLabel(90)).toBe("1 h 30 m");
  });
  it("adds days across month and year ends", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("due labels: today, tomorrow, overdue only when open", () => {
    expect(dueLabel({ due_date: null, status: "todo" }, TODAY)).toBe("");
    expect(dueLabel({ due_date: TODAY, status: "todo" }, TODAY)).toBe("Due today");
    expect(dueLabel({ due_date: "2026-11-17", status: "todo" }, TODAY)).toBe("Due tomorrow");
    expect(dueLabel({ due_date: "2026-11-10", status: "in_progress" }, TODAY)).toMatch(/^Overdue/);
    expect(dueLabel({ due_date: "2026-11-10", status: "done" }, TODAY)).toMatch(/^Due /);
  });
  it("task form rules", () => {
    const f = { assigned_to: "", title: " a ", description: "x".repeat(4001), due_date: "2026-11-01", priority: "normal" as const };
    expect(taskErrors(f, TODAY)).toEqual({
      assigned_to: "Choose who does it.", title: "Give the task a title.", description: "Keep it under 4000 characters.", due_date: "The due date cannot be in the past.",
    });
    expect(taskErrors({ ...f, assigned_to: "m1", title: "Ok task", description: "", due_date: "2028-01-01" }, TODAY).due_date).toBe("Pick a date within a year.");
    expect(taskErrors({ ...f, assigned_to: "m1", title: "Ok task", description: "", due_date: "" }, TODAY)).toEqual({});
  });
  it("work form rules: last 7 days, details required, sane durations", () => {
    const ok = { work_date: TODAY, title: "Calls", details: "Called people", duration: "1.5", task_id: "" };
    expect(workErrors(ok, TODAY)).toEqual({});
    expect(workErrors({ ...ok, work_date: "2026-11-08" }, TODAY).work_date).toBeDefined();
    expect(workErrors({ ...ok, work_date: "2026-11-09" }, TODAY).work_date).toBeUndefined();
    expect(workErrors({ ...ok, work_date: "2026-11-17" }, TODAY).work_date).toBeDefined();
    expect(workErrors({ ...ok, details: " " }, TODAY).details).toBeDefined();
    expect(workErrors({ ...ok, duration: "25" }, TODAY).duration).toBeDefined();
    expect(workErrors({ ...ok, duration: "0" }, TODAY).duration).toBeDefined();
    expect(workErrors({ ...ok, duration: "" }, TODAY).duration).toBeUndefined();
  });
  it("assignee status buttons", () => {
    expect(nextStatuses("todo").map((s) => s.to)).toEqual(["in_progress", "done"]);
    expect(nextStatuses("done").map((s) => s.to)).toEqual(["in_progress"]);
    expect(nextStatuses("cancelled")).toEqual([]);
  });
  it("menus: everyone gets tasks and reports; HR/Admin get team reports", () => {
    const labels = (role: "employee" | "hr" | "admin") => actionScopes(caps(ctx(role))).flatMap((s) => s.items.map((i) => i.label));
    expect(labels("employee")).toEqual(expect.arrayContaining(["My tasks", "Daily work report"]));
    expect(labels("employee")).not.toContain("Team work reports");
    expect(labels("hr")).toEqual(expect.arrayContaining(["Team work reports", "Give a task"]));
  });
});

describe("Tasks screen", () => {
  it("an employee sees their tasks only (no Given/Team tabs)", async () => {
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_work_access": () => ok(access()),
      "/rpc/list_tasks": () => ok([task(), task({ id: "t2", title: "Old one", status: "in_progress", due_date: "2026-11-10", overdue: true, priority: "normal" })]),
    });
    wrap(<TasksHome now={NOW} />);
    expect(await screen.findByText("Fix the report")).toBeInTheDocument();
    expect(screen.getByText("High priority")).toBeInTheDocument();
    expect(screen.getByText(/Overdue/)).toBeInTheDocument();
    expect(screen.getAllByText("From Lead Person")).toHaveLength(2);
    expect(screen.queryByRole("tab", { name: "Team" })).not.toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/list_tasks")!.body).toEqual({ p_scope: "mine", p_status: "open" });
  });
  it("a team leader can switch to Team and filter by status", async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_work_access": () => ok(access({ can_view_team: true, leads_teams: 1, can_assign_others: true })),
      "/rpc/list_tasks": (b) => ok((b as { p_scope: string }).p_scope === "team" ? [task({ is_mine: false, assigned_to: { id: "x", code: "EMP9", name: "Ravi" } })] : []),
    });
    wrap(<TasksHome now={NOW} />);
    expect(await screen.findByText("Nothing to do")).toBeInTheDocument();
    await user.click(await screen.findByRole("tab", { name: "Team" }));
    expect(await screen.findByText("For Ravi")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Done" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/rpc/list_tasks" && (c.body as { p_status: string }).p_status === "done")).toBe(true));
    expect(screen.getByRole("tab", { name: "Given by me" })).toBeInTheDocument();
  });
});

describe("New task", () => {
  it("checks the form, then creates and opens the task", async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("hr")),
      "/rpc/list_task_assignees": () => ok([{ id: "hr1", code: "HR0001", name: "Hema", is_me: true }, { ...me, is_me: false }]),
      "/rpc/create_task": () => ok(task({ id: "new1" })),
    });
    wrap(<TaskNew now={NOW} />);
    await user.click(await screen.findByRole("button", { name: "Give task" }));
    expect(screen.getByText("Choose who does it.")).toBeInTheDocument();
    expect(screen.getByText("Give the task a title.")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Who does it"), "m1");
    await user.type(screen.getByLabelText("Task"), "  Prepare the deck  ");
    await user.selectOptions(screen.getByLabelText("Priority"), "high");
    await user.click(screen.getByRole("button", { name: "Give task" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/tasks/new1"));
    expect(calls.find((c) => c.path === "/rpc/create_task")!.body).toEqual({ p_assigned_to: "m1", p_title: "Prepare the deck", p_description: null, p_due_date: null, p_priority: "high" });
  });
  it("shows a refusal from the server", async () => {
    const user = userEvent.setup();
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/list_task_assignees": () => ok([{ ...me, is_me: true }]),
      "/rpc/create_task": () => fail(403, "ACCESS_DENIED", "You cannot give tasks to this person."),
    });
    wrap(<TaskNew now={NOW} />);
    await user.type(await screen.findByLabelText("Task"), "My to-do");
    await user.click(screen.getByRole("button", { name: "Give task" }));
    expect(await screen.findByText("You cannot give tasks to this person.")).toBeInTheDocument();
  });
});

describe("Task detail", () => {
  it("the assignee moves it along with the current version", async () => {
    const user = userEvent.setup();
    let t = task();
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_task": () => ok({ ...t, logs: [log({ task: { id: "t1", title: "Fix the report" } })] }),
      "/rpc/update_task": () => {
        t = { ...t, status: "in_progress", version: 2 };
        return ok(t);
      },
    });
    wrap(<TaskDetail id="t1" now={NOW} />);
    expect(await screen.findByText("Customer calls")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit task" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("Marked as in progress.")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/update_task")!.body).toEqual({ p_task_id: "t1", p_patch: { status: "in_progress" }, p_expected_version: 1 });
    expect(await screen.findByRole("button", { name: "Mark done" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Log work on this" })).toHaveAttribute("href", "/work?task=t1");
  });
  it("the giver edits and cancels; a stale version is explained", async () => {
    const user = userEvent.setup();
    let n = 0;
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("hr")),
      "/rpc/get_task": () => ok({ ...task({ is_mine: false, can_manage: true }), logs: [] }),
      "/rpc/update_task": () => (++n === 1 ? fail(409, "STALE_VERSION", "changed") : ok(task())),
    });
    wrap(<TaskDetail id="t1" now={NOW} />);
    await user.click(await screen.findByRole("button", { name: "Edit task" }));
    const dlg = screen.getByRole("dialog", { name: "Edit task" });
    await user.clear(within(dlg).getByLabelText("Task"));
    await user.type(within(dlg).getByLabelText("Task"), "Fix the monthly report");
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    expect(await within(dlg).findByText(/changed since you opened it/)).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Task updated.")).toBeInTheDocument();
    expect((calls.filter((c) => c.path === "/rpc/update_task")[1].body as { p_patch: { title: string } }).p_patch.title).toBe("Fix the monthly report");
    await user.click(screen.getByRole("button", { name: "Cancel task" }));
    await user.click(within(screen.getByRole("dialog", { name: "Cancel this task?" })).getByRole("button", { name: "Cancel task" }));
    await waitFor(() => expect(calls.filter((c) => c.path === "/rpc/update_task")).toHaveLength(3));
    expect((calls.filter((c) => c.path === "/rpc/update_task")[2].body as { p_patch: unknown }).p_patch).toEqual({ status: "cancelled" });
  });
  it("not found", async () => {
    mockFetch({ "/rpc/get_session_context": () => ok(ctx("employee")), "/rpc/get_task": () => fail(404, "NOT_FOUND", "Not found.") });
    wrap(<TaskDetail id="t1" now={NOW} />);
    expect(await screen.findByText("Not found.")).toBeInTheDocument();
  });
});

describe("Daily work report", () => {
  it("writes an entry with hours against a task, then edits and removes it", async () => {
    const user = userEvent.setup();
    let rows: WorkLog[] = [];
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_work_access": () => ok(access()),
      "/rpc/list_work_logs": () => ok({ rows }),
      "/rpc/list_tasks": () => ok([task()]),
      "/rpc/save_work_log": (b) => {
        const body = b as { p_id: string | null; p_title: string; p_minutes: number };
        const w = log({ id: body.p_id ?? "w9", title: body.p_title, minutes: body.p_minutes, task: { id: "t1", title: "Fix the report" } });
        rows = [w];
        return ok(w);
      },
      "/rpc/delete_work_log": () => {
        rows = [];
        return ok({ deleted: true });
      },
    });
    wrap(<WorkHome now={NOW} />);
    expect(await screen.findByText("Nothing written for this day")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Team reports" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add entry" }));
    const form = screen.getByRole("form", { name: "New entry" });
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(within(form).getByText("Say what you worked on.")).toBeInTheDocument();
    expect(within(form).getByText("Describe the work in detail.")).toBeInTheDocument();
    await user.type(within(form).getByLabelText("What did you work on?"), "Report fixes");
    await user.type(within(form).getByLabelText("Details"), "Fixed totals and the export.");
    await user.type(within(form).getByLabelText("Time spent (optional)"), "1:30");
    await user.selectOptions(within(form).getByLabelText("For a task (optional)"), "t1");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/save_work_log")!.body).toEqual({
      p_id: null, p_work_date: TODAY, p_title: "Report fixes", p_details: "Fixed totals and the export.", p_minutes: 90, p_task_id: "t1", p_expected_version: null,
    });
    expect(await screen.findByText("Task: Fix the report")).toBeInTheDocument();
    expect(screen.getByText("Total 1 h 30 m")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(within(screen.getByRole("dialog", { name: "Remove this entry?" })).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Removed.")).toBeInTheDocument();
  });
  it("cannot go further back than 7 days or into the future", async () => {
    const user = userEvent.setup();
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_work_access": () => ok(access()),
      "/rpc/list_work_logs": () => ok({ rows: [] }),
      "/rpc/list_tasks": () => ok([]),
    });
    wrap(<WorkHome now={NOW} />);
    expect(await screen.findByRole("button", { name: "Next day" })).toBeDisabled();
    for (let i = 0; i < 7; i++) await user.click(screen.getByRole("button", { name: "Previous day" }));
    expect(screen.getByRole("button", { name: "Previous day" })).toBeDisabled();
  });
  it("opening from a task starts an entry for it", async () => {
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_work_access": () => ok(access()),
      "/rpc/list_work_logs": () => ok({ rows: [] }),
      "/rpc/list_tasks": () => ok([task()]),
    });
    wrap(<WorkHome now={NOW} taskId="t1" />);
    const form = await screen.findByRole("form", { name: "New entry" });
    await waitFor(() => expect(within(form).getByLabelText("For a task (optional)")).toHaveValue("t1"));
  });
  it("team reports list who wrote and who did not", async () => {
    const user = userEvent.setup();
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("hr")),
      "/rpc/get_work_access": () => ok(access({ can_view_team: true })),
      "/rpc/list_work_logs": () => ok({ rows: [] }),
      "/rpc/list_tasks": () => ok([]),
      "/rpc/list_team_work": () =>
        ok({
          date: TODAY,
          rows: [
            { employee: { id: "a", code: "EMP0003", name: "Arun", tier: 0 }, total_minutes: 0, entries: [], open_tasks: 2 },
            { employee: { id: "b", code: "EMP0002", name: "Lead Person", tier: 1 }, total_minutes: 60, entries: [log({ title: "Planning", minutes: 60 })], open_tasks: 0 },
          ],
        }),
    });
    wrap(<WorkHome now={NOW} initialTab="team" />);
    expect(await screen.findByText("1 of 2 wrote a report")).toBeInTheDocument();
    expect(screen.getByText("Not written")).toBeInTheDocument();
    expect(screen.getByText(/Team leader/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Arun" })).toHaveAttribute("href", "/work/a");
    await user.type(screen.getByLabelText("Search people"), "lead");
    expect(screen.queryByRole("link", { name: "Arun" })).not.toBeInTheDocument();
  });
  it("one person's last 14 days", async () => {
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("hr")),
      "/rpc/list_work_logs": () => ok({ employee: me, rows: [log(), log({ id: "w2", work_date: "2026-11-14", title: "Docs", minutes: null })] }),
    });
    wrap(<PersonWork id="m1" now={NOW} />);
    expect(await screen.findByText("Customer calls")).toBeInTheDocument();
    expect(screen.getByText("Docs")).toBeInTheDocument();
    expect(screen.getAllByText("Nothing written").length).toBe(12);
  });
  it("refused access is shown", async () => {
    mockFetch({ "/rpc/get_session_context": () => ok(ctx("employee")), "/rpc/list_work_logs": () => fail(403, "ACCESS_DENIED", "Not allowed.") });
    wrap(<PersonWork id="x" now={NOW} />);
    expect(await screen.findByText("Not allowed.")).toBeInTheDocument();
  });
});
