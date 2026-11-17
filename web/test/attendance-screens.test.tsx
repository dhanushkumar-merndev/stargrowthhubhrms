import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Attendance } from "@/components/screens/attendance";
import { AttendanceDay } from "@/components/screens/attendance-day";
import { HoursReport } from "@/components/screens/hours-report";
import { Punch } from "@/components/screens/punch";
import { AttendanceRequestForm, CorrectionForm } from "@/components/screens/request-forms";
import { ApiError } from "@/lib/api";
import type { PunchDeps } from "@/lib/punch";
import { SessionProvider } from "@/lib/session";
import { ctx, fail, mockFetch, ok } from "./helpers";

function wrap(ui: React.ReactNode) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SessionProvider>{ui}</SessionProvider>
    </SWRConfig>,
  );
}
afterEach(() => vi.unstubAllGlobals());

const NOW = new Date("2026-11-14T06:00:00Z"); // 11:30 IST

const office = { id: "off1", name: "HQ", radius_m: 50, latitude: 12.9716, longitude: 77.5946, active: true };
const shift = (over: Record<string, unknown> = {}) => ({
  shift_date: "2026-11-14",
  instance_id: "inst1",
  session_id: null,
  timezone: "Asia/Kolkata",
  start_at: "2026-11-14T04:30:00Z",
  end_at: "2026-11-14T13:30:00Z",
  effective_in_at: null,
  office,
  next_action: "IN",
  blocked_reason: null,
  checkin_opens_at: "2026-11-14T04:00:00Z",
  ...over,
});

function punchDeps(over: Partial<PunchDeps> = {}): PunchDeps {
  const now = Date.now();
  return {
    now: () => now,
    operationId: () => "op-1",
    rpId: "localhost",
    locate: vi.fn(async () => ({ latitude: 12.9716, longitude: 77.5946, accuracy: 6, timestamp: now - 500 })),
    rpc: vi.fn(async (name: string) => {
      if (name === "create_punch_challenge") return { challenge_id: "ch1", nonce: "abcdefghijklmnop", server_time: new Date(now).toISOString() };
      if (name === "create_device_challenge") return { challenge_id: "d1", nonce: "n1" };
      return {};
    }) as unknown as PunchDeps["rpc"],
    post: vi.fn(async (path: string) =>
      path === "/punch"
        ? { ok: true, data: { action: "IN", event_id: "ev", server_time: "2026-11-14T04:28:00Z", distance_m: 3, is_late: false, late_seconds: 0, is_early_departure: false, session: {} } }
        : { data: { device_id: "dev9" } },
    ) as unknown as PunchDeps["post"],
    credentials: {
      create: vi.fn(async () => ({ rawId: new ArrayBuffer(4), response: { clientDataJSON: new ArrayBuffer(2), getAuthenticatorData: () => new ArrayBuffer(37) } }) as unknown as Credential),
      get: vi.fn(async () => ({ rawId: new ArrayBuffer(4), response: { clientDataJSON: new ArrayBuffer(2), authenticatorData: new ArrayBuffer(37), signature: new ArrayBuffer(8) } }) as unknown as Credential),
    },
    ...over,
  };
}

// ---------------------------------------------------------------- punch

