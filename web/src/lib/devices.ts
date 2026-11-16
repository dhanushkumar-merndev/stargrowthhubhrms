// Attendance machine (eSSL) console: shapes returned by the device RPCs and
// pure helpers, ported from fingertipssl src/lib/console.

import type { Tone } from "@/components/ui";

export interface EmployeeRef {
  id: string;
  code: string;
  name: string;
}

export type ScanKind = "in" | "out" | "extra" | "duplicate";

export interface DevicePunch {
  id: string;
  serial: string;
  device_label: string | null;
  pin: string | null;
  employee: EmployeeRef | null;
  kind: ScanKind;
  counted: boolean;
  device_time: string;
  device_local_time: string;
  received_at: string;
  verify_mode: number | null;
  has_photo: boolean;
}

export interface UnmatchedPin {
  serial: string;
  device_label: string | null;
  pin: string;
  punches: number;
  first_local: string;
  last_local: string;
  last_punch_id: string;
  with_photo: number;
  machine_name: string | null;
}

export interface DeviceLink {
  id: string;
  pin: string;
  serial: string | null;
  device_label: string | null;
  employee: EmployeeRef;
  linked_at: string;
}

export interface AttendanceDevice {
  id: string;
  serial: string;
  label: string;
  office: string | null;
  office_id: string | null;
  mode: "http" | "https";
  active: boolean;
  has_token: boolean;
  last_seen_at: string | null;
  last_punch_received_at: string | null;
  firmware: string | null;
  push_version: string | null;
  clock_drift_seconds: number | null;
  punches_today: number;
  rejections_24h: number;
  machine_users: number;
  commands_enabled: boolean;
  open_commands: number;
}

export interface MachineUser {
  serial: string;
  device_label: string;
  pin: string;
  name: string | null;
  is_device_admin: boolean;
  last_reported_at: string;
  linked_to: EmployeeRef | null;
}

export interface IngestRejection {
  id: number;
  serial: string | null;
  code: string;
  detail: Record<string, unknown> | null;
  created_at: string;
}

export type CommandKind = "user_upsert" | "user_delete" | "enroll_fingerprint" | "enroll_face";
export type CommandStatus = "queued" | "sent" | "done" | "failed" | "expired" | "cancelled";

export interface DeviceCommand {
  id: number;
  serial: string;
  device_label: string | null;
  kind: CommandKind;
  pin: string;
  employee: EmployeeRef | null;
  name: string | null;
  status: CommandStatus;
  attempts: number;
  return_code: number | null;
  created_at: string;
}

export interface EmployeeDeviceStatus {
  employee_id: string;
  machines: { serial: string; label: string; pin: string; name: string | null }[];
  pending_commands: number;
  last_command: { kind: CommandKind; status: CommandStatus; return_code: number | null; device_label: string; at: string } | null;
}

export type DayStatus = "not_in" | "absent" | "in_office" | "checked_out" | "forgot_checkout" | "no_checkout" | "corrected";

export interface AttendanceSettings {
  duplicate_window_minutes: number;
  auto_checkout_enabled: boolean;
  timezone: string;
  today: string;
}

export interface DayRow {
  employee: EmployeeRef & { status: string };
  pins: string[];
  status: DayStatus;
  first_in_at: string | null;
  out_at: string | null;
  out_source: "device" | "auto" | "hr" | null;
  device_out_at: string | null;
  forgot_checkout: boolean;
  worked_minutes: number | null;
  scan_count: number;
  duplicate_count: number;
  correction: { out_at: string; reason: string; at: string; by: string | null } | null;
}

export interface AttendanceDayBoard {
  date: string;
  is_today: boolean;
  settings: AttendanceSettings;
  rows: DayRow[];
}

// ---------------------------------------------------------------- tabs
// Here (not in the client screen) so the server page can read them.

export const DEVICE_TABS = [
  { key: "today", label: "Today" },
  { key: "live", label: "Live" },
  { key: "unmatched", label: "Unmatched" },
  { key: "machines", label: "Machines" },
  { key: "staff", label: "Staff PINs" },
] as const;
export type DeviceTab = (typeof DEVICE_TABS)[number]["key"];

export function deviceTab(v: string | undefined | null): DeviceTab {
  return DEVICE_TABS.find((t) => t.key === v)?.key ?? "today";
}

// ---------------------------------------------------------------- labels

export const DAY_STATUS: Record<DayStatus, { label: string; tone: Tone }> = {
  in_office: { label: "In office", tone: "success" },
  checked_out: { label: "Checked out", tone: "info" },
  corrected: { label: "Checked out · fixed by HR", tone: "info" },
  forgot_checkout: { label: "Forgot to check out", tone: "warning" },
  no_checkout: { label: "No check-out", tone: "warning" },
  not_in: { label: "Not in yet", tone: "neutral" },
  absent: { label: "Absent", tone: "neutral" },
};

