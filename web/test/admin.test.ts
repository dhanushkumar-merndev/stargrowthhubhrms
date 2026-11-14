import { describe, expect, it } from "vitest";
import {
  type LeaveTypeForm,
  type OfficeForm,
  type OrgSettings,
  type ShiftForm,
  actionLabel,
  auditCursor,
  bytesLabel,
  changeLines,
  cidrOk,
  dayCount,
  daysMask,
  hoursLabel,
  leaveTypeArgs,
  leaveTypeErrors,
  lines,
  localDayStartIso,
  maskDays,
  maskLabel,
  nextDay,
  officeErrors,
  orgErrors,
  orgForm,
  orgPatch,
  policyErrors,
  satLabel,
  satWeeks,
  sameSet,
  sheetId,
  shiftArgs,
  shiftErrors,
  spanMinutes,
  storagePercent,
  tzOffsetMinutes,
  unitsOf,
} from "@/lib/admin";

describe("weekday masks", () => {
  it("round-trips every mask", () => {
    for (let m = 0; m < 128; m++) expect(daysMask(maskDays(m))).toBe(m);
  });
  it.each([
    [31, "Mon–Fri"],
    [63, "Mon–Sat"],
    [127, "Every day"],
    [0, "No days"],
    [1 | 4 | 16, "Mon, Wed, Fri"],
    [64, "Sun"],
  ])("maskLabel(%i) = %s", (m, s) => expect(maskLabel(m)).toBe(s));
});

describe("shift times", () => {
  it.each([
    ["09:00", "18:00", 540],
    ["22:00", "06:00", 480],
    ["00:00", "00:01", 1],
    ["10:00", "10:00", 1440],
  ])("spanMinutes(%s, %s) = %i", (a, b, n) => expect(spanMinutes(a, b)).toBe(n));
  it.each([
    [540, "9h"],
    [545, "9h 5m"],
    [0, "0h"],
  ])("hoursLabel(%i)", (m, s) => expect(hoursLabel(m)).toBe(s));

  const shift = (over: Partial<ShiftForm> = {}): ShiftForm => ({
    name: "General", effective_from: "2026-11-14", start: "09:30", end: "18:30", days: maskDays(31), grace_min: "10",
    lunch_start: "13:00", lunch_end: "14:00", early_entry_min: "30", early_credit: false, extension: false, extension_min: "", ...over,
  });
  it("accepts a normal shift and builds RPC args in seconds", () => {
    expect(shiftErrors(shift(), "2026-11-14")).toEqual({});
    expect(shiftArgs("s1", shift({ extension: true, extension_min: "60" }))).toMatchObject({
      p_shift_id: "s1", p_weekly_mask: 31, p_grace_seconds: 600, p_early_entry_seconds: 1800, p_checkout_extension_enabled: true, p_checkout_extension_seconds: 3600,
    });
    expect(shiftArgs(null, shift({ lunch_start: "", lunch_end: "" }))).toMatchObject({ p_lunch_start_local: null, p_lunch_end_local: null, p_checkout_extension_seconds: 0 });
  });
  it.each([
    [{ name: "A" }, "name"],
    [{ effective_from: "2026-11-13" }, "effective_from"],
    [{ effective_from: "" }, "effective_from"],
    [{ start: "24:00" }, "start"],
    [{ end: "9:30" }, "end"],
    [{ end: "09:30" }, "end"],
    [{ days: maskDays(0) }, "days"],
    [{ grace_min: "241" }, "grace_min"],
    [{ grace_min: "-1" }, "grace_min"],
    [{ early_entry_min: "abc" }, "early_entry_min"],
    [{ extension: true, extension_min: "721" }, "extension_min"],
    [{ lunch_end: "" }, "lunch_end"],
    [{ lunch_start: "1pm" }, "lunch_end"],
  ])("rejects %o", (over, key) => expect(shiftErrors(shift(over as Partial<ShiftForm>), "2026-11-14")).toHaveProperty(key));
  it("allows a night shift crossing midnight", () => expect(shiftErrors(shift({ start: "22:00", end: "06:00", lunch_start: "", lunch_end: "" }), "2026-11-14")).toEqual({}));
});

