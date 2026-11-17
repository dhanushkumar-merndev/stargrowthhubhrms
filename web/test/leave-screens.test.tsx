import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HolidayCalendar, LeaveApply, LeaveBalances, leaveYearLabel } from "@/components/screens/leave";
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

const NOW = new Date("2026-11-14T06:00:00Z");
const CL = { id: "cl", code: "CL", name: "Casual Leave", paid: true, active: true, half_day_allowed: true, requires_attachment: false, attachment_class: null, advance_notice_days: null, backdate_days: null, max_consecutive_days: null, version: 1 };
const LOP = { ...CL, id: "lop", code: "LOP", name: "Loss of Pay", paid: false, half_day_allowed: false };
const SICK = { ...CL, id: "sl", code: "SL", name: "Sick Leave", requires_attachment: true };
const balances = (avail = 21) => ({
  leave_year: 2026,
  leave_year_start_month: 1,
  balances: [
    { leave_type: CL, leave_year: 2026, allocated_units: 24, used_units: 0, reserved_units: 3, expired_units: 0, available_units: avail },
    { leave_type: LOP, leave_year: 2026, allocated_units: 0, used_units: 2, reserved_units: 0, expired_units: 0, available_units: null },
  ],
});
const detail = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111", kind: "leave", state: "submitted", version: 2, employee: { id: "e1", code: "EMP001", name: "Asha Rao" },
  target_employee: null, leave_type: { id: "cl", code: "CL", name: "Casual Leave" }, start_date: "2026-11-18", end_date: "2026-11-19",
  target_shift_date: null, units: 3, edited: false, current_revision: 1, events: [],
  revisions: [{ revision_no: 1, created_at: "", payload: { leave_type_id: "cl", start_date: "2026-11-18", end_date: "2026-11-19", start_slot: "PM", end_slot: "FULL", reason: "Family function" } }],
  ...over,
});
const preview = (units = 3) => ok({ valid: true, units, attendance_conflicts: 0, errors: {}, days: [{ day: "2026-11-18", slot: "PM", units: 1 }, { day: "2026-11-19", slot: "FULL", units: 2 }] });

const base = (role: "employee" | "admin" = "employee", extra: Record<string, (b: unknown) => [number, unknown]> = {}) => ({
  "/rpc/get_session_context": () => ok(ctx(role)),
  "/rpc/list_leave_types": () => ok([CL, LOP, SICK]),
  "/rpc/get_leave_balances": () => ok(balances()),
  "/rpc/preview_leave": () => preview(),
  ...extra,
});

async function fillRange(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(await screen.findByLabelText("Leave type"), "cl");
  const from = screen.getByLabelText("From");
  await user.clear(from);
  await user.type(from, "2026-11-18");
  const to = screen.getByLabelText("To");
  await user.clear(to);
  await user.type(to, "2026-11-19");
}

