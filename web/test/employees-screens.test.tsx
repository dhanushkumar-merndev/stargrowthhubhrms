import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmployeeDetail, EmployeeImport, EmployeeNew, EmployeesList, applyRow } from "@/components/screens/employees";
import { attachmentClass } from "@/components/screens/leave";
import { daysToUnits, newEmployeeErrors, parseAmount, provisionPayload, type ImportRow, type NewEmployeeForm } from "@/lib/people";
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
const session = (role: "employee" | "hr" | "admin" = "hr") => ({ "/rpc/get_session_context": () => ok(ctx(role)) });
const structure = {
  departments: [{ id: "d1", name: "Engineering", active: true }],
  teams: [{ id: "t1", name: "Ops", active: true }],
  offices: [{ id: "o1", name: "HQ", active: true }, { id: "o2", name: "Annex", active: true }],
  shifts: [{ id: "s1", name: "General", active: true }, { id: "s0", name: "Retired", active: false }],
};
const row = (over: Record<string, unknown> = {}) => ({
  id: "e2", code: "EMP002", name: "Ravi K", designation: "Clerk", position_label: "member", role: "employee", roles: [], status: "active",
  join_date: "2026-01-01", end_date: null, setup_pending: false, version: 4, business_email: null, business_phone: null, avatar_file_version_id: null,
  department: null, team: { id: "t1", name: "Ops" }, ...over,
});

const form = (over: Partial<NewEmployeeForm> = {}): NewEmployeeForm => ({
  employee_code: "emp 010", full_name: "Meena S", join_date: "2026-11-14", team_id: "t1", office_id: "o1", shift_id: "s1", department_id: "",
  role: "member", designation: "", business_email: "", business_phone: "", device_pin: "", ...over,
});

describe("new employee rules", () => {
  it("accepts a complete form and normalizes the code", () => {
    expect(newEmployeeErrors(form(), false)).toEqual({});
    expect(provisionPayload(form({ designation: " Clerk ", device_pin: " 12 " }))).toEqual({
      fields: { employee_code: "EMP010", full_name: "Meena S", join_date: "2026-11-14", team_id: "t1", office_id: "o1", shift_id: "s1", role: "member" },
      after: { designation: "Clerk" },
      device_pin: "12",
    });
  });
  it.each([
    [{ employee_code: "AB" }, "employee_code"],
    [{ employee_code: "AB_12" }, "employee_code"],
    [{ full_name: " A " }, "full_name"],
    [{ full_name: "x".repeat(201) }, "full_name"],
    [{ join_date: "2026-13-45" }, "join_date"],
    [{ join_date: "" }, "join_date"],
    [{ team_id: "" }, "team_id"],
    [{ office_id: "" }, "office_id"],
    [{ shift_id: "" }, "shift_id"],
    [{ role: "boss" }, "role"],
    [{ business_email: "a@b" }, "business_email"],
    [{ business_phone: "abc" }, "business_phone"],
    [{ device_pin: "12a" }, "device_pin"],
    [{ device_pin: "1234567890" }, "device_pin"],
  ])("rejects %o", (over, key) => {
    expect(newEmployeeErrors(form(over as Partial<NewEmployeeForm>), true)).toHaveProperty(key);
  });
  it("only an Admin may create HR or Admin accounts", () => {
    expect(newEmployeeErrors(form({ role: "hr" }), false).role).toMatch(/Only an Admin/);
    expect(newEmployeeErrors(form({ role: "admin" }), true)).toEqual({});
  });
  it("department is sent only when chosen", () => {
    expect(provisionPayload(form({ department_id: "d1" })).fields.department_id).toBe("d1");
    expect(provisionPayload(form()).fields).not.toHaveProperty("department_id");
  });
});

