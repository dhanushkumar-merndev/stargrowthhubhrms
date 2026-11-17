import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevicesConsole, EnrolForm } from "@/components/screens/devices";
import { enrolFailure, enrolStep, openEnrolment } from "@/lib/devices";
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

const settings = { duplicate_window_minutes: 10, auto_checkout_enabled: true, timezone: "Asia/Kolkata", today: "2026-11-14" };
const row = (over: Record<string, unknown> = {}) => ({
  employee: { id: "e7", code: "EMP007", name: "Priya Menon", status: "active" },
  pins: ["7"],
  status: "in_office",
  first_in_at: "2026-11-14T03:45:00Z",
  out_at: null,
  out_source: null,
  device_out_at: null,
  forgot_checkout: false,
  worked_minutes: null,
  scan_count: 2,
  duplicate_count: 1,
  correction: null,
  ...over,
});
const device = (over: Record<string, unknown> = {}) => ({
  id: "d1", serial: "CKJB12", label: "Front door", office: "HQ", office_id: "o1", mode: "http", active: true, has_token: false,
  last_seen_at: new Date().toISOString(), last_punch_received_at: null, firmware: "Ver 8.0", push_version: null,
  clock_drift_seconds: 2, punches_today: 4, rejections_24h: 1, machine_users: 3, commands_enabled: true, open_commands: 0, ...over,
});
const base = (role: "hr" | "admin" | "employee" = "admin") => ({
  "/rpc/get_session_context": () => ok(ctx(role)),
  "/rpc/list_attendance_day": () => ok({ date: "2026-11-14", is_today: true, settings, rows: [row(), row({ employee: { id: "e8", code: "EMP008", name: "Arjun K", status: "active" }, status: "not_in", first_in_at: null, scan_count: 0, duplicate_count: 0, pins: [] })] }),
});