export const SCAN_KIND: Record<ScanKind, { label: string; tone: Tone; title: string }> = {
  in: { label: "IN", tone: "success", title: "First scan of the day (check-in)" },
  out: { label: "OUT", tone: "info", title: "Latest counted scan (check-out); moves if they scan again later" },
  extra: { label: "EXTRA", tone: "neutral", title: "Counted scan between check-in and check-out" },
  duplicate: { label: "DUP", tone: "neutral", title: "Repeat scan inside the duplicate window: kept, not counted" },
};

const VERIFY: Record<number, string> = { 0: "Password", 1: "Fingerprint", 2: "Card", 3: "Password", 4: "Card", 15: "Face", 25: "Palm" };
export function verifyLabel(mode: number | null | undefined): string {
  if (mode == null) return "Unknown";
  return VERIFY[mode] ?? `Mode ${mode}`;
}

export const REJECTION: Record<string, string> = {
  unknown_serial: "Unknown machine",
  inactive_device: "Machine turned off in HRMS",
  bad_token: "Wrong device token",
  bad_secret: "Server set-up problem (ingest secret)",
  bad_serial: "Malformed serial",
  malformed_line: "Unreadable log line",
  bad_pin: "Invalid user number",
  bad_time: "Invalid date or time",
  future_time: "Time in the future",
  stale_time: "Time too far in the past",
  bad_photo: "Unusable photo",
  photo_storage_off: "Photo received (photo storage not set up yet)",
  photo_out_of_window: "Photo time out of range",
  bad_photo_path: "Photo path refused",
  biometric_discarded: "Fingerprint/face data discarded (never stored)",
  body_too_large: "Upload too large",
  bad_batch: "Malformed batch",
};
export const rejectionLabel = (code: string) => REJECTION[code] ?? code.replace(/_/g, " ");

export const COMMAND_KIND: Record<CommandKind, string> = {
  user_upsert: "Add / update user",
  user_delete: "Remove user",
  enroll_fingerprint: "Enrol fingerprint",
  enroll_face: "Enrol face",
};
export const COMMAND_STATUS: Record<CommandStatus, { label: string; tone: Tone }> = {
  queued: { label: "Waiting", tone: "neutral" },
  sent: { label: "Sent", tone: "info" },
  done: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "error" },
  expired: { label: "Expired", tone: "warning" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};
export const commandOpen = (s: CommandStatus) => s === "queued" || s === "sent";

// ---------------------------------------------------------------- formatting

/** "2026-11-11 10:02:03" (device wall time) -> "11 Nov, 10:02:03". No timezone shift. */
export function formatLocal(local: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(local ?? "");
  if (!m) return "—";
  const month = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleString("en-IN", { month: "short", timeZone: "UTC" });
  return `${+m[3]} ${month}, ${m[4]}:${m[5]}:${m[6] ?? "00"}`;
}

export function localTime(local: string | null | undefined): string {
  const s = formatLocal(local);
  return s === "—" ? s : s.split(", ")[1];
}