describe("number helpers", () => {
  it.each([["1", 2], ["0.5", 1], ["-2", -4], ["1.50", 3], ["365", 730]])("daysToUnits(%s) = %s", (s, u) => expect(daysToUnits(s)).toBe(u));
  it.each(["0", "0.0", "0.3", "366", "", "abc", "1e2", "- 1"])("daysToUnits(%s) is null", (s) => expect(daysToUnits(s)).toBeNull());
  it.each([["45000", 45000], ["45,000.50", 45000.5], ["₹ 1,00,000", 100000]])("parseAmount(%s)", (s, n) => expect(parseAmount(s)).toBe(n));
  it.each(["", "-5", "1.234", "abc", "1e5", "1234567890"])("parseAmount(%s) is null", (s) => expect(parseAmount(s)).toBeNull());
  it("leave document class follows the type", () => {
    expect(attachmentClass({ attachment_class: "medical" })).toBe("medical_attachment");
    expect(attachmentClass({ attachment_class: "general" })).toBe("leave_attachment");
    expect(attachmentClass(undefined)).toBe("leave_attachment");
  });
});

describe("Employees list", () => {
  it("HR sees Add and Import, the cap, and can switch to inactive people", async () => {
    const user = userEvent.setup();
    const calls = mockFetch({ ...session("hr"), "/rpc/list_employees": (b) => ok({ rows: (b as { p_status: string }).p_status === "active" ? [row({ setup_pending: true })] : [], total: 1, limit: 25, offset: 0, active_cap: 20, active_count: 2 }) });
    wrap(<EmployeesList />);
    expect(await screen.findByRole("link", { name: /Ravi K/ })).toHaveAttribute("href", "/employees/e2");
    expect(screen.getByText("Setup pending")).toBeInTheDocument();
    expect(screen.getByText("2 of 20 active accounts used.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add" })).toHaveAttribute("href", "/employees/new");
    await user.click(screen.getByRole("tab", { name: "Inactive" }));
    expect(await screen.findByText("No inactive employees")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/rpc/list_employees" && (c.body as { p_status: string }).p_status === "inactive")).toBe(true);
  });

  it("an employee gets no Add link", async () => {
    mockFetch({ ...session("employee"), "/rpc/list_employees": () => fail(403, "ACCESS_DENIED", "You do not have access.") });
    wrap(<EmployeesList />);
    expect(await screen.findByText("You do not have access.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Add" })).not.toBeInTheDocument();
  });
});

