// Home dashboard: the data shape of get_dashboard and the fixed shortcut
// catalogue shared by the sidebar and dashboard.

import type { Caps } from "./roles";

export interface DayPeople {
  total: number;
  punched_in: number;
  in_now: number;
  outdoor: number;
  on_leave: number;
  reports: number;
}

export interface Dashboard {
  date: string;
  has_machines: boolean;
  me: {
    today: { first_in_at: string | null; out_at: string | null; out_source: string | null; worked_minutes: number | null; outdoor: "counted" | "rejected" | null };
    month: { days: number; worked_minutes: number; missed_out: number };
    outdoor_days: number;
    week: { date: string; worked_minutes: number | null; in: boolean }[];
    tasks: { open: number; overdue: number; due_today: number };
    report_minutes_today: number;
    report_entries_today: number;
    open_requests: number;
    pending_fixes: number;
  };
  team: (DayPeople & { open_tasks: number; overdue_tasks: number }) | null;
  org:
    | (DayPeople & {
        waiting: { requests: number; punch_fixes: number; outdoor_today: number; machine_people: number };
        week: { date: string; punched_in: number; outdoor: number; on_leave: number }[];
      })
    | null;
}

export interface Shortcut {
  href: string;
  label: string;
  art: string;
}

const EVERYONE: Shortcut[] = [
  { href: "/attendance/today", label: "My punch", art: "tile_fix_punch" },
  { href: "/leave/apply", label: "Apply leave", art: "tile_apply_leave" },
  { href: "/tasks", label: "Tasks", art: "task_alt" },
  { href: "/work", label: "Daily report", art: "edit_note" },
  { href: "/attendance", label: "My attendance", art: "tile_my_attendance" },
  { href: "/requests", label: "My requests", art: "tile_my_requests" },
  { href: "/payslips", label: "Payslips", art: "receipt_long" },
  { href: "/holidays", label: "Holidays", art: "holiday_calendar" },
];

const HR: Shortcut[] = [
  { href: "/approvals", label: "Review requests", art: "tile_review_requests" },
  { href: "/attendance/fixes", label: "Punch fixes", art: "fact_check" },
  { href: "/employees", label: "Employees", art: "groups" },
  { href: "/devices", label: "Machines", art: "fingerprint" },
  { href: "/work?tab=team", label: "Team reports", art: "insights" },
  { href: "/attendance/outdoor", label: "Outdoor", art: "location" },
];

/** Stable for each role; visiting a page never changes its position or visibility. */
export function shortcutsFor(c: Pick<Caps, "isHrOrAdmin">): Shortcut[] {
  return c.isHrOrAdmin ? [...EVERYONE.slice(0, 4), ...HR, ...EVERYONE.slice(4)] : EVERYONE;
}

export const pct = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : 0);

/** "7 h 30 m" → "7.5 h" style compact hours for stat tiles. */
export function hoursLabel(minutes: number): string {
  if (!minutes) return "0 h";
  const h = minutes / 60;
  return `${h >= 10 ? Math.round(h) : Math.round(h * 10) / 10} h`;
}

export const weekday = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", timeZone: "UTC" });
