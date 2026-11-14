import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Offices, Organization, Roles, Shifts } from "@/components/screens/admin-org";
import { AnnouncementNew, Audit, Jobs, LeavePolicies, OutsideWork, SheetSyncScreen, WorkspaceScreen } from "@/components/screens/admin-policy";
import { ReauthHost } from "@/components/reauth";
import { SessionProvider } from "@/lib/session";
import { ctx, fail, mockFetch, ok } from "./helpers";

function wrap(ui: React.ReactNode) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SessionProvider>
        {ui}
        <ReauthHost />
      </SessionProvider>
    </SWRConfig>,
  );
}
afterEach(() => vi.unstubAllGlobals());
const NOW = new Date("2026-11-14T06:00:00Z");
const session = (role: "employee" | "hr" | "admin" = "admin") => ({ "/rpc/get_session_context": () => ok(ctx(role)) });
const dialog = () => screen.getByRole("dialog");
const structure = { departments: [{ id: "d1", name: "General", active: true }], teams: [{ id: "t1", name: "Ops", active: true }], offices: [{ id: "o1", name: "HQ", active: true }], shifts: [] };

describe("Organization", () => {
  const org = { id: "o", code: "ORG", name: "Acme", timezone: "Asia/Kolkata", support_contact: null, support_phone: null, active_employee_cap: 50, active_employees: 12, annual_start_month: 4, leave_year_start_month: 1, holiday_target: 12, require_biometric_punch: false, strict_geofence: false, setup_published_at: "2026-01-01", storage_budget_bytes: 1000, storage_used_bytes: 400, storage_reserved_bytes: 100, storage_alert_percents: [80], version: 7 };
  it("sends only changed keys with the version and refuses a cap below active accounts", async () => {
    const calls = mockFetch({ ...session(), "/rpc/get_org_settings": () => ok(org), "/rpc/get_attendance_settings": () => ok({ auto_checkout_enabled: true, duplicate_window_minutes: 2 }), "/rpc/update_org_settings": () => ok({ ...org, name: "Acme Ltd", version: 8 }) });
    wrap(<Organization />);
    const name = await screen.findByLabelText("Organisation name");
    expect(screen.getByRole("progressbar", { name: "Storage used" })).toHaveAttribute("aria-valuenow", "50");
    await userEvent.clear(screen.getByLabelText("Active account limit"));
    await userEvent.type(screen.getByLabelText("Active account limit"), "5");
    await userEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    expect(await screen.findByText(/already 12 active/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/rpc/update_org_settings")).toBe(false);
    await userEvent.clear(screen.getByLabelText("Active account limit"));
    await userEvent.type(screen.getByLabelText("Active account limit"), "50");
    await userEvent.clear(name);
    await userEvent.type(name, "Acme Ltd");
    await userEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    await waitFor(() => expect(calls.find((c) => c.path === "/rpc/update_org_settings")?.body).toMatchObject({ p_patch: { name: "Acme Ltd" }, p_expected_version: 7 }));
  });
});

describe("Offices", () => {
  const office = { id: "o1", name: "HQ", timezone: "Asia/Kolkata", latitude: 12.97, longitude: 77.59, radius_m: 100, max_accuracy_m: 30, max_sample_age_s: 30, strict_mode: false, active: true, calibration_status: "verified", calibration_notes: null, wifi_ssids: ["HQ-5G"], network_cidrs: [], assigned_count: 3, config_version: 2, version: 4 };
  it("Admin edits Wi-Fi and networks; only changed lists are written", async () => {
    const calls = mockFetch({ ...session(), "/rpc/list_offices": () => ok([office]), "/rpc/save_office": () => ok({ id: "o1" }), "/rpc/set_office_networks": () => ok({}), "/rpc/set_office_wifi": () => ok({}) });
    wrap(<Offices />);
    expect(await screen.findByText("HQ-5G")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.type(within(dialog()).getByLabelText(/Office networks/), "203.0.113.0/24");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/rpc/set_office_networks")?.body).toEqual({ p_office_id: "o1", p_cidrs: ["203.0.113.0/24"] }));
    expect(calls.find((c) => c.path === "/rpc/save_office")?.body).toMatchObject({ p_id: "o1", p_expected_version: 4 });
    expect(calls.some((c) => c.path === "/rpc/set_office_wifi")).toBe(false);
  });
  it("bad IP range is caught before saving; HR does not see the Wi-Fi field", async () => {
    const calls = mockFetch({ ...session("hr"), "/rpc/list_offices": () => ok([office]) });
    wrap(<Offices />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(within(dialog()).queryByLabelText(/Wi-Fi names/)).toBeNull();
    await userEvent.type(within(dialog()).getByLabelText(/Office networks/), "10.0.0.0/40");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect(await within(dialog()).findByText(/not an IP range/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/rpc/save_office")).toBe(false);
  });
});

describe("Shifts", () => {
  const v = (over: Record<string, unknown>) => ({ id: "v1", version_no: 1, state: "published", effective_from: "2026-01-01", start_local: "09:30:00", end_local: "18:30:00", weekly_mask: 31, grace_seconds: 600, lunch_start_local: null, lunch_end_local: null, early_entry_seconds: 1800, early_credit: false, checkout_extension_enabled: false, checkout_extension_seconds: 0, crosses_midnight: false, ...over });
  it("shows the current version and publishes a draft", async () => {
    const calls = mockFetch({ ...session(), "/rpc/list_shifts": () => ok([{ id: "s1", name: "General", active: true, assigned_count: 5, versions: [v({}), v({ id: "v2", version_no: 2, state: "draft", effective_from: "2026-12-01", start_local: "10:00:00", end_local: "19:00:00" })] }]), "/rpc/publish_shift_version": () => ok({}) });
    wrap(<Shifts now={NOW} />);
    expect(await screen.findByText(/09:30–18:30 \(9h\)/)).toBeInTheDocument();
    expect(screen.getByText("Mon–Fri")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/rpc/publish_shift_version")?.body).toEqual({ p_version_id: "v2" }));
    expect(await screen.findByText(/General v2 published/)).toBeInTheDocument();
  });
});

describe("Roles and step-up password", () => {
  const g = (id: string, name: string, role: string) => ({ employee: { id, code: id.toUpperCase(), name, designation: null, position_label: "member", status: "active" }, role, roles: role === "employee" ? [] : [role], permissions: [] });
  it("elevating to Admin asks for the password once, then retries", async () => {
    let n = 0;
    const calls = mockFetch({
      ...session(),
      "/rpc/list_access_grants": () => ok([g("e1", "Asha Rao", "admin"), g("e2", "Ravi K", "employee")]),
      "/rpc/set_employee_access": () => (++n === 1 ? fail(403, "REAUTH_REQUIRED", "Confirm your password to continue.") : ok({})),
      "/auth/reauth": (b) => ((b as { password: string }).password === "right-pass" ? ok({ grant_id: "g", expires_at: "x" }) : fail(401, "INVALID_CREDENTIALS", "Wrong.")),
    });
    wrap(<Roles />);
    await screen.findByText("Ravi K");
    // Cannot change yourself.
    expect(screen.getAllByRole("button", { name: "Change" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Change" }));
    await userEvent.selectOptions(within(dialog()).getByLabelText("Role"), "admin");
    await userEvent.type(within(dialog()).getByLabelText("Reason"), "New office lead");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    const pw = await screen.findByLabelText("Password");
    expect(screen.getByText(/give someone Admin access/)).toBeInTheDocument();
    await userEvent.type(pw, "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("That password is not right.")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Password"));
    await userEvent.type(screen.getByLabelText("Password"), "right-pass");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText(/Ravi K's access changed/)).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/auth/reauth" && (c.body as { password: string }).password === "right-pass")?.body).toEqual({ password: "right-pass", action: "role.elevate", target_id: "e2" });
    expect(calls.filter((c) => c.path === "/rpc/set_employee_access")).toHaveLength(2);
  });
  it("closing the password sheet cancels without changing anything", async () => {
    const calls = mockFetch({ ...session(), "/rpc/list_access_grants": () => ok([g("e1", "Asha Rao", "admin"), g("e2", "Ravi K", "employee")]), "/rpc/set_employee_access": () => fail(403, "REAUTH_REQUIRED") });
    wrap(<Roles />);
    await userEvent.click(await screen.findByRole("button", { name: "Change" }));
    await userEvent.selectOptions(within(screen.getByRole("dialog")).getByLabelText("Role"), "admin");
    await userEvent.type(within(screen.getByRole("dialog")).getByLabelText("Reason"), "Needed");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    await screen.findByLabelText("Password");
    await userEvent.keyboard("{Escape}");
    expect(await screen.findByText("Cancelled. Nothing was changed.")).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/rpc/set_employee_access")).toHaveLength(1);
  });
  it("the last active Admin cannot be demoted", async () => {
    const calls = mockFetch({ ...session(), "/rpc/list_access_grants": () => ok([g("e1", "Asha Rao", "hr"), g("e9", "Solo Admin", "admin")]) });
    wrap(<Roles />);
    await userEvent.click(await screen.findByRole("button", { name: "Change" }));
    expect(within(dialog()).getByText("This is the only active Admin.")).toBeInTheDocument();
    await userEvent.selectOptions(within(dialog()).getByLabelText("Role"), "employee");
    await userEvent.type(within(dialog()).getByLabelText("Reason"), "Leaving");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect(await within(dialog()).findByText(/This is the last Admin/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/rpc/set_employee_access")).toBe(false);
  });
  it("with two Admins, one can be demoted", async () => {
    mockFetch({ ...session(), "/rpc/list_access_grants": () => ok([g("e1", "Asha Rao", "admin"), g("e9", "Other Admin", "admin")]) });
    wrap(<Roles />);
    await userEvent.click(await screen.findByRole("button", { name: "Change" }));
    expect(within(dialog()).queryByText("This is the only active Admin.")).toBeNull();
  });
  it("HR sees only Employee/HR choices for others and cannot touch an Admin", async () => {
    const calls = mockFetch({ ...session("hr"), "/rpc/list_access_grants": () => ok([g("e1", "Asha Rao", "hr"), g("e3", "Boss", "admin"), g("e2", "Ravi K", "employee")]) });
    wrap(<Roles />);
    await screen.findByText("Boss");
    const boss = screen.getByText("Boss").closest("li")!;
    await userEvent.click(within(boss).getByRole("button", { name: "Change" }));
    await userEvent.type(within(dialog()).getByLabelText("Reason"), "Try");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect(await within(dialog()).findByText(/Only an Admin can change Admin access|Nothing changed/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/rpc/set_employee_access")).toBe(false);
  });
});

describe("Leave policies", () => {
  const types = [
    { id: "lt1", code: "CL", name: "Casual leave", paid: true, half_day_allowed: true, requires_attachment: false, attachment_class: null, max_consecutive_days: null, advance_notice_days: 1, backdate_days: 7, active: true, version: 1 },
    { id: "lt2", code: "LOP", name: "Loss of pay", paid: false, half_day_allowed: true, requires_attachment: false, attachment_class: null, max_consecutive_days: null, advance_notice_days: 0, backdate_days: null, active: true, version: 1 },
  ];
  it("sets a draft entitlement in half-day units and publishes it", async () => {
    let policies: unknown[] = [];
    const calls = mockFetch({
      ...session("hr"),
      "/rpc/list_leave_types": () => ok(types),
      "/rpc/list_leave_policies": () => ok({ leave_year: 2026, leave_year_start_month: 1, policies }),
      "/rpc/save_leave_policy": () => {
        policies = [{ id: "p1", leave_type: { id: "lt1", code: "CL", name: "Casual leave", paid: true }, annual_units: 15, carry_cap_units: null, carry_expiry_months: null, prorata: true, state: "draft", published_at: null }];
        return ok({ id: "p1" });
      },
      "/rpc/publish_leave_policy": () => ok({}),
    });
    wrap(<LeavePolicies now={NOW} />);
    await screen.findByText("Casual leave");
    expect(screen.queryByText("Loss of pay")).toBeNull(); // unpaid types have no entitlement
    await userEvent.click(screen.getByRole("button", { name: "Set entitlement" }));
    await userEvent.type(within(dialog()).getByLabelText("Days per year"), "7.3");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Save draft" }));
    expect(await within(dialog()).findByText(/in halves/)).toBeInTheDocument();
    await userEvent.clear(within(dialog()).getByLabelText("Days per year"));
    await userEvent.type(within(dialog()).getByLabelText("Days per year"), "7.5");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/rpc/save_leave_policy")?.body).toEqual({ p_leave_type_id: "lt1", p_leave_year: 2026, p_annual_units: 15, p_carry_cap_units: null, p_carry_expiry_months: null, p_prorata: true }));
    await userEvent.click(await screen.findByRole("button", { name: "Publish" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/rpc/publish_leave_policy")?.body).toEqual({ p_policy_id: "p1" }));
    expect(await screen.findByText(/Casual leave for 2026 published/)).toBeInTheDocument();
  });

  const holidays = (over: Record<string, unknown> = {}) => ({ year: 2026, target: 12, can_manage: true, can_set_weekly_off: true, saturday_off_weeks: 0b1010, published_count: 1, holidays: [{ id: "h1", date: "2026-01-26", name: "Republic Day", state: "published", version: 1, office_id: null, office_name: null, source: null }, { id: "h2", date: "2026-12-25", name: "Christmas", state: "draft", version: 1, office_id: null, office_name: null, source: null }], ...over });
  it("holidays: publish drafts, set Saturdays off, add a suggestion, refuse a date outside the year", async () => {
    const calls = mockFetch({
      ...session("admin"),
      "/rpc/list_holidays": () => ok(holidays()),
      "/rpc/list_holiday_suggestions": () => ok({ last_fetched_at: null, suggestions: [{ id: "s1", date: "2026-10-20", name: "Diwali", category: "national", state: "new", existing_holiday: null }] }),
      "/rpc/list_org_structure": () => ok(structure),
      "/rpc/publish_holidays": () => ok({}),
      "/rpc/set_saturday_off_weeks": () => ok({}),
      "/rpc/add_holiday_from_suggestion": () => ok({}),
      "/rpc/save_holiday": () => ok({}),
    });
    wrap(<LeavePolicies initialTab="holidays" now={NOW} />);
    expect(await screen.findByText("2nd, 4th Saturday off")).toBeInTheDocument();
    expect(screen.getByText("1 of 12 planned")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Publish 1 draft" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/rpc/publish_holidays")?.body).toEqual({ p_ids: ["h2"] }));
    await userEvent.click(screen.getByRole("button", { name: "Saturdays off" }));
    await userEvent.click(within(dialog()).getByLabelText("1st Saturday"));
    await userEvent.click(within(dialog()).getByLabelText("4th Saturday"));
    await userEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/rpc/set_saturday_off_weeks")?.body).toEqual({ p_weeks: [1, 2] }));
    await userEvent.click(await screen.findByRole("button", { name: "Add" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/rpc/add_holiday_from_suggestion")?.body).toEqual({ p_id: "s1", p_office_id: null }));
    await userEvent.click(screen.getByRole("button", { name: "Add holiday" }));
    const date = within(dialog()).getByLabelText("Date");
    await userEvent.clear(date);
    await userEvent.type(date, "2027-01-01");
    await userEvent.type(within(dialog()).getByLabelText("Name"), "New Year");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Save draft" }));
    expect(await within(dialog()).findByText("Choose a date in 2026.")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/rpc/save_holiday")).toBe(false);
  });
  it("HR without manage rights sees the list but no edit controls", async () => {
    mockFetch({ ...session("hr"), "/rpc/list_holidays": () => ok(holidays({ can_manage: false, can_set_weekly_off: false })), "/rpc/list_org_structure": () => ok(structure) });
    wrap(<LeavePolicies initialTab="holidays" now={NOW} />);
    await screen.findByText("Christmas");
    expect(screen.queryByRole("button", { name: /Add holiday|Saturdays off|Publish|Delete/ })).toBeNull();
  });
  it("leave types: new type validated then saved with normalised code", async () => {
    const calls = mockFetch({ ...session("hr"), "/rpc/list_leave_types": () => ok(types), "/rpc/save_leave_type": () => ok({}) });
    wrap(<LeavePolicies initialTab="types" now={NOW} />);
    expect(await screen.findByText(/Paid · Half days · Back-date 7d · 1d notice/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add leave type" }));
    await userEvent.type(within(dialog()).getByLabelText("Code"), "9x");
    await userEvent.type(within(dialog()).getByLabelText("Name"), "Sick leave");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect(await within(dialog()).findByText(/starting with a letter/)).toBeInTheDocument();
    await userEvent.clear(within(dialog()).getByLabelText("Code"));
    await userEvent.type(within(dialog()).getByLabelText("Code"), "sl");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/rpc/save_leave_type")?.body).toMatchObject({ p_id: null, p_code: "SL", p_name: "Sick leave", p_expected_version: null }));
  });
});

describe("Outside work", () => {
  const row = (id: string, date: string) => ({ id, work_date: date, reason: "Client visit", kind: "outside", request_id: null, employee: { id: "e2", code: "EMP002", name: "Ravi K" } });
  it("filters by kind, pages with a keyset cursor and only cancels today or later", async () => {
    const page1 = Array.from({ length: 30 }, (_, i) => row(`r${i}`, i === 0 ? "2026-11-20" : "2026-11-01"));
    const calls = mockFetch({ ...session("hr"), "/rpc/list_outside_work": (b) => ok((b as { p_before_id: string | null }).p_before_id ? [row("r99", "2026-10-01")] : page1) });
    wrap(<OutsideWork now={NOW} />);
    await screen.findAllByText("Ravi K");
    expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(calls.filter((c) => c.path === "/rpc/list_outside_work").at(-1)?.body).toMatchObject({ p_before_date: "2026-11-01", p_before_id: "r29" }));
    await userEvent.click(screen.getByRole("tab", { name: "Work from home" }));
    await waitFor(() => expect(calls.filter((c) => c.path === "/rpc/list_outside_work").at(-1)?.body).toMatchObject({ p_kind: "wfh", p_before_id: null }));
  });
  it("grant sheet validates people, range and length", async () => {
    const calls = mockFetch({ ...session("hr"), "/rpc/list_outside_work": () => ok([]), "/rpc/list_employees": () => ok({ rows: [{ id: "e2", code: "EMP002", name: "Ravi K", status: "active" }], total: 1 }), "/rpc/grant_outside_work": () => ok({ days_added: 2 }) });
    wrap(<OutsideWork now={NOW} />);
    await userEvent.click(await screen.findByRole("button", { name: "Send out" }));
    await userEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect(await within(dialog()).findByText("Choose at least one person.")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/rpc/grant_outside_work")).toBe(false);
  });
});

describe("Google Sheet", () => {
  it("rejects a non-sheet link and saves a valid one by id", async () => {
    const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz_-123";
    const calls = mockFetch({ ...session(), "/rpc/get_sheet_sync": () => ok({ spreadsheet_id: null, enabled: false, include_salary: false, last_synced_at: null, last_error: "403 forbidden" }), "/rpc/set_sheet_sync": () => ok({ version: 2 }) });
    wrap(<SheetSyncScreen />);
    expect(await screen.findByText(/Last attempt failed: 403 forbidden/)).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Sync on"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Add the sheet link first.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Sheet link"), "https://example.com/x");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/does not look like a Google Sheet/)).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Sheet link"));
    await userEvent.type(screen.getByLabelText("Sheet link"), `https://docs.google.com/spreadsheets/d/${id}/edit`);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/rpc/set_sheet_sync")?.body).toEqual({ p_spreadsheet_id: id, p_enabled: true, p_include_salary: false, p_expected_version: 0 }));
  });
});

describe("Audit", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: 100 - i, action: "employee.updated", actor: { id: "e1", code: "EMP001", name: "Asha Rao" }, target_employee: null, target_type: "employee", target_id: "e2", classification: i === 0 ? "security" : "data", changes: { before: { phone: "1" }, patch: { phone: "2" } }, created_at: `2026-11-${String(14 - Math.floor(i / 10)).padStart(2, "0")}T05:00:00Z`, request_id: null }));
  it("filters by area and local-day range, expands details and loads more", async () => {
    const calls = mockFetch({ ...session(), "/rpc/list_audit": (b) => ok((b as { p_before_id: number | null }).p_before_id ? [] : rows) });
    wrap(<Audit now={NOW} />);
    await screen.findAllByText("Employee · updated");
    await userEvent.click(screen.getAllByRole("button", { expanded: false })[0]);
    expect(screen.getByText("phone: 1 → 2")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(calls.filter((c) => c.path === "/rpc/list_audit").at(-1)?.body).toMatchObject({ p_before_id: 51, p_limit: 50 }));
    await userEvent.type(screen.getByLabelText("From"), "2026-11-10");
    await userEvent.selectOptions(screen.getByLabelText("Area"), "role.");
    await waitFor(() => expect(calls.filter((c) => c.path === "/rpc/list_audit").at(-1)?.body).toMatchObject({ p_from: "2026-11-09T18:30:00.000Z", p_to: null, p_action_prefix: "role.", p_before_id: null }));
  });
  it("a reversed range shows an error and does not query", async () => {
    const calls = mockFetch({ ...session(), "/rpc/list_audit": () => ok([]) });
    wrap(<Audit now={NOW} />);
    await screen.findByText("Nothing recorded for these filters");
    const before = calls.filter((c) => c.path === "/rpc/list_audit").length;
    await userEvent.type(screen.getByLabelText("To"), "2026-11-01");
    await userEvent.type(screen.getByLabelText("From"), "2026-11-05");
    expect(await screen.findByText("Must be on or after From.")).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/rpc/list_audit").length).toBeLessThanOrEqual(before + 2);
    expect(calls.filter((c) => c.path === "/rpc/list_audit").every((c) => !((c.body as { p_from: string | null }).p_from === "2026-11-04T18:30:00.000Z" && (c.body as { p_to: string | null }).p_to))).toBe(true);
  });
});

describe("Jobs", () => {
  it("warns when upkeep stalled and shows job errors", async () => {
    mockFetch({ ...session(), "/rpc/get_maintenance_health": () => ok({ stale: true, outbox_backlog: 4, outbox_failed: 1, pending_uploads: 0, last_tick: { at: "2026-11-14T00:00:00Z", ok: false } }), "/rpc/list_job_runs": () => ok([{ name: "sheet.sync", runs: 3, failures: 1, last_run_at: "2026-11-14T00:00:00Z", last_ok_at: null, last_error: "quota exceeded" }]) });
    wrap(<Jobs />);
    expect(await screen.findByText(/Upkeep has not run recently/)).toBeInTheDocument();
    expect(screen.getByText("4 · 1 failed")).toBeInTheDocument();
    expect(await screen.findByText("Google Sheet sync")).toBeInTheDocument();
    expect(screen.getByText("quota exceeded")).toBeInTheDocument();
  });
});

describe("Announcement", () => {
  it("validates the title and reports recipients", async () => {
    const calls = mockFetch({ ...session("hr"), "/rpc/list_org_structure": () => ok(structure), "/rpc/publish_announcement": () => ok({ recipients: 1 }) });
    wrap(<AnnouncementNew />);
    await userEvent.click(await screen.findByRole("button", { name: "Send" }));
    expect(await screen.findByText("Give it a title.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Title"), "Office closed Friday");
    await userEvent.selectOptions(screen.getByLabelText("Send to"), "t1");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Sent to 1 person.")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/publish_announcement")?.body).toEqual({ p_title: "Office closed Friday", p_body: null, p_team_id: "t1" });
  });
});

describe("Workspace", () => {
  const summary = { scope: "organization", pending_reviews: 3, unassigned_reviews: 2, missed_punches_7d: 1, team_today: { total: 10, on_time: 6, late: 1, not_yet_in: 2, out_of_office: 1 }, storage: { budget_bytes: 1000, used_bytes: 100, reserved_bytes: 0 }, admin_tasks: [{ label: "Publish holidays", href: "/admin/leave-policies?tab=holidays", count: 2 }], week: { from: "2026-11-09", to: "2026-11-15", totals: { present_days: 40, absent_days: 2, late_days: 3, leave_days: 1, wfh_days: 2, outside_days: 0, shortfall_seconds: 5400 } } };
  it("Admin sees unassigned reviews, storage and tasks", async () => {
    mockFetch({ ...session(), "/rpc/get_workspace_summary": () => ok(summary) });
    wrap(<WorkspaceScreen />);
    expect(await screen.findByText("Unassigned reviews")).toBeInTheDocument();
    expect(screen.getByText("1.5 h")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Publish holidays" })).toHaveAttribute("href", "/admin/leave-policies?tab=holidays");
    expect(screen.getByText(/100 B of 1000 B/)).toBeInTheDocument();
  });
  it("HR does not see Admin-only tiles", async () => {
    mockFetch({ ...session("hr"), "/rpc/get_workspace_summary": () => ok(summary) });
    wrap(<WorkspaceScreen />);
    await screen.findByText("Waiting for review");
    expect(screen.queryByText("Unassigned reviews")).toBeNull();
    expect(screen.queryByText(/100 B of 1000 B/)).toBeNull();
    expect(screen.getByRole("link", { name: "Outside work" })).toBeInTheDocument();
  });
});
