// Attendance display helpers (attendance_ui.dart / format.dart). Meaning is
// always carried in text; colour only reinforces it.

import type { Tone } from "@/components/ui";

export interface DayRow {
  employee_id: string;
  shift_date: string;
  instance_id: string | null;
  kind: string;
  is_required: boolean;
  status: string;
  start_at: string | null;
  end_at: string | null;
  timezone: string;
  session_id: string | null;
  session_state: string | null;
  effective_in_at: string | null;
  effective_out_at: string | null;
  effective_source: string | null;
  leave_slots: number;
  required_seconds: number;
  presence_seconds: number;
  credited_seconds: number;
  shortfall_seconds: number;
  extra_seconds: number;
  is_late: boolean;
  late_seconds: number;
  is_early_departure: boolean;
  early_seconds: number;
  late_excused?: boolean;
}

export interface Totals {
  required_seconds: number;
  credited_seconds: number;
  shortfall_seconds: number;
  extra_seconds: number;
  present_days: number;
  absent_days: number;
  late_days: number;
  leave_days: number;
  wfh_days?: number;
  outside_days?: number;
  unresolved_days: number;
}

export interface Shift extends DayRow {
  checkin_opens_at: string | null;
  checkin_closes_at: string | null;
  office: { id: string; name: string; radius_m: number; latitude: number; longitude: number; active: boolean } | null;
  next_action: "IN" | "OUT" | null;
  blocked_reason: string | null;
}

export function dayStatus(r: Pick<DayRow, "status" | "effective_source" | "is_late">): { label: string; tone: Tone } {
  const src = r.effective_source;
  switch (r.status) {
    case "upcoming":
      if (src === "outside") return { label: "Outside work", tone: "info" };
      if (src === "wfh") return { label: "Work from home", tone: "info" };
      return { label: "Upcoming", tone: "neutral" };
    case "present":
      if (src === "outside") return { label: "Outside work", tone: "success" };
      if (src === "wfh") return { label: "Work from home", tone: "success" };
      return r.is_late ? { label: "Present · late", tone: "warning" } : { label: "Present", tone: "success" };
    case "in_progress":
      return { label: "In progress", tone: "info" };
    case "needs_correction":
      return { label: "Needs correction", tone: "error" };
    case "absent":
      return { label: "Absent", tone: "error" };
    case "leave":
      return { label: "Leave", tone: "info" };
    case "holiday":
      return { label: "Holiday", tone: "neutral" };
    case "weekly_off":
      return { label: "Weekly off", tone: "neutral" };
    case "day_off":
      return { label: "Day off", tone: "neutral" };
    case "not_yet_in":
      return { label: "Not yet in", tone: "warning" };
    default:
      return { label: r.status || "—", tone: "neutral" };
  }
}

export function sourceLabel(source: string | null | undefined): string {
  switch (source) {
    case "manual":
      return "Manual (approved correction)";
    case "mixed":
      return "Corrected";
    case "outside":
      return "Outside work (assigned by HR/Admin)";
    case "wfh":
      return "Work from home (approved request)";
    default:
      return "Location verified";
  }
}

export function leaveSlotLabel(slots: number): string {
  return slots === 1 ? "AM leave" : slots === 2 ? "PM leave" : slots === 3 ? "Full-day leave" : "";
}

/** "7h 05m", "45m", "0m"; negative values are shown as their magnitude. */
export function duration(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(Math.abs(seconds ?? 0)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/** Wall-clock time in the shift's timezone, e.g. "9:58 AM". */
export function clock(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone }).format(d).toUpperCase();
}

/** "Fri, 14 Nov" for a YYYY-MM-DD date (calendar date, no timezone shift). */
export function dayLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(date);
}

export function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** First and last day of the month containing `ymdStr`, shifted by `delta` months. */
export function monthRange(ymdStr: string, delta = 0): { from: string; to: string; label: string } {
  const [y, m] = ymdStr.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + delta, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  const label = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(first);
  return { from: ymd(first), to: ymd(last), label };
}

/** Today's calendar date in an IANA timezone. */
export function todayIn(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Why the punch button is not available, in plain words. */
export function blockedText(reason: string | null | undefined, shift?: Pick<Shift, "checkin_opens_at" | "timezone"> | null): string | null {
  switch (reason) {
    case null:
    case undefined:
      return null;
    case "outside_work":
      return "You are marked as working outside today. No punch is needed.";
    case "work_from_home":
      return "Work from home is approved for today. No punch is needed.";
    case "on_leave":
      return "You are on approved leave today.";
    case "holiday":
      return "Today is a holiday.";
    case "weekly_off":
    case "day_off":
      return "Today is not a working day for you.";
    case "no_office":
      return "You are not assigned to an office. Contact HR.";
    case "not_open_yet":
      return shift?.checkin_opens_at
        ? `Check-in opens at ${clock(shift.checkin_opens_at, shift.timezone)}.`
        : "Check-in is not open yet.";
    case "window_closed":
      return "The check-in window has closed. Request a correction if you were at work.";
    case "completed":
      return "You have checked out for today.";
    case "needs_correction":
      return "This day needs a correction. Request one from the day's details.";
    default:
      return "Punching is not available right now.";
  }
}

/** Validation for a correction request (mirrors correction_screen.dart). */
export function correctionErrors(input: { date: string; inTime: string; outTime: string; reason: string }, today: string): Record<string, string> {
  const e: Record<string, string> = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) e.date = "Choose a date.";
  else if (input.date > today) e.date = "You can only correct past or current days.";
  if (!/^\d{2}:\d{2}$/.test(input.inTime)) e.inTime = "Enter the check-in time.";
  if (!/^\d{2}:\d{2}$/.test(input.outTime)) e.outTime = "Enter the check-out time.";
  if (!e.inTime && !e.outTime && input.outTime === input.inTime) e.outTime = "Check-out must differ from check-in.";
  const reason = input.reason.trim();
  if (reason.length < 5) e.reason = "Tell HR what happened (at least 5 characters).";
  else if (reason.length > 500) e.reason = "Keep it under 500 characters.";
  return e;
}

/** A check-out earlier than check-in is on the next day (night shifts). */
export function correctionInstants(date: string, inTime: string, outTime: string, timeZone: string): { inAt: string; outAt: string; overnight: boolean } {
  const overnight = outTime < inTime;
  const outDate = overnight ? addDays(date, 1) : date;
  return { inAt: zonedIso(date, inTime, timeZone), outAt: zonedIso(outDate, outTime, timeZone), overnight };
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return ymd(new Date(Date.UTC(y, m - 1, d + n)));
}

/** Local wall time on a calendar date in a timezone -> ISO instant. */
export function zonedIso(date: string, time: string, timeZone: string): string {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  // Start from the naive UTC instant, then correct by the zone offset at that instant (twice for DST edges).
  let t = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date(t));
    const g = (k: string) => Number(p.find((x) => x.type === k)?.value);
    const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"));
    t += Date.UTC(y, mo - 1, d, h, mi) - asUtc;
  }
  return new Date(t).toISOString();
}