describe("Leave balances", () => {
  it("labels leave years that do not start in January", () => {
    expect(leaveYearLabel(2026)).toBe("2026");
    expect(leaveYearLabel(2026, 4)).toBe("Apr 2026 – Mar 2027");
  });

  it("shows days left, the unpaid chip and the history heading", async () => {
    mockFetch({ ...base(), "/rpc/list_my_requests": () => ok([]) });
    wrap(<LeaveBalances />);
    expect(await screen.findByText("10.5")).toBeInTheDocument();
    expect(screen.getByText(/days left/)).toBeInTheDocument();
    expect(screen.getByText("Unpaid")).toBeInTheDocument();
    expect(screen.getByText("Leave year 2026")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Leave history" })).toBeInTheDocument();
    expect(screen.getByText("No leave requests yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Apply leave" })).toHaveAttribute("href", "/leave/apply");
  });

  it("moves between leave years", async () => {
    const calls = mockFetch({ ...base(), "/rpc/list_my_requests": () => ok([]) });
    wrap(<LeaveBalances />);
    await userEvent.click(await screen.findByRole("button", { name: "Previous leave year" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/rpc/get_leave_balances" && (c.body as { p_leave_year: number }).p_leave_year === 2025)).toBe(true));
  });

  it("empty allocation and history errors are separate", async () => {
    mockFetch({ ...base(), "/rpc/get_leave_balances": () => ok({ leave_year: 2026, leave_year_start_month: 1, balances: [] }), "/rpc/list_my_requests": () => fail(500, "INTERNAL", "Boom") });
    wrap(<LeaveBalances />);
    expect(await screen.findByText("No leave types yet")).toBeInTheDocument();
    expect(await screen.findByText("Boom")).toBeInTheDocument();
  });
});

describe("Leave type setup", () => {
  it.each(["employee", "admin"] as const)("explains an empty type list to %s instead of showing an unusable form", async (role) => {
    mockFetch(base(role, { "/rpc/list_leave_types": () => ok([]) }));
    wrap(<LeaveApply now={NOW} />);
    expect(await screen.findByText("No leave types available")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send request" })).not.toBeInTheDocument();
    if (role === "admin") {
      expect(await screen.findByRole("link", { name: "Manage leave types" })).toHaveAttribute("href", "/admin/leave-policies?tab=types");
    } else {
      expect(screen.getByText(/Ask your Admin to add or activate a leave type/)).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Manage leave types" })).not.toBeInTheDocument();
    }
  });

  it("reloads types after an Admin activates one", async () => {
    let available = false;
    mockFetch(base("employee", { "/rpc/list_leave_types": () => ok(available ? [LOP] : []) }));
    wrap(<LeaveApply now={NOW} />);
    await screen.findByText("No leave types available");
    available = true;
    await userEvent.click(screen.getByRole("button", { name: "Refresh leave types" }));
    await userEvent.selectOptions(await screen.findByLabelText("Leave type"), "lop");
    expect(screen.getByLabelText("Leave type")).toHaveValue("lop");
    expect(screen.getByRole("button", { name: "Send request" })).toBeInTheDocument();
  });
});

describe("Apply for leave", () => {
  it("clearing a date does not crash and hides the slot pickers", async () => {
    const user = userEvent.setup();
    mockFetch(base());
    wrap(<LeaveApply now={NOW} />);
    await fillRange(user);
    expect(screen.getAllByRole("radio").length).toBeGreaterThan(0);
    await user.clear(screen.getByLabelText("From"));
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send request" }));
    expect(screen.getByText("Choose the first day.")).toBeInTheDocument();
  });

  it("validates on the client without saving", async () => {
    const calls = mockFetch(base());
    wrap(<LeaveApply now={NOW} />);
    await userEvent.click(await screen.findByRole("button", { name: "Send request" }));
    expect(screen.getByText("Choose a leave type.")).toBeInTheDocument();
    expect(screen.getByText(/at least 3 characters/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/rpc/save_leave_request")).toBe(false);
  });

  it("previews days and balance, then sends the normalized slots once", async () => {
    const user = userEvent.setup();
    const calls = mockFetch({ ...base(), "/rpc/save_leave_request": () => ok(detail()) });
    wrap(<LeaveApply now={NOW} />);
    await fillRange(user);
    expect(await screen.findByText("1.5 days of leave")).toBeInTheDocument();
    expect(screen.getByText("Balance after: 9 days")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "From second half" }));
    await user.type(screen.getByLabelText("Reason"), "Family function");
    await user.click(screen.getByRole("button", { name: "Send request" }));
    expect(await screen.findByText("Leave request sent")).toBeInTheDocument();
    const saves = calls.filter((c) => c.path === "/rpc/save_leave_request");
    expect(saves).toHaveLength(1);
    expect(saves[0].body).toMatchObject({ p_request_id: null, p_leave_type_id: "cl", p_start_date: "2026-11-18", p_end_date: "2026-11-19", p_start_slot: "PM", p_end_slot: "FULL", p_submit: true, p_expected_version: null, p_reason: "Family function" });
    expect((saves[0].body as { p_operation_key: string }).p_operation_key).toMatch(/[0-9a-f-]{36}/);
    await waitFor(() => expect(calls.filter((c) => c.path === "/rpc/preview_leave").at(-1)!.body).toMatchObject({ p_start_slot: "PM", p_end_slot: "FULL" }));
  });

  it("warns when the balance would go negative and about attendance conflicts", async () => {
    const user = userEvent.setup();
    mockFetch({ ...base(), "/rpc/get_leave_balances": () => ok(balances(2)), "/rpc/preview_leave": () => ok({ valid: true, units: 4, attendance_conflicts: 1, errors: {}, days: [] }) });
    wrap(<LeaveApply now={NOW} />);
    await fillRange(user);
    expect(await screen.findByText("Balance after: -1 day")).toHaveClass("text-error");
    expect(screen.getByText(/already have attendance on 1/)).toBeInTheDocument();
  });

  it("preview errors are listed and block sending", async () => {
    const user = userEvent.setup();
    mockFetch({ ...base(), "/rpc/preview_leave": () => ok({ valid: false, errors: { start_date: "Not enough balance" } }) });
    wrap(<LeaveApply now={NOW} />);
    await fillRange(user);
    expect(await screen.findByText("Not enough balance")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
  });

  it("unpaid full-day-only type hides the slot pickers", async () => {
    const user = userEvent.setup();
    mockFetch(base());
    wrap(<LeaveApply now={NOW} />);
    await user.selectOptions(await screen.findByLabelText("Leave type"), "lop");
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Loss of Pay · unpaid/ })).toBeInTheDocument();
  });

  it("a type needing a document asks for one, uploads it and sends its id", async () => {
    const user = userEvent.setup();
    const calls = mockFetch({ ...base(), "/files": () => ok({ file_version_id: "fv-1" }), "/rpc/save_leave_request": () => ok(detail()) });
    wrap(<LeaveApply now={NOW} />);
    await user.selectOptions(await screen.findByLabelText("Leave type"), "sl");
    const from = screen.getByLabelText("From");
    await user.clear(from);
    await user.type(from, "2026-11-18");
    await user.type(screen.getByLabelText("Reason"), "Fever");
    await user.click(screen.getByRole("button", { name: "Send request" }));
    expect(await screen.findByText("Attach a supporting document.")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/rpc/save_leave_request")).toBe(false);
    await user.upload(screen.getByLabelText("Supporting document"), new File(["%PDF-1.4"], "note.pdf", { type: "application/pdf" }));
    await user.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/rpc/save_leave_request")).toBe(true));
    const up = calls.find((c) => c.path === "/files")!;
    expect(up.query.get("class")).toBe("leave_attachment");
    expect(calls.find((c) => c.path === "/rpc/save_leave_request")!.body).toMatchObject({ p_attachment_file_version_id: "fv-1" });
  });

  it("a medical type uploads as a medical attachment and rejects a wrong file type", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const MED = { ...SICK, id: "ml", code: "ML", name: "Medical Leave", attachment_class: "medical" };
    const calls = mockFetch({ ...base(), "/rpc/list_leave_types": () => ok([CL, MED]), "/files": () => ok({ file_version_id: "fv-2" }), "/rpc/save_leave_request": () => ok(detail()) });
    wrap(<LeaveApply now={NOW} />);
    await user.selectOptions(await screen.findByLabelText("Leave type"), "ml");
    expect(screen.getByText(/Only HR sees it/)).toBeInTheDocument();
    const input = screen.getByLabelText("Supporting document");
    await user.upload(input, new File(["x"], "virus.exe", { type: "application/x-msdownload" }));
    expect(screen.getByText("Use a PDF, JPG or PNG file.")).toBeInTheDocument();
    await user.upload(input, new File(["jpg"], "cert.jpg", { type: "image/jpeg" }));
    const from = screen.getByLabelText("From");
    await user.clear(from);
    await user.type(from, "2026-11-18");
    await user.type(screen.getByLabelText("Reason"), "Surgery");
    await user.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/rpc/save_leave_request")).toBe(true));
    expect(calls.find((c) => c.path === "/files")!.query.get("class")).toBe("medical_attachment");
  });

  it("a failed save does not upload the same file twice on retry", async () => {
    const user = userEvent.setup();
    let n = 0;
    const calls = mockFetch({ ...base(), "/files": () => ok({ file_version_id: "fv-3" }), "/rpc/save_leave_request": () => (++n === 1 ? fail(500, "INTERNAL", "Try again") : ok(detail())) });
    wrap(<LeaveApply now={NOW} />);
    await user.selectOptions(await screen.findByLabelText("Leave type"), "sl");
    const from = screen.getByLabelText("From");
    await user.clear(from);
    await user.type(from, "2026-11-18");
    await user.type(screen.getByLabelText("Reason"), "Fever");
    await user.upload(screen.getByLabelText("Supporting document"), new File(["%PDF"], "n.pdf", { type: "application/pdf" }));
    await user.click(screen.getByRole("button", { name: "Send request" }));
    expect(await screen.findByText("Try again")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(calls.filter((c) => c.path === "/rpc/save_leave_request")).toHaveLength(2));
    expect(calls.filter((c) => c.path === "/files")).toHaveLength(1);
  });

  it("keeps the operation key across a network retry and maps server field errors", async () => {
    const user = userEvent.setup();
    let n = 0;
    const calls = mockFetch({
      ...base(),
      "/rpc/save_leave_request": () => {
        n += 1;
        if (n === 1) throw new TypeError("offline");
        return fail(422, "VALIDATION_FAILED", "Check the form", { reason: "Too vague" });
      },
    });
    wrap(<LeaveApply now={NOW} />);
    await fillRange(user);
    await user.type(screen.getByLabelText("Reason"), "Trip");
    await user.click(screen.getByRole("button", { name: "Send request" }));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Send request" }));
    expect(await screen.findByText("Too vague")).toBeInTheDocument();
    const keys = calls.filter((c) => c.path === "/rpc/save_leave_request").map((c) => (c.body as { p_operation_key: string }).p_operation_key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("Admin leave is approved straight away", async () => {
    const user = userEvent.setup();
    mockFetch({ ...base("admin"), "/rpc/save_leave_request": () => ok(detail({ state: "approved" })) });
    wrap(<LeaveApply now={NOW} />);
    expect(await screen.findByText(/approved straight away. You can revoke/)).toBeInTheDocument();
    await fillRange(user);
    await user.type(screen.getByLabelText("Reason"), "Conference");
    await user.click(screen.getByRole("button", { name: "Send request" }));
    expect(await screen.findByText("Leave approved")).toBeInTheDocument();
  });

  it("edit: prefills, sends the version and explains a stale version", async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      ...base(),
      "/rpc/get_my_request": () => ok(detail({ state: "returned" })),
      "/rpc/save_leave_request": () => fail(409, "STALE_VERSION", "changed"),
    });
    wrap(<LeaveApply editId="11111111-1111-4111-8111-111111111111" now={NOW} />);
    expect(await screen.findByDisplayValue("Family function")).toBeInTheDocument();
    expect(screen.getByText(/returned this request/)).toBeInTheDocument();
    expect(screen.getByLabelText("From")).toHaveValue("2026-11-18");
    expect(screen.getByRole("radio", { name: "From second half" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save and send" }));
    expect(await screen.findByText(/changed since you opened it/)).toBeInTheDocument();
    const save = calls.find((c) => c.path === "/rpc/save_leave_request")!;
    expect(save.body).toMatchObject({ p_request_id: "11111111-1111-4111-8111-111111111111", p_expected_version: 2 });
  });

  it("edit: a request under review cannot be edited", async () => {
    mockFetch({ ...base(), "/rpc/get_my_request": () => ok(detail({ state: "under_review" })) });
    wrap(<LeaveApply editId="11111111-1111-4111-8111-111111111111" now={NOW} />);
    expect(await screen.findByText(/can no longer be edited \(in review\)/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save and send" })).not.toBeInTheDocument();
  });
});

describe("Holiday calendar", () => {
  const h = (id: string, date: string, name: string, over = {}) => ({ id, date, name, state: "published", version: 1, office_id: null, office_name: null, source: null, ...over });
  const year = (holidays: unknown[], over = {}) => ok({ year: 2026, target: 12, can_manage: false, can_set_weekly_off: false, published_count: holidays.length, saturday_off_weeks: 0, holidays, ...over });

  it("splits upcoming and past, marks today and office-only days", async () => {
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/list_holidays": () => year([h("1", "2026-01-26", "Republic Day"), h("2", "2026-11-14", "Founders Day", { office_name: "Chennai" }), h("3", "2026-12-25", "Christmas"), h("4", "2026-12-31", "Draft day", { state: "draft" })]),
    });
    wrap(<HolidayCalendar now={NOW} />);
    const upcoming = await screen.findByRole("region", { name: "Upcoming" });
    expect(upcoming).toHaveTextContent(/Founders Day.*Chennai only.*Today.*Christmas/);
    expect(screen.getByRole("region", { name: "Past" })).toHaveTextContent("Republic Day");
    expect(screen.queryByText("Draft day")).not.toBeInTheDocument();
    expect(screen.queryByText("Manage holidays")).not.toBeInTheDocument();
  });

  it("empty year, manager link and year paging", async () => {
    const calls = mockFetch({ "/rpc/get_session_context": () => ok(ctx("admin")), "/rpc/list_holidays": () => year([], { can_manage: true, saturday_off_weeks: 2 }) });
    wrap(<HolidayCalendar now={NOW} initialYear={2026} />);
    expect(await screen.findByText("No holidays published for this year")).toBeInTheDocument();
    expect(screen.getByText("0 holidays in 2026")).toBeInTheDocument();
    expect(screen.getByText("Saturdays off: 2 per month.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage holidays" })).toHaveAttribute("href", "/admin/leave-policies?tab=holidays");
    await userEvent.click(screen.getByRole("button", { name: "Next year" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/rpc/list_holidays" && (c.body as { p_year: number }).p_year === 2027)).toBe(true));
  });
});