describe("offices", () => {
  const office = (over: Partial<OfficeForm> = {}): OfficeForm => ({
    name: "HQ", timezone: "Asia/Kolkata", latitude: "12.97", longitude: "77.59", radius_m: "150", max_accuracy_m: "50", max_sample_age_s: "30",
    strict_mode: false, active: true, calibration_status: "untested", calibration_notes: "", wifi: "", networks: "", ...over,
  });
  it("accepts a valid office", () => {
    expect(officeErrors(office())).toEqual({});
    expect(officeErrors(office({ timezone: "UTC", networks: "203.0.113.0/24\n2001:db8::/32", wifi: "Office-5G" }))).toEqual({});
    expect(officeErrors(office({ timezone: "America/Argentina/Buenos_Aires" }))).toEqual({});
  });
  it.each([
    [{ name: " " }, "name"],
    [{ timezone: "IST" }, "timezone"],
    [{ latitude: "91" }, "latitude"],
    [{ latitude: "" }, "latitude"],
    [{ longitude: "-181" }, "longitude"],
    [{ latitude: "0", longitude: "0" }, "latitude"],
    [{ radius_m: "9" }, "radius_m"],
    [{ radius_m: "2001" }, "radius_m"],
    [{ max_accuracy_m: "4" }, "max_accuracy_m"],
    [{ max_sample_age_s: "1.5" }, "max_sample_age_s"],
    [{ max_sample_age_s: "301" }, "max_sample_age_s"],
    [{ wifi: Array.from({ length: 11 }, (_, i) => `w${i}`).join("\n") }, "wifi"],
    [{ wifi: "x".repeat(65) }, "wifi"],
    [{ networks: "10.0.0.0/33" }, "networks"],
    [{ networks: Array.from({ length: 21 }, (_, i) => `10.0.${i}.0/24`).join("\n") }, "networks"],
  ])("rejects %o", (over, key) => expect(officeErrors(office(over as Partial<OfficeForm>))).toHaveProperty(key));

  it.each(["10.0.0.1", "10.0.0.0/8", "0.0.0.0/0", "255.255.255.255/32", "::1", "2001:db8::/32", "fe80::1/128"])("cidrOk(%s)", (s) => expect(cidrOk(s)).toBe(true));
  it.each(["256.0.0.1", "10.0.0", "10.0.0.01", "10.0.0.0/33", "1.2.3.4/x", "1.2.3.4/8/8", "2001::db8::1", "12345::", "::/129", "hello", ""])("cidrOk(%s) is false", (s) => expect(cidrOk(s)).toBe(false));
  it("lines trims, splits on commas/newlines and de-duplicates", () => expect(lines(" a ,b\n\na\n c ")).toEqual(["a", "b", "c"]));
  it("sameSet ignores order and case", () => {
    expect(sameSet(["A", "b"], ["B", "a"])).toBe(true);
    expect(sameSet(["a"], ["a", "b"])).toBe(false);
    expect(sameSet([], [])).toBe(true);
  });
});

describe("leave policy and types", () => {
  it.each([["12", 24], ["7.5", 15], ["0", 0], ["365", 730]])("unitsOf(%s) = %i", (s, u) => expect(unitsOf(s)).toBe(u));
  it.each(["", "-1", "0.3", "366", "1e2", "abc", "1,5"])("unitsOf(%s) is null", (s) => expect(unitsOf(s)).toBeNull());
  it("checks carry-forward against the yearly amount", () => {
    expect(policyErrors({ annual_days: "12", carry_cap_days: "24", carry_expiry_months: "3", prorata: true })).toEqual({});
    expect(policyErrors({ annual_days: "12", carry_cap_days: "25", carry_expiry_months: "", prorata: true })).toHaveProperty("carry_cap_days");
    expect(policyErrors({ annual_days: "x", carry_cap_days: "", carry_expiry_months: "", prorata: true })).toHaveProperty("annual_days");
    expect(policyErrors({ annual_days: "12", carry_cap_days: "", carry_expiry_months: "25", prorata: true })).toHaveProperty("carry_expiry_months");
  });
  const type = (over: Partial<LeaveTypeForm> = {}): LeaveTypeForm => ({
    code: "cl", name: "Casual leave", paid: true, half_day_allowed: true, requires_attachment: false, attachment_class: "general",
    max_consecutive_days: "", advance_notice_days: "2", backdate_days: "", active: true, ...over,
  });
  it("normalises the code and sends blanks as null", () => {
    expect(leaveTypeErrors(type())).toEqual({});
    expect(leaveTypeArgs(null, type(), null)).toMatchObject({ p_code: "CL", p_max_consecutive_days: null, p_advance_notice_days: 2, p_expected_version: null });
  });
  it.each([
    [{ code: "1A" }, "code"],
    [{ code: "" }, "code"],
    [{ code: "ABCDEFGHIJK" }, "code"],
    [{ name: "x" }, "name"],
    [{ max_consecutive_days: "366" }, "max_consecutive_days"],
    [{ advance_notice_days: "-1" }, "advance_notice_days"],
    [{ backdate_days: "2.5" }, "backdate_days"],
  ])("rejects %o", (over, key) => expect(leaveTypeErrors(type(over as Partial<LeaveTypeForm>))).toHaveProperty(key));
});

