// Admin helpers (organization_screen.dart, offices_screen.dart, shifts_screen.dart,
// teams_screen.dart, roles_screen.dart, leave_policies_screen.dart,
// outside_work_screen.dart, sheet_sync_screen.dart, audit_screen.dart).
// Pure functions; SQL checks everything again.

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const SATURDAY_INDEX = WEEKDAYS.indexOf("Sat");

/** Bit 0 = Monday … bit 6 = Sunday (31 = Mon–Fri). */
export function maskDays(mask: number): boolean[] {
  return WEEKDAYS.map((_, i) => (mask & (1 << i)) !== 0);
}
export function daysMask(days: boolean[]): number {
  return days.reduce((m, on, i) => (on ? m | (1 << i) : m), 0);
}
export function maskLabel(mask: number): string {
  const on = WEEKDAYS.filter((_, i) => mask & (1 << i));
  if (on.length === 7) return "Every day";
  if (mask === 31) return "Mon–Fri";
  if (mask === 63) return "Mon–Sat";
  return on.join(", ") || "No days";
}

export function shiftDaysLabel(mask: number): string {
  const days = mask & ~(1 << SATURDAY_INDEX);
  const saturday = "Sat follows company policy";
  return days ? `${maskLabel(days)} · ${saturday}` : saturday;
}

/** "10:00:00" → "10:00"; "" stays "". */
export const hm = (t: string | null | undefined) => (t ? t.slice(0, 5) : "");
/** Minutes between two HH:MM times, wrapping past midnight. */
export function spanMinutes(start: string, end: string): number {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const d = toMin(end) - toMin(start);
  return d <= 0 ? d + 1440 : d;
}
export function hoursLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface ShiftForm {
  name: string;
  effective_from: string;
  start: string;
  end: string;
  days: boolean[];
  grace_min: string;
  lunch_start: string;
  lunch_end: string;
  early_entry_min: string;
  early_credit: boolean;
  extension: boolean;
  extension_min: string;
}

const minutes = (s: string, max: number) => {
  if (!/^\d{1,4}$/.test(s.trim())) return null;
  const n = Number(s);
  return n <= max ? n : null;
};

export function shiftErrors(f: ShiftForm, today: string): Record<string, string> {
  const e: Record<string, string> = {};
  if (f.name.trim().length < 2) e.name = "Give the shift a name.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.effective_from)) e.effective_from = "Choose when it starts.";
  else if (f.effective_from < today) e.effective_from = "A new version cannot start in the past.";
  if (!TIME.test(f.start)) e.start = "Use HH:MM.";
  if (!TIME.test(f.end)) e.end = "Use HH:MM.";
  if (!e.start && !e.end && f.start === f.end) e.end = "End must differ from start.";
  if (!f.days.some(Boolean)) e.days = "Pick at least one working day.";
  if (minutes(f.grace_min, 240) == null) e.grace_min = "0–240 minutes.";
  if (minutes(f.early_entry_min, 240) == null) e.early_entry_min = "0–240 minutes.";
  if (f.extension && minutes(f.extension_min, 720) == null) e.extension_min = "0–720 minutes.";
  if (!!f.lunch_start !== !!f.lunch_end) e.lunch_end = "Give both lunch times or neither.";
  else if (f.lunch_start && (!TIME.test(f.lunch_start) || !TIME.test(f.lunch_end))) e.lunch_end = "Use HH:MM.";
  return e;
}

export function shiftArgs(shiftId: string | null, f: ShiftForm) {
  return {
    p_shift_id: shiftId,
    p_name: f.name.trim(),
    p_effective_from: f.effective_from,
    p_start_local: f.start,
    p_end_local: f.end,
    p_weekly_mask: daysMask(f.days),
    p_grace_seconds: Number(f.grace_min) * 60,
    p_lunch_start_local: f.lunch_start || null,
    p_lunch_end_local: f.lunch_end || null,
    p_early_entry_seconds: Number(f.early_entry_min) * 60,
    p_early_credit: f.early_credit,
    p_checkout_extension_enabled: f.extension,
    p_checkout_extension_seconds: f.extension ? Number(f.extension_min) * 60 : 0,
  };
}

export interface OfficeForm {
  name: string;
  timezone: string;
  latitude: string;
  longitude: string;
  radius_m: string;
  max_accuracy_m: string;
  max_sample_age_s: string;
  strict_mode: boolean;
  active: boolean;
  calibration_status: "untested" | "piloting" | "verified";
  calibration_notes: string;
  wifi: string;
  networks: string;
}

const num = (s: string) => (s.trim() === "" || Number.isNaN(Number(s)) ? null : Number(s));