describe("Add employee", () => {
  it("HR cannot pick HR/Admin; a single team is chosen; the ID is automatic; the temporary password is shown once", async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, "writeText");
    const calls = mockFetch({
      ...session("hr"),
      "/rpc/list_org_structure": () => ok(structure),
      "/rpc/preview_employee_code": () => ok({ employee_code: "EMP0010" }),
      "/admin/users": () => ok({ employee_id: "n1", employee_code: "EMP0010", temporary_password: "Tmp-9x!k" }),
      "/rpc/get_employee": () => ok({ version: 1 }),
      "/rpc/update_employee": () => ok({}),
    });
    wrap(<EmployeeNew now={NOW} />);
    const role = await screen.findByLabelText("Role");
    expect(within(role).queryByRole("option", { name: "Admin" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Team")).toHaveValue("t1");
    expect(screen.getByLabelText("Office")).toHaveValue("");
    expect(within(screen.getByLabelText("Shift")).queryByRole("option", { name: "Retired" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Employee ID")).not.toBeInTheDocument();
    expect(await screen.findByText("EMP0010")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.queryByText(/Use 3–32 letters/)).not.toBeInTheDocument();
    expect(screen.getByText("Choose an office.")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/admin/users")).toBe(false);
    await user.type(screen.getByLabelText("Full name"), "Meena S");
    await user.selectOptions(screen.getByLabelText("Office"), "o2");
    await user.type(screen.getByLabelText("Designation (optional)"), "Clerk");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByLabelText("Temporary password")).toHaveTextContent("Tmp-9x!k");
    const sent = calls.find((c) => c.path === "/admin/users")!.body as { operation_id: string; fields: Record<string, string> };
    expect(sent.fields.employee_code).toBeUndefined();
    expect(screen.getByText("EMP0010 can now sign in.")).toBeInTheDocument();
    expect(sent.fields).toMatchObject({ team_id: "t1", office_id: "o2", shift_id: "s1", role: "member", join_date: "2026-11-14" });
    expect(sent.operation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls.find((c) => c.path === "/rpc/update_employee")!.body).toEqual({ p_employee_id: "n1", p_patch: { designation: "Clerk" }, p_expected_version: 1 });
    expect(screen.getByRole("link", { name: "Open employee" })).toHaveAttribute("href", "/employees/n1");
    await user.click(screen.getByRole("button", { name: "Copy sign-in details" }));
    expect(copy).toHaveBeenCalledWith(expect.stringContaining(`Sign-in link: ${window.location.origin}/login?employee_id=EMP0010\nUsername (Employee ID): EMP0010\nTemporary password: Tmp-9x!k`));
  });

  it("a server error is shown; the account is not half-made on a details failure", async () => {
    const user = userEvent.setup();
    let n = 0;
    mockFetch({
      ...session("admin"),
      "/rpc/list_org_structure": () => ok({ ...structure, offices: [structure.offices[0]] }),
      "/admin/users": () => (++n === 1 ? fail(409, "CONFLICT", "That employee ID is taken.", { employee_code: "Already used" }) : ok({ employee_id: "n2", temporary_password: "Pw-1" })),
      "/rpc/get_employee": () => ok({ version: 1 }),
      "/rpc/update_employee": () => fail(422, "VALIDATION_FAILED", "Bad email"),
    });
    wrap(<EmployeeNew now={NOW} />);
    await user.type(await screen.findByLabelText("Full name"), "Dup Person");
    await user.type(screen.getByLabelText("Work email (optional)"), "dup@acme.test");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Already used")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText(/account was created, but the work details were not saved/)).toBeInTheDocument();
    expect(screen.getByLabelText("Temporary password")).toHaveTextContent("Pw-1");
  });
});

const detail = (over: Record<string, unknown> = {}) => ({
  ...row(), can_edit: true, can_manage_payroll: true, must_change_password: false, credential_hold: false, provisioning_state: "complete",
  devices: [{ id: "dv1", platform: "android", label: "Pixel 8", registered_at: "2026-10-02T04:00:00Z", last_used_at: null, revoked_at: null, revoke_reason: null }],
  private: { personal_email: null, personal_phone: null, address: null, emergency_contact_name: null, emergency_contact_phone: null, date_of_birth: null, version: 2 },
  offices: [{ from: "2026-01-01", to: null, office: "HQ", office_id: "o1" }],
  shifts: [{ from: "2026-01-01", to: null, shift: "General", shift_id: "s1" }],
  teams: [{ from: "2026-01-01", to: null, team: "Ops", team_id: "t1" }],
  ...over,
});

describe("Employee detail", () => {
  const routes = (extra = {}) => ({ ...session("hr"), "/rpc/get_employee": () => ok(detail()), "/rpc/list_org_structure": () => ok(structure), ...extra });

  it("deactivating needs a reason and sends the version and last day", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(routes({ "/rpc/set_employee_status": () => ok({}) }));
    wrap(<EmployeeDetail id="e2" now={NOW} />);
    await user.click(await screen.findByRole("button", { name: "Deactivate" }));
    const dialog = screen.getByRole("dialog", { name: "Deactivate Ravi K?" });
    await user.click(within(dialog).getByRole("button", { name: "Deactivate" }));
    expect(within(dialog).getByText("Give a reason.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Reason"), "Resigned");
    await user.click(within(dialog).getByRole("button", { name: "Deactivate" }));
    expect(await screen.findByText("Deactivated.")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/set_employee_status")!.body).toEqual({ p_employee_id: "e2", p_status: "inactive", p_end_date: "2026-11-14", p_reason: "Resigned", p_expected_version: 4 });
  });

  it("reset password shows the temporary password; a stale edit is explained", async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, "writeText");
    mockFetch(routes({ "/admin/users/e2/reset-password": () => ok({ employee_id: "e2", temporary_password: "New-77" }), "/rpc/update_employee": () => fail(409, "STALE_VERSION") }));
    wrap(<EmployeeDetail id="e2" now={NOW} />);
    await user.click(await screen.findByRole("button", { name: "Copy sign-in details" }));
    expect(copy).toHaveBeenLastCalledWith(expect.stringContaining("Sign in with your current HRMS password."));
    await user.click(await screen.findByRole("button", { name: "Reset password" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reset password" }));
    expect(await screen.findByLabelText("Temporary password")).toHaveTextContent("New-77");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Copy sign-in details" }));
    expect(copy).toHaveBeenLastCalledWith(expect.stringContaining("Temporary password: New-77"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    await user.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const dialog = screen.getByRole("dialog", { name: "Work details" });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(within(dialog).getByText("Nothing changed.")).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText("Designation"));
    await user.type(within(dialog).getByLabelText("Designation"), "Senior clerk");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText(/changed since you opened it/)).toBeInTheDocument();
  });

  it("team change needs a different team; leave adjust converts days to half-day units", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      routes({
        "/rpc/list_org_structure": () => ok({ ...structure, teams: [...structure.teams, { id: "t2", name: "Sales", active: true }] }),
        "/rpc/set_employee_team": () => ok({}),
        "/rpc/list_leave_types": () => ok([{ id: "cl", name: "Casual Leave" }]),
        "/rpc/adjust_leave_balance": () => ok({}),
      }),
    );
    wrap(<EmployeeDetail id="e2" now={NOW} />);
    await screen.findByText("Assignment");
    await user.click(screen.getAllByRole("button", { name: "Change" })[0]);
    let dialog = screen.getByRole("dialog", { name: "Change team" });
    await user.type(within(dialog).getByLabelText("Reason"), "Reorg");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(within(dialog).getByText("Choose a different team.")).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText("Team"), "t2");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Change saved.")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/set_employee_team")!.body).toEqual({ p_employee_id: "e2", p_team_id: "t2", p_effective_from: "2026-11-14", p_reason: "Reorg" });

    await user.click(screen.getByRole("tab", { name: "More" }));
    await user.click(screen.getByRole("button", { name: "Adjust leave balance" }));
    dialog = screen.getByRole("dialog", { name: "Adjust leave balance" });
    await user.selectOptions(await within(dialog).findByLabelText("Leave type"), "cl");
    await user.type(within(dialog).getByLabelText(/Days/), "0.3");
    await user.type(within(dialog).getByLabelText("Reason"), "Carry forward");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(within(dialog).getByText(/Enter days in halves/)).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText(/Days/));
    await user.type(within(dialog).getByLabelText(/Days/), "-1.5");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/rpc/adjust_leave_balance")?.body).toMatchObject({ p_units: -3, p_leave_year: 2026 }));
  });

  it("schedule change rejects past dates and needs a shift for an extra workday; phones can be removed", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(routes({ "/rpc/save_schedule_exception": () => ok({}), "/rpc/revoke_device": () => ok({}) }));
    wrap(<EmployeeDetail id="e2" now={NOW} />);
    await user.click(await screen.findByRole("tab", { name: "More" }));
    await user.click(screen.getByRole("button", { name: "Extra workday or day off" }));
    const dialog = screen.getByRole("dialog", { name: "Schedule change" });
    await user.type(within(dialog).getByLabelText("Date"), "2026-11-14");
    await user.type(within(dialog).getByLabelText("Reason"), "Audit day");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(within(dialog).getByText("Choose a date after today.")).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText("Date"));
    await user.type(within(dialog).getByLabelText("Date"), "2026-11-15");
    await user.selectOptions(within(dialog).getByLabelText("Change"), "extra_workday");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(within(dialog).getByText(/Choose the shift/)).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText("Shift"), "s1");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Schedule change saved.")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/save_schedule_exception")!.body).toMatchObject({ p_kind: "extra_workday", p_shift_id: "s1", p_work_date: "2026-11-15" });

    await user.click(screen.getByRole("button", { name: "Remove" }));
    const rv = screen.getByRole("dialog", { name: "Remove this phone?" });
    await user.type(within(rv).getByLabelText("Reason"), "Lost phone");
    await user.click(within(rv).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText(/Phone removed/)).toBeInTheDocument();
  });

  it("pay tab: salary change sends the profile version; HR cannot edit their own salary", async () => {
    const user = userEvent.setup();
    const sal = { profile: { monthly_salary: 30000, currency: "INR", effective_from: "2026-01-01", bank_name: null, account_holder: null, account_last4: null, ifsc: null, bank_status: "not_set", bank_approved_at: null, updated_at: null, version: 7 }, bank_request: null, lifetime_paid: 0, paid_months: 0, recent: [], can_edit: true };
    const calls = mockFetch(routes({ "/rpc/get_employee_salary": () => ok(sal), "/rpc/list_employee_files": () => ok({ documents: [], payslips: [], can_upload: true, can_manage_payroll: true, document_count: 0, document_limit: 10, title_max: 50 }), "/rpc/set_employee_salary": () => ok({}) }));
    wrap(<EmployeeDetail id="e2" now={NOW} />);
    await user.click(await screen.findByRole("tab", { name: "Pay" }));
    await user.click(await screen.findByRole("button", { name: "Change" }));
    const dialog = screen.getByRole("dialog", { name: "Monthly salary" });
    const amount = within(dialog).getByLabelText("Monthly salary (₹)");
    await user.clear(amount);
    await user.type(amount, "35,000");
    await user.type(within(dialog).getByLabelText("Reason"), "Appraisal");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/rpc/set_employee_salary")?.body).toEqual({ p_employee_id: "e2", p_fields: { monthly_salary: 35000, effective_from: "2026-11-01" }, p_reason: "Appraisal", p_expected_version: 7 }));
  });

  it("Attendance tab: days, hours, lates and the salary estimate for a month", async () => {
    const user = userEvent.setup();
    const month = {
      month: "2026-11-01", counted_to: "2026-11-14", days_in_month: 30, worked_days: 9, worked_seconds: 9 * 8.5 * 3600, workdays_so_far: 10,
      present_days: 9, late_days: 5, excused_late_days: 1, late_penalty_days: 1, lates_until_next_cut: 3,
      unpaid_with_permission_days: 0, unpaid_without_permission_days: 1, paid_leave_days: 0, medical_leave_days: 0, outside_days: 0, wfh_days: 0,
      cut_days: 2, monthly_salary: 30000, currency: "INR", per_day_amount: 1000, estimated_deduction: 2000, estimated_pay: 28000,
    };
    const calls = mockFetch(routes({ "/rpc/get_month_summary": () => ok(month) }));
    wrap(<EmployeeDetail id="e2" now={NOW} />);
    await user.click(await screen.findByRole("tab", { name: "Attendance" }));
    expect(await screen.findByText("9 of 10 workdays")).toBeInTheDocument();
    expect(screen.getByText("76h 30m")).toBeInTheDocument();
    expect(screen.getByText(/3 more until the next cut/)).toBeInTheDocument();
    expect(screen.getByText("Estimated pay")).toBeInTheDocument();
    expect(screen.getByText("₹28,000")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/get_month_summary")!.body).toEqual({ p_employee_id: "e2", p_month: "2026-11-01" });
    expect(screen.getByRole("button", { name: "Next month" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    await waitFor(() => expect(calls.filter((c) => c.path === "/rpc/get_month_summary").at(-1)!.body).toEqual({ p_employee_id: "e2", p_month: "2026-10-01" }));
  });

  it("Attendance tab without a salary asks for one", async () => {
    const user = userEvent.setup();
    mockFetch(routes({ "/rpc/get_month_summary": () => ok({ month: "2026-11-01", counted_to: "2026-11-14", days_in_month: 30, present_days: 0, late_days: 0, excused_late_days: 0, late_penalty_days: 0, lates_until_next_cut: 4, unpaid_with_permission_days: 0, unpaid_without_permission_days: 0, paid_leave_days: 0, medical_leave_days: 0, outside_days: 0, wfh_days: 0, cut_days: 0, monthly_salary: null }) }));
    wrap(<EmployeeDetail id="e2" now={NOW} />);
    await user.click(await screen.findByRole("tab", { name: "Attendance" }));
    expect(await screen.findByText(/No monthly salary is set/)).toBeInTheDocument();
  });

  it("own record: no reset, deactivate or access change", async () => {
    mockFetch({ ...session("hr"), "/rpc/get_employee": () => ok(detail({ id: "e1" })) });
    wrap(<EmployeeDetail id="e1" now={NOW} />);
    await screen.findByText("Assignment");
    expect(screen.queryByRole("button", { name: "Reset password" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();
  });
});

describe("Import", () => {
  const csv = "Employee ID,Full name,Team,Office,Shift,Join date,Designation,Monthly salary\nEMP002,Ravi K,Ops,HQ,General,,Senior clerk,\nNEW01,Neha P,Ops,HQ,General,01/12/2026,Analyst,50000\nBAD,,,,,,,\n";

  it("plans rows, saves only valid ones and offers the passwords", async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      ...session("admin"),
      "/rpc/list_org_structure": () => ok({ ...structure, offices: [structure.offices[0]] }),
      "/rpc/list_employees": () => ok({ rows: [row()], total: 1, limit: 100, offset: 0 }),
      "/admin/users": () => ok({ employee_id: "n9", temporary_password: "Pw-9" }),
      "/rpc/get_employee": () => ok({ version: 1 }),
      "/rpc/update_employee": () => ok({}),
      "/rpc/get_employee_salary": () => ok({ profile: null, version: 0 }),
      "/rpc/set_employee_salary": () => ok({}),
    });
    wrap(<EmployeeImport />);
    await screen.findByRole("button", { name: "Download template" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Download template" })).toBeEnabled());
    await user.upload(screen.getByLabelText("Spreadsheet"), new File([csv], "staff.csv", { type: "text/csv" }));
    expect(await screen.findByText("1 new · 1 updates · 0 unchanged · 1 to fix")).toBeInTheDocument();
    expect(screen.getByText("Designation: Clerk → Senior clerk")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save 2 rows" }));
    expect(await screen.findByText("2 saved, 0 failed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download passwords" })).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/list_employees")!.body).toMatchObject({ p_status: "all" });
    expect((calls.find((c) => c.path === "/admin/users")!.body as { fields: object }).fields).toMatchObject({ employee_code: "NEW01", join_date: "2026-12-01" });
    expect(calls.find((c) => c.path === "/rpc/set_employee_salary")!.body).toMatchObject({ p_employee_id: "n9", p_fields: { monthly_salary: 50000 }, p_expected_version: 0 });
    expect(calls.filter((c) => c.path === "/rpc/update_employee").map((c) => c.body)).toContainEqual({ p_employee_id: "e2", p_patch: { designation: "Senior clerk" }, p_expected_version: 4 });
  });

  it("an unreadable file shows an error", async () => {
    const user = userEvent.setup();
    mockFetch({ ...session("admin"), "/rpc/list_org_structure": () => ok(structure), "/rpc/list_employees": () => ok({ rows: [], total: 0, limit: 100, offset: 0 }) });
    wrap(<EmployeeImport />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Download template" })).toBeEnabled());
    await user.upload(screen.getByLabelText("Spreadsheet"), new File(["Employee ID\n"], "empty.csv", { type: "text/csv" }));
    expect(await screen.findByText("The sheet has no rows under the header.")).toBeInTheDocument();
  });

  it("applyRow reports a failure instead of throwing", async () => {
    mockFetch({ "/rpc/update_employee": () => fail(409, "STALE_VERSION", "Changed") });
    const r = { rowNumber: 2, values: { code: "EMP002" }, kind: "update", errors: [], notes: [], changes: [], existing: row(), role: null, patch: { designation: "X" }, salary: {} } as unknown as ImportRow;
    expect(await applyRow(r)).toEqual({ row: 2, code: "EMP002", ok: false, message: "Changed" });
  });
});
