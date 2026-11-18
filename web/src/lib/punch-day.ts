// The punch flow around the attendance machines: the person's day, punching
// out from the app, outdoor punch-in with a photo, and fix requests. The
// database checks every rule again.

import type { Tone } from "@/components/ui";
import type { PersonRef } from "./tasks";

export type OutSource = "device" | "auto" | "hr" | "app" | null;

export interface Outdoor {
  id: string;
  work_date: string;
  reason: string;
  punch_in_at: string;
  punch_out_at: string | null;
  photo_file_version_id: string;
  latitude: number | null;
  longitude: number | null;
  status: "counted" | "rejected";
  rejected_at: string | null;
  reject_reason: string | null;
  rejected_by: string | null;
  employee: PersonRef;
  can_reject: boolean;
}

export interface PunchFix {
  id: string;
  date: string;
  in_at: string | null;
  out_at: string | null;
  reason: string;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  created_at: string;
  reviewed_at: string | null;
  review_note: string | null;
  reviewed_by: string | null;
  employee: PersonRef;
  day: { first_in_at: string | null; out_at: string | null; out_source: OutSource } | null;
  can_review: boolean;
  can_withdraw: boolean;
}

export interface PunchDay {
  date: string;
  is_today: boolean;
  has_machines: boolean;
  day: {
    first_in_at: string;
    out_at: string | null;
    out_source: OutSource;
    worked_minutes: number | null;
    scan_count: number;
    machine: string | null;
    machine_in_at: string | null;
    in_corrected: boolean;
    app_out_reason: string | null;
    correction_reason: string | null;
  } | null;
  outdoor: Outdoor | null;
  fix: PunchFix | null;
  can_app_out: boolean;
  can_outdoor_in: boolean;
  can_request_fix: boolean;
}

export const FIX_STATUS: Record<PunchFix["status"], { label: string; tone: Tone }> = {
  pending: { label: "Waiting for HR", tone: "warning" },
  approved: { label: "Fixed", tone: "success" },
  rejected: { label: "Not accepted", tone: "error" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};

export const OUT_SOURCE: Record<Exclude<OutSource, null>, string> = {
  device: "at the machine",
  app: "from the app",
  hr: "set by HR",
  auto: "closed automatically (no punch-out)",
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "HH:MM" in the org time zone for an instant. */
export function clockIn(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone });
}

/** "9:05 am" for display. */
export function niceTime(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone });
}

export interface PunchOutForm {
  time: string; // "" = now (today only)
  reason: string;
}

/** An earlier time (or another day) needs a reason; "now" does not. */
export function punchOutErrors(f: PunchOutForm, o: { isToday: boolean; nowClock: string; inClock: string }): Partial<Record<keyof PunchOutForm, string>> {
  const e: Partial<Record<keyof PunchOutForm, string>> = {};
  if (!f.time) {
    if (!o.isToday) e.time = "Enter the time you left.";
  } else if (!TIME.test(f.time)) e.time = "Enter a time like 18:30.";
  else if (o.inClock && f.time <= o.inClock) e.time = `It must be after your punch-in at ${o.inClock}.`;
  else if (o.isToday && f.time > o.nowClock) e.time = "That time has not come yet.";
  if (needsReason(f, o) && f.reason.trim().length < 3) e.reason = "Say why you are setting an earlier time.";
  return e;
}

export function needsReason(f: PunchOutForm, o: { isToday: boolean; nowClock: string }): boolean {
  if (!o.isToday) return true;
  if (!f.time || !TIME.test(f.time)) return false;
  const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  return mins(o.nowClock) - mins(f.time) > 15;
}

export interface FixForm {
  in_time: string;
  out_time: string;
  reason: string;
}

export function fixErrors(f: FixForm): Partial<Record<keyof FixForm, string>> {
  const e: Partial<Record<keyof FixForm, string>> = {};
  if (!f.in_time && !f.out_time) e.in_time = "Enter the right punch-in or punch-out time.";
  if (f.in_time && !TIME.test(f.in_time)) e.in_time = "Enter a time like 09:30.";
  if (f.out_time && !TIME.test(f.out_time)) e.out_time = "Enter a time like 18:30.";
  if (!e.in_time && !e.out_time && f.in_time && f.out_time && f.out_time <= f.in_time) e.out_time = "The punch-out must be after the punch-in.";
  const r = f.reason.trim();
  if (r.length < 5) e.reason = "Say what went wrong (at least 5 characters).";
  else if (r.length > 500) e.reason = "Keep it under 500 characters.";
  return e;
}

export function outdoorErrors(f: { reason: string; photo: File | null }): Partial<Record<"reason" | "photo", string>> {
  const e: Partial<Record<"reason" | "photo", string>> = {};
  const r = f.reason.trim();
  if (r.length < 5) e.reason = "Say where you are and what the work is.";
  else if (r.length > 500) e.reason = "Keep it under 500 characters.";
  if (!f.photo) e.photo = "Take a photo as proof.";
  return e;
}

/** Best-effort location (null when refused, unavailable or slow). */
export function roughLocation(timeoutMs = 8000): Promise<{ latitude: number; longitude: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
    const timer = setTimeout(() => resolve(null), timeoutMs + 500);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(timer);
        resolve({ latitude: Number(p.coords.latitude.toFixed(6)), longitude: Number(p.coords.longitude.toFixed(6)) });
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}