export function officeErrors(f: OfficeForm): Record<string, string> {
  const e: Record<string, string> = {};
  if (f.name.trim().length < 2) e.name = "Give the office a name.";
  if (!/^[A-Za-z_]+\/[A-Za-z_+-]+(\/[A-Za-z_+-]+)?$/.test(f.timezone.trim()) && f.timezone.trim() !== "UTC") e.timezone = "Use a time zone like Asia/Kolkata.";
  const lat = num(f.latitude);
  const lng = num(f.longitude);
  if (lat == null || lat < -90 || lat > 90) e.latitude = "Latitude is between -90 and 90.";
  if (lng == null || lng < -180 || lng > 180) e.longitude = "Longitude is between -180 and 180.";
  if (lat === 0 && lng === 0) e.latitude = "Set the real office location.";
  const r = num(f.radius_m);
  if (r == null || r < 10 || r > 2000) e.radius_m = "10–2000 metres.";
  const a = num(f.max_accuracy_m);
  if (a == null || a < 5 || a > 500) e.max_accuracy_m = "5–500 metres.";
  const s = num(f.max_sample_age_s);
  if (s == null || !Number.isInteger(s) || s < 1 || s > 300) e.max_sample_age_s = "1–300 seconds.";
  const w = lines(f.wifi);
  if (w.length > 10) e.wifi = "Up to 10 Wi-Fi names.";
  else if (w.some((x) => x.length > 64)) e.wifi = "Wi-Fi names are at most 64 characters.";
  const bad = lines(f.networks).find((x) => !cidrOk(x));
  if (bad) e.networks = `"${bad}" is not an IP range like 203.0.113.0/24.`;
  else if (lines(f.networks).length > 20) e.networks = "Up to 20 ranges.";
  return e;
}

/** Non-empty trimmed lines, de-duplicated, order kept. */
export function lines(s: string): string[] {
  return [...new Set(s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean))];
}

/** IPv4 or IPv6 address with an optional prefix length. */
export function cidrOk(s: string): boolean {
  const [ip, prefix, extra] = s.split("/");
  if (extra !== undefined) return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    if (v4.slice(1).some((o) => Number(o) > 255 || (o.length > 1 && o.startsWith("0")))) return false;
    return prefix === undefined || (/^\d{1,2}$/.test(prefix) && Number(prefix) <= 32);
  }
  if (/^[0-9a-f:]+$/i.test(ip) && ip.includes(":") && (ip.match(/::/g)?.length ?? 0) <= 1) {
    const groups = ip.split(":");
    if (groups.length > 8 || groups.some((g) => g.length > 4)) return false;
    return prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= 128);
  }
  return false;
}

export function officeArgs(id: string | null, f: OfficeForm, version: number | null) {
  return {
    p_id: id,
    p_name: f.name.trim(),
    p_timezone: f.timezone.trim(),
    p_latitude: Number(f.latitude),
    p_longitude: Number(f.longitude),
    p_radius_m: Number(f.radius_m),
    p_max_accuracy_m: Number(f.max_accuracy_m),
    p_max_sample_age_s: Number(f.max_sample_age_s),
    p_strict_mode: f.strict_mode,
    p_active: f.active,
    p_calibration_status: f.calibration_status,
    p_calibration_notes: f.calibration_notes.trim() || null,
    p_expected_version: version,
  };
}

/** Same set regardless of order/case? (skip a write when nothing changed) */
export const sameSet = (a: string[], b: string[]) => {
  const x = new Set(a.map((s) => s.toLowerCase()));
  return x.size === new Set(b.map((s) => s.toLowerCase())).size && b.every((s) => x.has(s.toLowerCase()));
};

/* ───────── leave policy ───────── */

export interface PolicyForm {
  annual_days: string;
  carry_cap_days: string;
  carry_expiry_months: string;
  prorata: boolean;
}

/** Days (halves allowed) → half-day units, null if invalid. Range 0–365 days. */
export function unitsOf(days: string): number | null {
  const t = days.trim();
  if (!/^\d{1,3}(\.\d+)?$/.test(t)) return null;
  const u = Number(t) * 2;
  return Number.isInteger(u) && u <= 730 ? u : null;
}

export function policyErrors(f: PolicyForm): Record<string, string> {
  const e: Record<string, string> = {};
  if (unitsOf(f.annual_days) == null) e.annual_days = "Days per year, in halves (0–365).";
  if (f.carry_cap_days.trim() && unitsOf(f.carry_cap_days) == null) e.carry_cap_days = "Days, in halves.";
  else if (f.carry_cap_days.trim() && unitsOf(f.carry_cap_days)! > (unitsOf(f.annual_days) ?? 0) * 2) e.carry_cap_days = "At most twice the yearly days.";
  if (f.carry_expiry_months.trim() && !(/^\d{1,2}$/.test(f.carry_expiry_months.trim()) && Number(f.carry_expiry_months) <= 24)) e.carry_expiry_months = "0–24 months.";
  return e;
}