export function minutes(min: number | null | undefined): string {
  if (min == null) return "—";
  const m = Math.max(0, Math.floor(min));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function relative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "never";
  const s = Math.round((now - t) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** A machine polls every ~10–30 s; 3 minutes of silence means it is offline. */
export function isOnline(d: Pick<AttendanceDevice, "active" | "last_seen_at">, now = Date.now()): boolean {
  if (!d.active || !d.last_seen_at) return false;
  const t = new Date(d.last_seen_at).getTime();
  return !Number.isNaN(t) && now - t < 3 * 60 * 1000;
}

export function drift(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const a = Math.abs(Math.round(seconds));
  if (a < 60) return a <= 5 ? "In sync" : `${seconds > 0 ? "+" : "−"}${a}s`;
  const m = Math.round(a / 60);
  return `${seconds > 0 ? "+" : "−"}${m} min`;
}

export function countByStatus(rows: Pick<DayRow, "status">[]): Partial<Record<DayStatus, number>> {
  const c: Partial<Record<DayStatus, number>> = {};
  rows.forEach((r) => (c[r.status] = (c[r.status] ?? 0) + 1));
  return c;
}

// ---------------------------------------------------------------- live feed

export function sortPunches<T extends Pick<DevicePunch, "id" | "received_at">>(list: T[]): T[] {
  return [...list].sort((a, b) =>
    a.received_at === b.received_at ? (a.id < b.id ? 1 : -1) : a.received_at < b.received_at ? 1 : -1,
  );
}

/** Merge re-read rows into the feed: update, add, and drop ids that no longer match the filter. */
export function mergePunches(prev: DevicePunch[], ids: string[], rows: DevicePunch[], cap = 200): DevicePunch[] {
  const byId = new Map(prev.map((p) => [p.id, p]));
  rows.forEach((r) => byId.set(r.id, r));
  ids.forEach((id) => {
    if (!rows.some((r) => r.id === id)) byId.delete(id);
  });
  return sortPunches([...byId.values()]).slice(0, cap);
}

/** Best-effort match of the machine's user name to an employee (one clear match only). */
export function suggestMatch(machineName: string | null | undefined, people: EmployeeRef[]): EmployeeRef | null {
  if (!machineName) return null;
  const norm = (v: string) =>
    v
      .toLowerCase()
      .replace(/\(.*?\)/g, "")
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const target = norm(machineName);
  if (target.length < 2) return null;
  const exact = people.filter((p) => norm(p.name) === target);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const partial = people.filter((p) => {
    const n = norm(p.name);
    return n.startsWith(target) || target.startsWith(n) || n.split(" ")[0] === target.split(" ")[0];
  });
  return partial.length === 1 ? partial[0] : null;
}

// ---------------------------------------------------------------- forms

export interface DeviceForm {
  serial: string;
  label: string;
  officeId: string;
  mode: "http" | "https";
  active: boolean;
  token: string;
  /** keep | set | remove (edit only) */
  tokenAction: "keep" | "set" | "remove";
}

export function deviceFormErrors(f: DeviceForm, editing: boolean): Record<string, string> {
  const e: Record<string, string> = {};
  if (!editing && !/^[A-Za-z0-9_-]{4,40}$/.test(f.serial.trim())) e.serial = "Serial numbers are 4–40 letters, digits, - or _.";
  if (!f.label.trim()) e.label = "Give the machine a name.";
  else if (f.label.trim().length > 80) e.label = "Keep the name under 80 characters.";
  if (f.tokenAction === "set" && f.token.length < 16) e.token = "A device token must be at least 16 characters.";
  return e;
}

export function devicePayload(f: DeviceForm, id?: string): Record<string, unknown> {
  const p: Record<string, unknown> = {
    label: f.label.trim(),
    office_id: f.officeId || null,
    mode: f.mode,
    active: f.active,
  };
  if (id) p.id = id;
  else p.serial = f.serial.trim().toUpperCase();
  if (f.tokenAction === "set") p.token = f.token;
  if (f.tokenAction === "remove") p.token = "";
  return p;
}

export function correctionErrors(outTime: string, reason: string, clearing: boolean): Record<string, string> {
  const e: Record<string, string> = {};
  if (!clearing && !/^([01]\d|2[0-3]):[0-5]\d$/.test(outTime)) e.outTime = "Enter the check-out time (HH:MM).";
  const r = reason.trim();
  if (r.length < 3) e.reason = "Give a reason (at least 3 characters).";
  else if (r.length > 300) e.reason = "Keep the reason under 300 characters.";
  return e;
}

export function windowError(v: string): string | null {
  const n = Number(v);
  return v.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= 60 ? null : "Use a whole number of minutes from 1 to 60.";
}

/* ─────────── New from machine (people on a machine, not in the app yet) ─────────── */

export interface MachinePerson {
  serial: string;
  pin: string;
  name: string | null;
  is_device_admin: boolean;
  device_label: string | null;
  last_reported_at: string | null;
  punches: number;
}

export const machinePersonKey = (p: Pick<MachinePerson, "serial" | "pin">) => `${p.serial}|${p.pin}`;

/** The name to hire under: the machine's name, cleaned, or "Machine user <PIN>". */
export function machineHireName(p: Pick<MachinePerson, "name" | "pin">): string {
  const n = (p.name ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return n.length >= 2 ? n : `Machine user ${p.pin}`;
}

export interface HireDefaults {
  team_id: string;
  office_id: string;
  shift_id: string;
  join_date: string;
}

export function hireDefaultsErrors(d: HireDefaults): Partial<Record<keyof HireDefaults, string>> {
  const e: Partial<Record<keyof HireDefaults, string>> = {};
  if (!d.team_id) e.team_id = "Choose a team.";
  if (!d.office_id) e.office_id = "Choose an office.";
  if (!d.shift_id) e.shift_id = "Choose a shift.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.join_date) || Number.isNaN(Date.parse(d.join_date))) e.join_date = "Choose the join date.";
  return e;
}

/** Body for POST /admin/users: ID generated by the server, PIN taken from the machine. */
export function machineHireBody(p: MachinePerson, d: HireDefaults, operationId: string) {
  return {
    operation_id: operationId,
    fields: { full_name: machineHireName(p), join_date: d.join_date, team_id: d.team_id, office_id: d.office_id, shift_id: d.shift_id, role: "member" },
    device_pin: p.pin,
    device_serial: p.serial,
  };
}