describe("organisation", () => {
  const org = { id: "o", code: "ORG", name: "Acme", timezone: "Asia/Kolkata", support_contact: null, support_phone: null, active_employee_cap: 50, holiday_target: 12, leave_year_start_month: 1, annual_start_month: 4, require_biometric_punch: false, strict_geofence: true } as unknown as OrgSettings;
  it("patch contains only changed keys", () => {
    const f = orgForm(org);
    expect(orgPatch(org, f)).toEqual({});
    expect(orgPatch(org, { ...f, name: " Acme Ltd ", support_contact: "  " , holiday_target: "14" })).toEqual({ name: "Acme Ltd", holiday_target: 14 });
  });
  it("cannot set the cap below current active accounts", () => {
    const f = orgForm(org);
    expect(orgErrors({ ...f, active_employee_cap: "9" }, 10).active_employee_cap).toMatch(/already 10/);
    expect(orgErrors({ ...f, active_employee_cap: "0" }, 0)).toHaveProperty("active_employee_cap");
    expect(orgErrors({ ...f, holiday_target: "41" }, 0)).toHaveProperty("holiday_target");
    expect(orgErrors(f, 50)).toEqual({});
  });
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1536, "1.5 KB"],
    [5 * 1024 ** 2, "5.0 MB"],
    [2 * 1024 ** 3, "2.00 GB"],
  ])("bytesLabel(%i)", (n, s) => expect(bytesLabel(n)).toBe(s));
  it("storagePercent counts reserved bytes and caps at 100", () => {
    expect(storagePercent(250, 250, 1000)).toBe(50);
    expect(storagePercent(2000, 0, 1000)).toBe(100);
    expect(storagePercent(1, 0, 0)).toBe(0);
    expect(storagePercent(1, 0, 3)).toBe(33.3);
  });
});

describe("Google Sheet id", () => {
  const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz_-123";
  it("takes a link or a bare id", () => {
    expect(sheetId(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`)).toBe(id);
    expect(sheetId(` ${id} `)).toBe(id);
  });
  it.each(["", "short", "https://example.com/spreadsheets/d/x", "has spaces in it which is not an id at all"])("rejects %s", (s) => expect(sheetId(s)).toBeNull());
});

describe("audit", () => {
  it("labels actions", () => {
    expect(actionLabel("employee.files_viewed")).toBe("Employee · files viewed");
    expect(actionLabel("org_settings.updated")).toBe("Org settings · updated");
    expect(actionLabel("login")).toBe("Login");
  });
  it("shows before → after per changed field", () => {
    expect(changeLines({ before: { name: "A" }, patch: { name: "B", phone: null } })).toEqual(["name: A → B", "phone: — → —"]);
    expect(changeLines({ reason: "typo", count: 2 })).toEqual(["reason: typo", "count: 2"]);
    expect(changeLines(null)).toEqual([]);
    expect(changeLines("x")).toEqual([]);
  });
  it("cursor only when a full page came back", () => {
    const rows = [{ id: 9, created_at: "2026-11-14T00:00:00Z" }, { id: 7, created_at: "2026-11-13T00:00:00Z" }] as never[];
    expect(auditCursor(rows, 2)).toEqual({ p_before_created_at: "2026-11-13T00:00:00Z", p_before_id: 7 });
    expect(auditCursor(rows, 3)).toBeNull();
    expect(auditCursor([], 0)).toBeNull();
  });
});

describe("weekly off and time zones", () => {
  it("decodes Saturday weeks", () => {
    expect(satWeeks(0b10100)).toEqual([3, 5]);
    expect(satLabel(0)).toBe("All Saturdays are working days");
    expect(satLabel(31)).toBe("Every Saturday off");
    expect(satLabel(0b1010)).toBe("2nd, 4th Saturday off");
  });
  it("offsets and day starts", () => {
    expect(tzOffsetMinutes(Date.UTC(2026, 10, 14), "Asia/Kolkata")).toBe(330);
    expect(tzOffsetMinutes(Date.UTC(2026, 10, 14), "UTC")).toBe(0);
    expect(localDayStartIso("2026-11-14", "Asia/Kolkata")).toBe("2026-11-13T18:30:00.000Z");
    expect(localDayStartIso("2026-11-14", "America/New_York")).toBe("2026-11-14T05:00:00.000Z");
    // DST start day in New York (clocks jump at 02:00): midnight is still EST.
    expect(localDayStartIso("2026-03-08", "America/New_York")).toBe("2026-03-08T05:00:00.000Z");
    expect(localDayStartIso("2026-07-01", "America/New_York")).toBe("2026-07-01T04:00:00.000Z");
  });
  it("calendar maths", () => {
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
    expect(nextDay("2028-02-28")).toBe("2028-02-29");
    expect(dayCount("2026-11-14", "2026-11-14")).toBe(1);
    expect(dayCount("2026-11-01", "2026-11-30")).toBe(30);
    expect(dayCount("2026-11-02", "2026-11-01")).toBeNull();
    expect(dayCount("", "2026-11-01")).toBeNull();
  });
});