export interface LeaveTypeForm {
  code: string;
  name: string;
  paid: boolean;
  half_day_allowed: boolean;
  requires_attachment: boolean;
  attachment_class: "general" | "medical";
  max_consecutive_days: string;
  advance_notice_days: string;
  backdate_days: string;
  active: boolean;
}

const optInt = (s: string, max: number) => s.trim() === "" || (/^\d{1,3}$/.test(s.trim()) && Number(s) <= max);

export function leaveTypeErrors(f: LeaveTypeForm): Record<string, string> {
  const e: Record<string, string> = {};
  if (!/^[A-Z][A-Z0-9]{0,9}$/.test(f.code.trim().toUpperCase())) e.code = "1–10 letters or digits, starting with a letter.";
  if (f.name.trim().length < 2) e.name = "Give the leave type a name.";
  if (!optInt(f.max_consecutive_days, 365)) e.max_consecutive_days = "0–365 days.";
  if (!optInt(f.advance_notice_days, 365)) e.advance_notice_days = "0–365 days.";
  if (!optInt(f.backdate_days, 365)) e.backdate_days = "0–365 days.";
  return e;
}

const intOrNull = (s: string) => (s.trim() === "" ? null : Number(s));
export function leaveTypeArgs(id: string | null, f: LeaveTypeForm, version: number | null) {
  return {
    p_id: id,
    p_code: f.code.trim().toUpperCase(),
    p_name: f.name.trim(),
    p_paid: f.paid,
    p_half_day_allowed: f.half_day_allowed,
    p_requires_attachment: f.requires_attachment,
    p_attachment_class: f.attachment_class,
    p_max_consecutive_days: intOrNull(f.max_consecutive_days),
    p_advance_notice_days: intOrNull(f.advance_notice_days),
    p_backdate_days: intOrNull(f.backdate_days),
    p_active: f.active,
    p_expected_version: version,
  };
}

/* ───────── organization ───────── */

export interface OrgSettings {
  id: string;
  code: string;
  name: string;
  timezone: string;
  support_contact: string | null;
  support_phone: string | null;
  active_employee_cap: number;
  active_employees: number;
  annual_start_month: number;
  leave_year_start_month: number;
  holiday_target: number;
  require_biometric_punch: boolean;
  strict_geofence: boolean;
  setup_published_at: string | null;
  storage_budget_bytes: number;
  storage_used_bytes: number;
  storage_reserved_bytes: number;
  storage_alert_percents: number[];
  version: number;
}

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export interface OrgForm {
  name: string;
  timezone: string;
  support_contact: string;
  active_employee_cap: string;
  holiday_target: string;
  leave_year_start_month: string;
  annual_start_month: string;
  require_biometric_punch: boolean;
  strict_geofence: boolean;
}

export function orgForm(o: OrgSettings): OrgForm {
  return {
    name: o.name,
    timezone: o.timezone,
    support_contact: o.support_contact ?? "",
    active_employee_cap: String(o.active_employee_cap),
    holiday_target: String(o.holiday_target),
    leave_year_start_month: String(o.leave_year_start_month),
    annual_start_month: String(o.annual_start_month),
    require_biometric_punch: o.require_biometric_punch,
    strict_geofence: o.strict_geofence,
  };
}

export function orgErrors(f: OrgForm, activeNow: number): Record<string, string> {
  const e: Record<string, string> = {};
  if (f.name.trim().length < 2) e.name = "Enter the organisation name.";
  const cap = Number(f.active_employee_cap);
  if (!/^\d{1,5}$/.test(f.active_employee_cap) || cap < 1) e.active_employee_cap = "A whole number of accounts.";
  else if (cap < activeNow) e.active_employee_cap = `There are already ${activeNow} active accounts.`;
  if (!/^\d{1,2}$/.test(f.holiday_target) || Number(f.holiday_target) > 40) e.holiday_target = "0–40 holidays.";
  if (f.support_contact.trim().length > 200) e.support_contact = "Keep it under 200 characters.";
  return e;
}