describe("Punch screen", () => {
  it("says so when there is no shift", async () => {
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_home_summary": () => ok({ shift: null, device: null }),
      "/rpc/get_my_web_device": () => ok(null),
    });
    wrap(<Punch deps={punchDeps()} />);
    expect(await screen.findByText("No shift today")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check in" })).not.toBeInTheDocument();
  });

  it("explains why punching is blocked", async () => {
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_home_summary": () => ok({ shift: shift({ next_action: null, blocked_reason: "on_leave" }), device: null }),
      "/rpc/get_my_web_device": () => ok(null),
    });
    wrap(<Punch deps={punchDeps()} />);
    expect(await screen.findByText("You are on approved leave today.")).toBeInTheDocument();
  });

  it("asks to set up a passkey first, also when only a phone is registered", async () => {
    let device: unknown = { device_id: "a1", platform: "android", credential_id: null, label: "Pixel" };
    const deps = punchDeps();
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_home_summary": () => ok({ shift: shift(), device: { device_id: "a1" } }),
      "/rpc/get_my_web_device": () => ok(device),
    });
    wrap(<Punch deps={deps} />);
    const setup = await screen.findByRole("button", { name: "Set up passkey" });
    device = { device_id: "dev9", platform: "web", credential_id: "AAAAAAAAAAAAAAAAAAAAAA", label: "Chrome" };
    await userEvent.click(setup);
    expect(deps.credentials.create).toHaveBeenCalledOnce();
    expect(await screen.findByRole("button", { name: "Check in" })).toBeInTheDocument();
  });

  it("shows a passkey setup failure and stays on setup", async () => {
    const deps = punchDeps({
      credentials: { create: vi.fn(async () => Promise.reject(Object.assign(new Error(), { name: "NotAllowedError" }))), get: vi.fn() },
    });
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_home_summary": () => ok({ shift: shift(), device: null }),
      "/rpc/get_my_web_device": () => ok(null),
    });
    wrap(<Punch deps={deps} />);
    await userEvent.click(await screen.findByRole("button", { name: "Set up passkey" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Verification was cancelled.");
    expect(screen.getByRole("button", { name: "Set up passkey" })).toBeEnabled();
  });

  it("checks in with the passkey and shows the result", async () => {
    const deps = punchDeps();
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_home_summary": () => ok({ shift: shift(), device: { device_id: "dev9" } }),
      "/rpc/get_my_web_device": () => ok({ device_id: "dev9", platform: "web", credential_id: "AAAAAAAAAAAAAAAAAAAAAA", label: "Chrome" }),
    });
    wrap(<Punch deps={deps} />);
    await userEvent.click(await screen.findByRole("button", { name: "Check my location" }));
    expect(await screen.findByText(/You are inside the office area/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Check in" }));
    const done = await screen.findByRole("status");
    expect(done).toHaveTextContent("Checked in");
    expect(done).toHaveTextContent("9:58 AM");
    const [path, body] = (deps.post as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(path).toBe("/punch");
    expect(body).toMatchObject({ action: "IN", target_id: "inst1", office_id: "off1", device_id: "dev9", employee_id: "e1" });
  });

  it("checks out against the open session and reports lateness", async () => {
    const deps = punchDeps({
      post: vi.fn(async () => ({
        ok: true,
        data: { action: "OUT", event_id: "e", server_time: "2026-11-14T12:00:00Z", distance_m: 2, is_late: true, late_seconds: 900, is_early_departure: true, session: {} },
      })) as unknown as PunchDeps["post"],
    });
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_home_summary": () => ok({ shift: shift({ next_action: "OUT", session_id: "sess1", effective_in_at: "2026-11-14T04:45:00Z" }), device: {} }),
      "/rpc/get_my_web_device": () => ok({ device_id: "dev9", platform: "web", credential_id: null, label: null }),
    });
    wrap(<Punch deps={deps} />);
    expect(await screen.findByText("Checked in at 10:15 AM")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Check out" }));
    expect(await screen.findByText("Late by 15m")).toBeInTheDocument();
    expect(screen.getByText("Left before the shift ended")).toBeInTheDocument();
    expect((deps.post as ReturnType<typeof vi.fn>).mock.calls[0][1].target_id).toBe("sess1");
  });

  it("lets someone on a new browser register again (the old passkey is not here)", async () => {
    const deps = punchDeps({
      credentials: {
        create: vi.fn(async () => ({ rawId: new ArrayBuffer(4), response: { clientDataJSON: new ArrayBuffer(2), getAuthenticatorData: () => new ArrayBuffer(37) } }) as unknown as Credential),
        get: vi.fn(async () => Promise.reject(Object.assign(new Error(), { name: "NotAllowedError" }))),
      },
    });
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_home_summary": () => ok({ shift: shift(), device: {} }),
      "/rpc/get_my_web_device": () => ok({ device_id: "dev9", platform: "web", credential_id: "AAAAAAAAAAAAAAAAAAAAAA", label: "Old laptop" }),
    });
    wrap(<Punch deps={deps} />);
    await userEvent.click(await screen.findByRole("button", { name: "Check in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("cancelled");
    await userEvent.click(screen.getByRole("button", { name: /Set up this device again/ }));
    await waitFor(() => expect(deps.credentials.create).toHaveBeenCalledOnce());
    expect((deps.post as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toBe("/punch/device");
  });

  it("shows the server's reason when a punch is rejected", async () => {
    const deps = punchDeps({
      post: vi.fn(async () => Promise.reject(new ApiError("OUTSIDE_ZONE", "You appear to be outside the office area.", 422))) as unknown as PunchDeps["post"],
    });
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_home_summary": () => ok({ shift: shift(), device: {} }),
      "/rpc/get_my_web_device": () => ok({ device_id: "dev9", platform: "web", credential_id: null, label: null }),
    });
    wrap(<Punch deps={deps} />);
    await userEvent.click(await screen.findByRole("button", { name: "Check in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("outside the office area");
    expect(screen.getByRole("button", { name: "Check in" })).toBeEnabled();
  });

  it("warns when the location looks outside the area (display only)", async () => {
    const deps = punchDeps({ locate: vi.fn(async () => ({ latitude: 12.98, longitude: 77.5946, accuracy: 9, timestamp: Date.now() })) });
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_home_summary": () => ok({ shift: shift(), device: {} }),
      "/rpc/get_my_web_device": () => ok({ device_id: "dev9", platform: "web", credential_id: null, label: null }),
    });
    wrap(<Punch deps={deps} />);
    await userEvent.click(await screen.findByRole("button", { name: "Check my location" }));
    expect(await screen.findByText(/You may be outside the office area/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check in" })).toBeEnabled();
  });

  it("offers a retry when loading fails", async () => {
    let n = 0;
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_home_summary": () => (n++ === 0 ? fail(500, "INTERNAL", "Server trouble.") : ok({ shift: null, device: null })),
      "/rpc/get_my_web_device": () => ok(null),
    });
    wrap(<Punch deps={punchDeps()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No shift today")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- attendance list + day

const row = (date: string, over: Record<string, unknown> = {}) => ({
  shift_date: date, status: "present", effective_source: "gps", is_late: false, timezone: "Asia/Kolkata",
  effective_in_at: `${date}T04:30:00Z`, effective_out_at: `${date}T13:30:00Z`, credited_seconds: 32400, leave_slots: 0, ...over,
});

describe("My attendance", () => {
  it("shows the month card, past days first, upcoming folded, and pages back by month", async () => {
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/list_my_attendance": (b) => {
        const from = (b as { p_from: string }).p_from;
        return ok({
          rows: from === "2026-11-01"
            ? [
                row("2026-11-20", { status: "upcoming", effective_in_at: null, is_required: true, start_at: "2026-11-20T03:30:00Z", end_at: "2026-11-20T12:30:00Z" }),
                row("2026-11-13", { is_late: true, shortfall_seconds: 1800 }),
                row("2026-11-12", { status: "absent", effective_in_at: null, credited_seconds: 0 }),
                row("2026-11-14", { status: "in_progress", effective_out_at: null }),
              ]
            : [],
          totals: { present_days: 1, late_days: 1, absent_days: 1, leave_days: 0, credited_seconds: 32400, required_seconds: 64800, shortfall_seconds: 32400, extra_seconds: 0 },
        });
      },
    });
    wrap(<Attendance now={NOW} />);
    expect(await screen.findByText("Present · late")).toBeInTheDocument();
    const totals = screen.getByLabelText("Month totals");
    expect(totals).toHaveTextContent("Worked this month");
    expect(totals).toHaveTextContent("9h 00m");
    expect(within(totals).getByLabelText("1 Late")).toBeInTheDocument();
    expect(within(totals).getByLabelText("1 In progress")).toBeInTheDocument();
    expect(totals).toHaveTextContent("Today is added to the totals when you check out.");
    const days = screen.getAllByRole("list").find((l) => l.closest("section") === null)!;
    const items = within(days).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Today");
    expect(items[0]).toHaveTextContent("now");
    expect(screen.getByText("-30m")).toBeInTheDocument();
    expect(screen.queryByText("Upcoming")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show 1 upcoming day" }));
    expect(within(screen.getByRole("list", { name: "Upcoming days" })).getByText(/Shift 9:00 AM/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Fix a punch/ })).toHaveAttribute("href", "/corrections/new");
    expect(screen.getByRole("button", { name: "Next month" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(await screen.findByText("No attendance days")).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/rpc/list_my_attendance").at(-1)!.body).toEqual({ p_from: "2026-10-01", p_to: "2026-10-31" });
  });

  it("links each day to its detail and switches to the calendar", async () => {
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/list_my_attendance": () => ok({ rows: [row("2026-11-13")], totals: {} }),
    });
    wrap(<Attendance now={NOW} />);
    const link = await screen.findByRole("link", { name: /Fri 13: Present/ });
    expect(link).toHaveAttribute("href", "/attendance/2026-11-13");
    await userEvent.click(screen.getByRole("button", { name: "Show calendar" }));
    expect(screen.getByRole("link", { name: "13, Present" })).toHaveAttribute("href", "/attendance/2026-11-13");
    expect(screen.getByLabelText("12, No schedule")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show list" })).toBeInTheDocument();
  });

  it("filters to days that need a fix", async () => {
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/list_my_attendance": () => ok({ rows: [row("2026-11-13"), row("2026-11-12", { status: "needs_correction", effective_out_at: null })], totals: {} }),
    });
    wrap(<Attendance now={NOW} filter="needs_correction" />);
    expect(await screen.findByRole("link", { name: /Fix check-out for/ })).toHaveAttribute("href", "/corrections/new?date=2026-11-12&fix=out");
    expect(screen.queryByRole("link", { name: /Fri 13: Present/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove filter" }));
    expect(await screen.findByRole("link", { name: /Fri 13: Present/ })).toBeInTheDocument();
  });
});

describe("Attendance day", () => {
  it("unscheduled days say so", async () => {
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_attendance_day": () => ok({ shift_date: "2026-11-09", scheduled: false }),
    });
    wrap(<AttendanceDay date="2026-11-09" />);
    expect(await screen.findByText("Nothing scheduled")).toBeInTheDocument();
  });

  it("shows punches, corrections, requests and the fix-it shortcuts", async () => {
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_attendance_day": () =>
        ok({
          ...row("2026-11-13", { is_late: true, late_seconds: 1200, required_seconds: 32400, effective_source: "mixed" }),
          scheduled: true,
          own: true,
          start_at: "2026-11-13T04:30:00Z",
          end_at: "2026-11-13T13:30:00Z",
          shift: { name: "General" },
          events: [{ id: "v1", action: "IN", at: "2026-11-13T04:50:00Z", distance_m: 12.4 }],
          adjustments: [{ revision: 1, effective_in_at: "2026-11-13T04:30:00Z", effective_out_at: "2026-11-13T13:30:00Z", reason: "Forgot", approved_by: "HR H" }],
          requests: [{ id: "r1", kind: "correction", state: "approved", submitted_at: "x" }],
        }),
    });
    wrap(<AttendanceDay date="2026-11-13" />);
    expect(await screen.findByText("Check-in · 10:20 AM")).toBeInTheDocument();
    expect(screen.getByText("12 m away")).toBeInTheDocument();
    expect(screen.getByText(/approved by HR H/)).toBeInTheDocument();
    expect(screen.getByText("Late by")).toBeInTheDocument();
    expect(screen.getByText("Corrected")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Request a correction/ })).toHaveAttribute("href", "/corrections/new?date=2026-11-13");
    expect(screen.getByRole("link", { name: /Explain late arrival/ })).toHaveAttribute("href", "/requests/new/late?date=2026-11-13");
    expect(calls.find((c) => c.path === "/rpc/get_attendance_day")!.body).toEqual({ p_employee_id: "e1", p_shift_date: "2026-11-13" });
  });

  it("hides the late-excuse shortcut once excused, and all shortcuts for someone else's day", async () => {
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("hr")),
      "/rpc/get_attendance_day": () => ok({ ...row("2026-11-13", { is_late: true, late_excused: true }), scheduled: true, own: false, events: [] }),
    });
    wrap(<AttendanceDay date="2026-11-13" employeeId="other" />);
    expect(await screen.findByText("No punches recorded.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Request a correction/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Explain late/ })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- forms

describe("Correction form", () => {
  it("validates before sending anything", async () => {
    const calls = mockFetch({ "/rpc/get_session_context": () => ok(ctx("employee")) });
    wrap(<CorrectionForm now={NOW} />);
    await userEvent.click(await screen.findByRole("button", { name: "Send to HR" }));
    expect(screen.getByText("Enter the check-in time.")).toBeInTheDocument();
    expect(screen.getByText(/at least 5 characters/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/rpc/save_correction_request")).toBe(false);
  });

  it("sends instants in the org timezone, keeps the operation id across a network retry", async () => {
    let attempt = 0;
    const calls: { path: string; body: unknown; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const path = url.replace(/^\/api\/v1/, "");
        calls.push({ path, body: JSON.parse(init.body as string), init });
        if (path === "/rpc/get_session_context") return new Response(JSON.stringify(ok(ctx("employee"))[1]));
        attempt += 1;
        if (attempt === 1) throw new TypeError("network down");
        return new Response(JSON.stringify(ok({ id: "req1" })[1]));
      }),
    );
    wrap(<CorrectionForm initialDate="2026-11-13" now={NOW} />);
    await userEvent.type(await screen.findByLabelText("Checked in at"), "22:00");
    await userEvent.type(screen.getByLabelText("Checked out at"), "07:00");
    expect(screen.getByText(/Next day/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Reason"), "Night shift, phone died");
    await userEvent.click(screen.getByRole("button", { name: "Send to HR" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Send to HR" }));
    expect(await screen.findByText("Correction sent")).toBeInTheDocument();
    const saves = calls.filter((c) => c.path === "/rpc/save_correction_request").map((c) => c.body as Record<string, unknown>);
    expect(saves).toHaveLength(2);
    expect(saves[0].p_operation_key).toBe(saves[1].p_operation_key);
    expect(saves[1]).toMatchObject({
      p_shift_date: "2026-11-13",
      p_proposed_in_at: "2026-11-13T16:30:00.000Z",
      p_proposed_out_at: "2026-11-14T01:30:00.000Z",
      p_reason: "Night shift, phone died",
      p_submit: true,
    });
  });

  it("shows server field errors next to the right input and uses a new operation next time", async () => {
    const keys: string[] = [];
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/save_correction_request": (b) => {
        keys.push((b as { p_operation_key: string }).p_operation_key);
        return fail(422, "VALIDATION_FAILED", "Please check the request.", { proposed_in_at: "Must be within the shift day" });
      },
    });
    wrap(<CorrectionForm initialDate="2026-11-13" now={NOW} />);
    await userEvent.type(await screen.findByLabelText("Checked in at"), "09:00");
    await userEvent.type(screen.getByLabelText("Checked out at"), "18:00");
    await userEvent.type(screen.getByLabelText("Reason"), "Forgot to punch");
    await userEvent.click(screen.getByRole("button", { name: "Send to HR" }));
    expect(await screen.findByText("Must be within the shift day")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Send to HR" }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe("WFH and late-excuse requests", () => {
  it("WFH needs an end on or after the start", async () => {
    const calls = mockFetch({ "/rpc/get_session_context": () => ok(ctx("employee")) });
    wrap(<AttendanceRequestForm kind="wfh" initialDate="2026-11-20" now={NOW} />);
    const to = await screen.findByLabelText("To");
    await userEvent.clear(to);
    await userEvent.type(to, "2026-11-19");
    await userEvent.type(screen.getByLabelText("Reason"), "Plumber visit");
    await userEvent.click(screen.getByRole("button", { name: "Send to HR" }));
    expect(screen.getByText(/on or after the start date/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/rpc/save_attendance_request")).toBe(false);
  });

  it("sends a WFH range", async () => {
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/save_attendance_request": () => ok({ id: "r" }),
    });
    wrap(<AttendanceRequestForm kind="wfh" initialDate="2026-11-20" now={NOW} />);
    await userEvent.type(await screen.findByLabelText("Reason"), "Plumber visit");
    await userEvent.click(screen.getByRole("button", { name: "Send to HR" }));
    expect(await screen.findByText("Request sent")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/save_attendance_request")!.body).toMatchObject({
      p_kind: "wfh", p_start_date: "2026-11-20", p_end_date: "2026-11-20", p_submit: true,
    });
  });

  it("a late excuse is for one past day and sends no end date", async () => {
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/save_attendance_request": () => ok({ id: "r" }),
    });
    wrap(<AttendanceRequestForm kind="late_excuse" initialDate="2026-11-15" now={NOW} />);
    await userEvent.type(await screen.findByLabelText("Reason"), "Traffic jam");
    await userEvent.click(screen.getByRole("button", { name: "Send to HR" }));
    expect(screen.getByText(/past or current day/)).toBeInTheDocument();
    const date = screen.getByLabelText("Date");
    await userEvent.clear(date);
    await userEvent.type(date, "2026-11-13");
    await userEvent.click(screen.getByRole("button", { name: "Send to HR" }));
    expect(await screen.findByText("Request sent")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/save_attendance_request")!.body).toMatchObject({
      p_kind: "late_excuse", p_start_date: "2026-11-13", p_end_date: null,
    });
  });
});

// ---------------------------------------------------------------- hours report

const rep = (n: number, total: number) => ({
  rows: Array.from({ length: n }, (_, i) => ({
    employee: { id: `p${i}`, code: `E${i}`, name: `Person ${i}`, status: "active" },
    totals: { present_days: 2, late_days: 1, absent_days: 0, leave_days: 0, credited_seconds: 3600, required_seconds: 7200, shortfall_seconds: 3600 },
  })),
  total,
  totals: { credited_seconds: 3600 * n, required_seconds: 7200 * n },
});

describe("Hours report", () => {
  it("is not available to employees and fetches nothing", async () => {
    const calls = mockFetch({ "/rpc/get_session_context": () => ok(ctx("employee")) });
    wrap(<HoursReport now={NOW} />);
    expect(await screen.findByText("Not available")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/rpc/get_hours_report")).toBe(false);
  });

  it("lists people, pages, expands days and refuses an inverted range", async () => {
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("hr")),
      "/rpc/get_hours_report": (b) => ok(rep((b as { p_offset: number }).p_offset === 0 ? 25 : 5, 30)),
      "/rpc/get_hours_report_days": () => ok({ rows: [row("2026-11-13", { credited_seconds: 3600 })] }),
    });
    wrap(<HoursReport now={NOW} />);
    expect(await screen.findByText("Person 0")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/get_hours_report")!.body).toMatchObject({ p_from: "2026-11-01", p_to: "2026-11-14", p_offset: 0 });
    await userEvent.click(screen.getByRole("button", { name: /Person 0/ }));
    const item = screen.getByRole("button", { name: /Person 0/ }).closest("li")!;
    expect(await within(item).findByText("Fri, 13 Nov")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Page 2 of 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    const from = screen.getByLabelText("From");
    await userEvent.clear(from);
    await userEvent.type(from, "2026-11-20");
    expect(await screen.findByText(/start date must be on or before/)).toBeInTheDocument();
  });
});