describe("Devices console", () => {
  it("is closed to employees", async () => {
    mockFetch(base("employee"));
    wrap(<DevicesConsole />);
    expect(await screen.findByText("Only HR and Admin can open this")).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("Today: counts, rows, scans and the duplicate note", async () => {
    mockFetch({
      ...base("hr"),
      "/rpc/list_device_punches": () =>
        ok([
          { id: "p2", serial: "CKJB12", device_label: "Front door", pin: "7", employee: null, kind: "duplicate", counted: false, device_time: "", device_local_time: "2026-11-14 09:20:00", received_at: "", verify_mode: 15, has_photo: false },
          { id: "p1", serial: "CKJB12", device_label: "Front door", pin: "7", employee: null, kind: "in", counted: true, device_time: "", device_local_time: "2026-11-14 09:15:00", received_at: "", verify_mode: 1, has_photo: false },
        ]),
    });
    wrap(<DevicesConsole />);
    expect(await screen.findByText("Priya Menon")).toBeInTheDocument();
    expect(screen.getByText("In office: 1")).toBeInTheDocument();
    expect(screen.getByText("Not in yet: 1")).toBeInTheDocument();
    expect(screen.getByText(/In 9:15 AM · Out —/)).toBeInTheDocument();
    expect(screen.getByText("1 repeat scan ignored")).toBeInTheDocument();
    expect(screen.getByText(/Repeat scans within 10 minutes are ignored/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Scans (2)" }));
    const first = await screen.findByText("09:15:00");
    expect(first.closest("li")).toHaveTextContent("IN");
    expect(screen.getByText("09:20:00").closest("li")).toHaveTextContent("DUP");
    // Arjun has no check-in: no fix, no scans
    const arjun = screen.getByText("Arjun K").closest("li")!;
    expect(within(arjun).queryByRole("button", { name: /Fix/ })).not.toBeInTheDocument();
  });

  it("Today: fixing a check-out validates, saves and reports", async () => {
    const calls = mockFetch({ ...base(), "/rpc/correct_attendance_day": () => ok({}) });
    wrap(<DevicesConsole />);
    await userEvent.click(await screen.findByRole("button", { name: "Fix check-out" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save check-out" }));
    expect(within(dialog).getByText("Enter the check-out time (HH:MM).")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/rpc/correct_attendance_day")).toBe(false);
    await userEvent.type(within(dialog).getByLabelText("Actual check-out time"), "18:30");
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Forgot to scan out");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save check-out" }));
    expect(await screen.findByText("Check-out for Priya Menon set to 18:30.")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/correct_attendance_day")!.body).toEqual({
      p_employee_id: "e7", p_date: "2026-11-14", p_out_time: "18:30", p_reason: "Forgot to scan out",
    });
  });

  it("Today: server refusals stay in the dialog", async () => {
    mockFetch({ ...base(), "/rpc/correct_attendance_day": () => fail(422, "VALIDATION_FAILED", "The check-out must be after the check-in.") });
    wrap(<DevicesConsole />);
    await userEvent.click(await screen.findByRole("button", { name: "Fix check-out" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Actual check-out time"), "08:00");
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Typo");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save check-out" }));
    expect(await within(dialog).findByText("The check-out must be after the check-in.")).toBeInTheDocument();
  });

  it("Rules: HR can read but not change; Admin saves", async () => {
    mockFetch(base("hr"));
    const { unmount } = wrap(<DevicesConsole />);
    await userEvent.click(await screen.findByRole("button", { name: "Rules" }));
    expect(screen.getByText("Only an Admin can change these rules.")).toBeInTheDocument();
    expect(screen.getByLabelText("Duplicate window (minutes)")).toBeDisabled();
    unmount();

    const calls = mockFetch({ ...base("admin"), "/rpc/save_attendance_settings": () => ok({}) });
    wrap(<DevicesConsole />);
    await userEvent.click(await screen.findByRole("button", { name: "Rules" }));
    const win = screen.getByLabelText("Duplicate window (minutes)");
    await userEvent.clear(win);
    await userEvent.type(win, "90");
    expect(screen.getByText("Use a whole number of minutes from 1 to 60.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save rules" })).toBeDisabled();
    await userEvent.clear(win);
    await userEvent.type(win, "15");
    await userEvent.click(screen.getByRole("button", { name: "Save rules" }));
    expect(await screen.findByText(/Attendance rules saved/)).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/save_attendance_settings")!.body).toEqual({ p: { duplicate_window_minutes: 15, auto_checkout_enabled: true } });
  });

  it("Live: lists punches with today's filter, toggles unmatched", async () => {
    const calls = mockFetch({
      ...base(),
      "/rpc/list_device_punches": () =>
        ok([{ id: "p1", serial: "CKJB12", device_label: "Front door", pin: "42", employee: null, kind: "in", counted: true, device_time: "", device_local_time: "2026-11-14 09:15:00", received_at: new Date().toISOString(), verify_mode: 15, has_photo: false }]),
    });
    wrap(<DevicesConsole initialTab="live" />);
    expect(await screen.findByText("Unmatched PIN 42")).toBeInTheDocument();
    expect(screen.getByText(/Front door · Face · PIN 42/)).toBeInTheDocument();
    const first = calls.find((c) => c.path === "/rpc/list_device_punches")!.body as { p_filters: Record<string, unknown> };
    expect(first.p_filters).toMatchObject({ limit: 50 });
    expect(first.p_filters.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await userEvent.click(screen.getByRole("button", { name: "Unmatched only" }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/rpc/list_device_punches" && (c.body as { p_filters: { unmatched?: boolean } }).p_filters.unmatched)).toBe(true),
    );
    await userEvent.click(screen.getByRole("button", { name: "Today only" }));
    await waitFor(() => {
      const last = calls.filter((c) => c.path === "/rpc/list_device_punches").at(-1)!.body as { p_filters: Record<string, unknown> };
      expect(last.p_filters.from).toBeUndefined();
    });
  });

  it("Unmatched: suggests a match, links it and unlinks with confirmation", async () => {
    const calls = mockFetch({
      ...base(),
      "/rpc/list_unmatched_device_pins": () =>
        ok([{ serial: "CKJB12", device_label: "Front door", pin: "42", punches: 3, first_local: "2026-11-14 09:00:00", last_local: "2026-11-14 18:00:00", last_punch_id: "p9", with_photo: 0, machine_name: "PRIYA MENON" }]),
      "/rpc/list_device_user_links": () => ok([{ id: "l1", pin: "8", serial: null, device_label: null, employee: { id: "e8", code: "EMP008", name: "Arjun K" }, linked_at: "" }]),
      "/rpc/list_device_link_candidates": () => ok([{ id: "e7", code: "EMP007", name: "Priya Menon" }, { id: "e8", code: "EMP008", name: "Arjun K" }]),
      "/rpc/link_device_user": () => ok({ attached: 3 }),
      "/rpc/unlink_device_user": () => ok({}),
    });
    wrap(<DevicesConsole initialTab="unmatched" />);
    expect(await screen.findByText(/Suggested: Priya Menon/)).toBeInTheDocument();
    expect(screen.getByLabelText("Employee for PIN 42")).toHaveValue("e7");
    await userEvent.click(screen.getByLabelText("This machine only"));
    await userEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(await screen.findByText("PIN 42 linked to Priya Menon. 3 punch(es) attached.")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/link_device_user")!.body).toEqual({ p_pin: "42", p_employee_id: "e7", p_serial: "CKJB12" });

    await userEvent.click(screen.getByRole("button", { name: "Unlink" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Unlink PIN 8 from Arjun K?");
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep" }));
    expect(calls.some((c) => c.path === "/rpc/unlink_device_user")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Unlink" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Unlink" }));
    expect(await screen.findByText(/PIN 8 unlinked/)).toBeInTheDocument();
  });

  it("Unmatched: a suggestion that arrives later fills the picker, but never overrides a choice", async () => {
    let name: string | null = null;
    const pin = () => ok([{ serial: "CKJB12", device_label: "Front door", pin: "42", punches: 1, first_local: "2026-11-14 09:00:00", last_local: "2026-11-14 09:00:00", last_punch_id: "p9", with_photo: 0, machine_name: name }]);
    const calls = mockFetch({
      ...base(),
      "/rpc/list_unmatched_device_pins": pin,
      "/rpc/list_device_user_links": () => ok([]),
      "/rpc/list_device_link_candidates": () => ok([{ id: "e7", code: "EMP007", name: "Priya Menon" }, { id: "e8", code: "EMP008", name: "Arjun K" }]),
      "/rpc/link_device_user": () => ok({ attached: 1 }),
    });
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, focusThrottleInterval: 0 }}>
        <SessionProvider>
          <DevicesConsole initialTab="unmatched" />
        </SessionProvider>
      </SWRConfig>,
    );
    const select = await screen.findByLabelText("Employee for PIN 42");
    expect(select).toHaveValue("");
    name = "PRIYA MENON";
    // a refresh re-reads the group while the same card stays mounted
    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByText(/Suggested: Priya Menon/)).toBeInTheDocument();
    expect(screen.getByLabelText("Employee for PIN 42")).toBe(select);
    expect(screen.getByLabelText("Employee for PIN 42")).toHaveValue("e7");
    await userEvent.selectOptions(screen.getByLabelText("Employee for PIN 42"), "e8");
    expect(screen.getByLabelText("Employee for PIN 42")).toHaveValue("e8");
    await userEvent.click(screen.getByRole("button", { name: "Link" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/rpc/link_device_user")?.body).toMatchObject({ p_employee_id: "e8" }));
  });

  it("Unmatched: nothing waiting", async () => {
    mockFetch({
      ...base(),
      "/rpc/list_unmatched_device_pins": () => ok([]),
      "/rpc/list_device_user_links": () => ok([]),
      "/rpc/list_device_link_candidates": () => ok([]),
    });
    wrap(<DevicesConsole initialTab="unmatched" />);
    expect(await screen.findByText("Nothing waiting")).toBeInTheDocument();
    expect(screen.getByText("No PINs linked yet.")).toBeInTheDocument();
  });

  const machineRoutes = (role: "hr" | "admin") => ({
    ...base(role),
    "/rpc/list_attendance_devices": () => ok([device(), device({ id: "d2", serial: "OLD001", label: "Old gate", active: false })]),
    "/rpc/list_device_ingest_rejections": () => ok([{ id: 1, serial: "NOPE", code: "biometric_discarded", detail: null, created_at: new Date().toISOString() }]),
    "/rpc/list_device_users": () => ok([{ serial: "CKJB12", device_label: "Front door", pin: "1", name: "Boss", is_device_admin: true, last_reported_at: "", linked_to: null }]),
    "/rpc/list_device_commands": () => ok([{ id: 9, serial: "CKJB12", device_label: "Front door", kind: "user_upsert", pin: "7", employee: { id: "e7", code: "EMP007", name: "Priya Menon" }, name: null, status: "queued", attempts: 0, return_code: null, created_at: new Date().toISOString() }]),
    "/rpc/list_offices": () => ok([{ id: "o1", name: "HQ" }]),
  });

  it("Machines: status, commands, roster and refused traffic; HR is read-only", async () => {
    const calls = mockFetch({ ...machineRoutes("hr"), "/rpc/cancel_device_command": () => ok({}) });
    wrap(<DevicesConsole initialTab="machines" />);
    expect(await screen.findByText("Front door")).toBeInTheDocument();
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getByText("Turned off")).toBeInTheDocument();
    expect(screen.getByText("Only an Admin can register or change machines.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Register a machine" })).not.toBeInTheDocument();
    expect(screen.getByText(/never stored/)).toBeInTheDocument();
    expect(screen.getByText(/machine admin/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/rpc/list_offices")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/rpc/cancel_device_command")?.body).toEqual({ p_command_id: 9 }));
  });

  it("Machines: Admin registers a machine with validation and turns commands on", async () => {
    const calls = mockFetch({
      ...machineRoutes("admin"),
      "/rpc/save_attendance_device": () => ok({ id: "d3", serial: "NEW123" }),
      "/rpc/set_device_commands": () => ok({}),
    });
    wrap(<DevicesConsole initialTab="machines" />);
    await userEvent.click(await screen.findByRole("button", { name: "Register a machine" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Register" }));
    expect(within(dialog).getByText(/Serial numbers are 4–40/)).toBeInTheDocument();
    expect(within(dialog).getByText("Give the machine a name.")).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("Serial number"), "new123");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Back door");
    await userEvent.type(within(dialog).getByLabelText("Token"), "short");
    await userEvent.click(within(dialog).getByRole("button", { name: "Register" }));
    expect(within(dialog).getByText(/at least 16 characters/)).toBeInTheDocument();
    await userEvent.clear(within(dialog).getByLabelText("Token"));
    await userEvent.click(within(dialog).getByLabelText(/Allow commands/));
    await userEvent.click(within(dialog).getByRole("button", { name: "Register" }));
    expect(await screen.findByText("NEW123 registered. Point the machine at this server.")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/save_attendance_device")!.body).toEqual({
      p_device: { serial: "NEW123", label: "Back door", office_id: null, mode: "http", active: true },
    });
    expect(calls.find((c) => c.path === "/rpc/set_device_commands")!.body).toEqual({ p_device_id: "d3", p_enabled: true });
  });

  it("Machines: editing keeps the serial and only changes commands when toggled", async () => {
    const calls = mockFetch({ ...machineRoutes("admin"), "/rpc/save_attendance_device": () => ok({ id: "d1", serial: "CKJB12" }) });
    wrap(<DevicesConsole initialTab="machines" />);
    await screen.findByText("Front door");
    await userEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("Serial number")).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Front door saved.")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/save_attendance_device")!.body).toEqual({
      p_device: { id: "d1", label: "Front door", office_id: "o1", mode: "http", active: true },
    });
    expect(calls.some((c) => c.path === "/rpc/set_device_commands")).toBe(false);
  });

  it("Staff PINs: give a PIN, send again, enrol a finger, send everyone", async () => {
    const calls = mockFetch({
      ...base(),
      "/rpc/list_employee_device_status": () =>
        ok([{ employee_id: "e7", machines: [{ serial: "CKJB12", label: "Front door", pin: "7", name: "Priya" }], pending_commands: 1, last_command: { kind: "user_upsert", status: "done", return_code: 0, device_label: "Front door", at: new Date().toISOString() } }]),
      "/rpc/list_device_link_candidates": () => ok([{ id: "e7", code: "EMP007", name: "Priya Menon" }, { id: "e8", code: "EMP008", name: "Arjun K" }]),
      "/rpc/list_attendance_devices": () => ok([device()]),
      "/rpc/assign_device_pin": () => ok({ pin: "8" }),
      "/rpc/sync_employee_devices": () => ok({}),
      "/rpc/enroll_device_fingerprint": () => ok({}),
      "/rpc/sync_all_employee_devices": () => fail(403, "ACCESS_DENIED", "Only an Admin can do this."),
    });
    wrap(<DevicesConsole initialTab="staff" />);
    expect(await screen.findByText(/EMP007 · PIN 7 · on Front door/)).toBeInTheDocument();
    expect(screen.getByText("1 waiting")).toBeInTheDocument();
    expect(screen.getByText(/EMP008 · no PIN yet/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Give a PIN" }));
    expect(await screen.findByText("Arjun K has a PIN and is being sent to the machines.")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/assign_device_pin")!.body).toEqual({ p_employee_id: "e8" });

    await userEvent.click(screen.getByRole("button", { name: "Send again" }));
    expect(await screen.findByText("Priya Menon is being sent to the machines again.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Enrol fingerprint / face" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("never receives or stores it");
    await userEvent.selectOptions(within(dialog).getByLabelText("Finger"), "Left thumb");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Start on the machine" })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: "Start on the machine" }));
    expect(await within(dialog).findByText(/Waiting for Front door to pick it up/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(calls.find((c) => c.path === "/rpc/enroll_device_fingerprint")!.body).toEqual({ p_employee_id: "e7", p_serial: "CKJB12", p_finger: 4 });

    await userEvent.click(screen.getByRole("button", { name: "Send everyone" }));
    expect(await screen.findByText("Only an Admin can do this.")).toBeInTheDocument();
  });

  it("tabs switch sections and update the address", async () => {
    mockFetch({ ...base(), "/rpc/list_device_punches": () => ok([]) });
    wrap(<DevicesConsole />);
    await screen.findByText("Priya Menon");
    await userEvent.click(screen.getByRole("tab", { name: "Live" }));
    expect(screen.getByRole("tab", { name: "Live" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("Waiting for punches…")).toBeInTheDocument();
    expect(window.location.search).toBe("?tab=live");
  });

  it("load errors offer a retry", async () => {
    mockFetch({ ...base(), "/rpc/list_attendance_day": () => fail(503, "UNAVAILABLE", "The service is busy.") });
    wrap(<DevicesConsole />);
    expect(await screen.findByText("The service is busy.")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- enrolment progress


describe("Enrolment progress", () => {
  const dev = { serial: "SN1", label: "Front door", commands_enabled: true, active: true } as never;
  const person = { id: "e3", code: "EMP003", name: "Vinayaka H" } as never;
  const cmd = (status: string, over: Record<string, unknown> = {}) => ({
    id: 21, serial: "SN1", device_label: "Front door", kind: "enroll_face", pin: "3",
    employee: { id: "e3", code: "EMP003", name: "Vinayaka H" }, name: null, status, attempts: 1, return_code: null, created_at: "2026-11-17T10:43:10Z", ...over,
  });

  it("maps command states and machine codes to plain words", () => {
    expect(enrolStep({ status: "queued" })).toBe("waiting");
    expect(enrolStep({ status: "sent" })).toBe("on_machine");
    expect(enrolStep({ status: "done" })).toBe("done");
    expect(enrolStep({ status: "cancelled" })).toBe("expired");
    expect(enrolFailure(-1003)).toMatch(/No scan was captured/);
    expect(openEnrolment([cmd("done") as never, cmd("sent", { id: 22 }) as never], "e3")?.id).toBe(22);
    expect(openEnrolment([cmd("sent", { kind: "user_upsert" }) as never], "e3")).toBeUndefined();
  });

  it("follows the command from sent to the scan screen to saved", async () => {
    let state = "none";
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("admin")),
      "/rpc/enroll_device_face": () => {
        state = "queued";
        return ok({ command_id: 21 });
      },
      "/rpc/list_device_commands": () => ok(state === "none" ? [] : [cmd(state)]),
    });
    const onDone = vi.fn();
    wrap(<EnrolForm person={person} devices={[dev]} onClose={() => {}} onDone={onDone} />);
    await userEvent.click(await screen.findByRole("button", { name: "Face" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Start on the machine" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Start on the machine" }));
    expect(await screen.findByText(/Waiting for Front door to pick it up/)).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/enroll_device_face")!.body).toEqual({ p_employee_id: "e3", p_serial: "SN1" });
    state = "sent";
    expect(await screen.findByText(/showing the scan screen now. Ask Vinayaka H to scan their face/, undefined, { timeout: 4000 })).toBeInTheDocument();
    state = "done";
    expect(await screen.findByText("Vinayaka H's face is saved on Front door.", undefined, { timeout: 4000 })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone).toHaveBeenCalledWith("Vinayaka H's face is saved on Front door.");
  });

  it("shows an open enrolment instead of queuing a duplicate, and explains a timeout", async () => {
    let state = "sent";
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("admin")),
      "/rpc/list_device_commands": () => ok([cmd(state, state === "failed" ? { return_code: -1003 } : {})]),
    });
    wrap(<EnrolForm person={person} devices={[dev]} onClose={() => {}} onDone={() => {}} />);
    expect(await screen.findByText(/showing the scan screen now/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start on the machine" })).toBeNull();
    state = "failed";
    expect(await screen.findByText(/No scan was captured before the machine gave up/, undefined, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith("/rpc/enroll_device"))).toBe(false);
  });
});