/** Only changed keys, typed for update_org_settings. */
export function orgPatch(before: OrgSettings, f: OrgForm): Record<string, unknown> {
  const now: Record<string, unknown> = {
    name: f.name.trim(),
    timezone: f.timezone.trim(),
    support_contact: f.support_contact.trim() || null,
    active_employee_cap: Number(f.active_employee_cap),
    holiday_target: Number(f.holiday_target),
    leave_year_start_month: Number(f.leave_year_start_month),
    annual_start_month: Number(f.annual_start_month),
    require_biometric_punch: f.require_biometric_punch,
    strict_geofence: f.strict_geofence,
  };
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(now)) if ((before as unknown as Record<string, unknown>)[k] !== v) patch[k] = v;
  return patch;
}

export function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Percent used (0–100, one decimal), counting reserved bytes. */
export function storagePercent(used: number, reserved: number, budget: number): number {
  if (!budget) return 0;
  return Math.min(100, Math.round(((used + reserved) / budget) * 1000) / 10);
}

/* ───────── Google Sheet ───────── */

/** Sheet id from a link or a bare id; null when it does not look like one. */
export function sheetId(s: string): string | null {
  const t = s.trim();
  const m = /docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(t);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(t) ? t : null;
}

/* ───────── audit ───────── */

export interface AuditRow {
  id: number;
  action: string;
  actor: { id: string; code: string; name: string } | null;
  target_employee: { id: string; code: string; name: string } | null;
  target_type: string | null;
  target_id: string | null;
  classification: string;
  changes: unknown;
  created_at: string;
  request_id: string | null;
}

export const AUDIT_AREAS = [
  { value: "", label: "Everything" },
  { value: "employee.", label: "Employees" },
  { value: "request.", label: "Requests" },
  { value: "leave", label: "Leave" },
  { value: "attendance.", label: "Attendance" },
  { value: "payslip.", label: "Payslips" },
  { value: "salary.", label: "Salary" },
  { value: "document.", label: "Documents" },
  { value: "file.", label: "Files" },
  { value: "role.", label: "Roles" },
  { value: "auth.", label: "Sign-in" },
  { value: "org.", label: "Organisation" },
  { value: "device", label: "Devices" },
];

/** "employee.files_viewed" → "Employee · files viewed" */
export function actionLabel(a: string): string {
  const [area, ...rest] = a.split(".");
  const what = rest.join(" ").replace(/_/g, " ");
  return `${area.charAt(0).toUpperCase()}${area.slice(1).replace(/_/g, " ")}${what ? ` · ${what}` : ""}`;
}

/** One line per changed field from {before, patch} or {before, after}. */
export function changeLines(c: unknown): string[] {
  if (!c || typeof c !== "object") return [];
  const o = c as Record<string, unknown>;
  const before = (o.before && typeof o.before === "object" ? o.before : {}) as Record<string, unknown>;
  const after = (o.patch ?? o.after) as Record<string, unknown> | undefined;
  const show = (v: unknown) => (v == null || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
  if (after && typeof after === "object") return Object.keys(after).map((k) => `${k.replace(/_/g, " ")}: ${show(before[k])} → ${show(after[k])}`);
  return Object.entries(o)
    .filter(([k]) => k !== "before")
    .slice(0, 8)
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${show(v)}`);
}

/** Keyset cursor for list_audit. */
export function auditCursor(rows: AuditRow[], limit: number): { p_before_created_at: string; p_before_id: number } | null {
  if (rows.length < limit || rows.length === 0) return null;
  const last = rows[rows.length - 1];
  return { p_before_created_at: last.created_at, p_before_id: last.id };
}

/* ───────── weekly off / time zones ───────── */

/** Saturday-off mask: bit 0 = 1st Saturday … bit 4 = 5th. */
export const satWeeks = (mask: number) => [1, 2, 3, 4, 5].filter((w) => mask & (1 << (w - 1)));
export const ORDINAL = ["1st", "2nd", "3rd", "4th", "5th"];
export function satLabel(mask: number): string {
  const w = satWeeks(mask);
  if (w.length === 0) return "All Saturdays are working days";
  if (w.length === 5) return "Every Saturday off";
  return `${w.map((x) => ORDINAL[x - 1]).join(", ")} Saturday off`;
}

/** Minutes the zone is ahead of UTC at that instant. */
export function tzOffsetMinutes(at: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(at))
      .map((x) => [x.type, x.value]),
  );
  const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((local - at) / 60000);
}

/** The instant a local calendar day starts in the zone, as ISO (UTC). */
export function localDayStartIso(ymd: string, tz: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const off = tzOffsetMinutes(guess - tzOffsetMinutes(guess, tz) * 60000, tz);
  return new Date(guess - off * 60000).toISOString();
}

/** Next calendar day (YYYY-MM-DD). */
export function nextDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** Days from..to inclusive, or null if reversed/invalid. */
export function dayCount(from: string, to: string): number | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return Math.round((b - a) / 86400000) + 1;
}
