// Leave helpers (leave_screen.dart / leave_apply_screen.dart). Units are
// half-days everywhere on the server: 1 = half a day, 2 = a full day.

export type Slot = "FULL" | "AM" | "PM";

export interface LeaveType {
  id: string;
  code: string;
  name: string;
  paid: boolean;
  active: boolean;
  half_day_allowed: boolean;
  requires_attachment: boolean;
  attachment_class: string | null;
  advance_notice_days: number | null;
  backdate_days: number | null;
  max_consecutive_days: number | null;
  version: number;
}

export interface Balance {
  leave_type: Pick<LeaveType, "id" | "code" | "name" | "paid" | "half_day_allowed" | "requires_attachment">;
  leave_year: number;
  allocated_units: number;
  used_units: number;
  reserved_units: number;
  expired_units: number;
  /** null for unpaid leave (no cap). */
  available_units: number | null;
}

export interface Balances {
  balances: Balance[];
  leave_year: number;
  leave_year_start_month: number;
}

export interface PreviewDay {
  day: string;
  slot: Slot;
  units: number;
  start_at: string;
  end_at: string;
  split_at: string;
}

export interface Preview {
  valid: boolean;
  units?: number;
  days?: PreviewDay[];
  attendance_conflicts?: number;
  errors: Record<string, string>;
}

export interface Holiday {
  id: string;
  date: string;
  name: string;
  state: string;
  version: number;
  office_id: string | null;
  office_name: string | null;
  source: string | null;
}

export interface HolidayYear {
  year: number;
  target: number;
  can_manage: boolean;
  can_set_weekly_off: boolean;
  published_count: number;
  saturday_off_weeks: number;
  holidays: Holiday[];
}

/** "½ day", "1 day", "2.5 days" from half-day units. */
export function daysLabel(units: number | null | undefined): string {
  if (units == null || !Number.isFinite(units)) return "—";
  const d = units / 2;
  if (d === 0.5) return "½ day";
  if (d === -0.5) return "-½ day";
  const n = Number.isInteger(d) ? String(d) : d.toFixed(1);
  return `${n} ${Math.abs(d) === 1 ? "day" : "days"}`;
}

export const SLOT_LABEL: Record<Slot, string> = { FULL: "Full day", AM: "First half", PM: "Second half" };

/** The slot choices offered for the first and last day of a range. */
export function slotOptions(single: boolean, which: "start" | "end", halfDay: boolean): { value: Slot; label: string }[] {
  if (!halfDay) return [{ value: "FULL", label: "Full day" }];
  if (single) return [
    { value: "FULL", label: "Full day" },
    { value: "AM", label: "First half" },
    { value: "PM", label: "Second half" },
  ];
  return which === "start"
    ? [{ value: "FULL", label: "Full day" }, { value: "PM", label: "From second half" }]
    : [{ value: "FULL", label: "Full day" }, { value: "AM", label: "Until first half" }];
}

/** Keeps slots valid after the dates or type change (as _normalizeSlots). */
export function normalizeSlots(start: Slot, end: Slot, single: boolean, halfDay: boolean): { start: Slot; end: Slot } {
  if (!halfDay) return { start: "FULL", end: "FULL" };
  if (single) return { start, end: start };
  return { start: start === "AM" ? "FULL" : start, end: end === "PM" ? "FULL" : end };
}

export interface LeaveForm {
  typeId: string;
  start: string;
  end: string;
  reason: string;
  hasAttachment: boolean;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s: string) => YMD.test(s) && !Number.isNaN(Date.parse(s));

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/** Client checks before asking the server; the server checks everything again. */
export function leaveFormErrors(f: LeaveForm, type: LeaveType | undefined, today: string): Record<string, string> {
  const e: Record<string, string> = {};
  if (!f.typeId || !type) e.leave_type_id = "Choose a leave type.";
  if (!isDate(f.start)) e.start_date = "Choose the first day.";
  if (!isDate(f.end)) e.end_date = "Choose the last day.";
  else if (isDate(f.start) && f.end < f.start) e.end_date = "The last day must be on or after the first day.";
  if (type && isDate(f.start)) {
    if (type.backdate_days != null && dayDiff(f.start, today) > type.backdate_days)
      e.start_date = type.backdate_days === 0 ? "This leave cannot start in the past." : `This leave can start at most ${type.backdate_days} day(s) ago.`;
    else if (type.advance_notice_days && dayDiff(today, f.start) < type.advance_notice_days)
      e.start_date = `Apply at least ${type.advance_notice_days} day(s) ahead.`;
    if (!e.end_date && isDate(f.end) && type.max_consecutive_days && dayDiff(f.start, f.end) + 1 > type.max_consecutive_days)
      e.end_date = `At most ${type.max_consecutive_days} days in one request.`;
    if (type.requires_attachment && !f.hasAttachment) e.attachment = "Attach a supporting document.";
  }
  const r = f.reason.trim();
  if (r.length < 3) e.reason = "Tell your approver why (at least 3 characters).";
  else if (r.length > 500) e.reason = "Keep it under 500 characters.";
  return e;
}

/** Balance left after this request; null when the type has no cap. */
export function balanceAfter(available: number | null | undefined, units: number | null | undefined): number | null {
  if (available == null || units == null) return null;
  return available - units;
}

/** Maps server field names (start_slot, attachment_file_version_id…) onto form fields. */
export function mapLeaveFields(f: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) {
    const key = k === "start_slot" ? "start_date" : k === "end_slot" ? "end_date" : k === "attachment_file_version_id" ? "attachment" : k === "dates" ? "start_date" : k;
    out[key] ??= v;
  }
  return out;
}

/** Published holidays of the year sorted by date, split around `today`. */
export function splitHolidays(list: Holiday[], today: string): { upcoming: Holiday[]; past: Holiday[] } {
  const pub = list.filter((h) => h.state === "published").sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return { upcoming: pub.filter((h) => h.date >= today), past: pub.filter((h) => h.date < today) };
}

/** Stable illustration for a holiday (holidayIllustrationNumber). */
const HOLIDAY_ART = [12, 3, 18, 7, 15, 1, 20, 9, 5, 14, 2, 17, 11, 21, 6, 16, 4, 13, 8, 19, 10];
export function holidayArt(index: number, year: number): string {
  const n = HOLIDAY_ART[(index + (year % HOLIDAY_ART.length)) % HOLIDAY_ART.length];
  return `holiday${n}`;
}

/** Share of the allocation used (0..1) for a balance bar; 0 when nothing is allocated. */
export function usedShare(b: Pick<Balance, "allocated_units" | "used_units" | "reserved_units">): number {
  if (b.allocated_units <= 0) return 0;
  return Math.min(1, Math.max(0, (b.used_units + b.reserved_units) / b.allocated_units));
}
