// Tasks and daily work reports: types and the rules the screens apply before
// sending (the database checks every one again).

import type { Tone } from "@/components/ui";

export type TaskStatus = "todo" | "in_progress" | "done" | "cancelled";
export type Priority = "low" | "normal" | "high";

export interface PersonRef {
  id: string;
  code: string;
  name: string;
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  priority: Priority;
  status: TaskStatus;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  assigned_to: PersonRef;
  assigned_by: PersonRef;
  is_mine: boolean;
  can_manage: boolean;
  overdue: boolean;
  logged_minutes: number;
  logs?: WorkLog[];
}

export interface WorkLog {
  id: string;
  work_date: string;
  title: string;
  details: string;
  minutes: number | null;
  task: { id: string; title: string } | null;
  created_at: string;
  updated_at: string;
  version: number;
  can_edit: boolean;
}

export interface TeamWorkRow {
  employee: PersonRef & { tier: number };
  total_minutes: number;
  entries: WorkLog[];
  open_tasks: number;
}

export interface WorkAccess {
  can_view_team: boolean;
  leads_teams: number;
  can_assign_others: boolean;
}

export const STATUS: Record<TaskStatus, { label: string; tone: Tone }> = {
  todo: { label: "To do", tone: "neutral" },
  in_progress: { label: "In progress", tone: "info" },
  done: { label: "Done", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export const PRIORITY: Record<Priority, { label: string; tone: Tone }> = {
  high: { label: "High", tone: "error" },
  normal: { label: "Normal", tone: "neutral" },
  low: { label: "Low", tone: "neutral" },
};

export const TIER_LABEL = ["Employee", "Team leader", "HR", "Admin"] as const;

/** "1.5" or "1:30" or "90m" → minutes; "" → null; invalid → NaN. */
export function parseDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{1,2}):([0-5]\d)$/))) return Number(m[1]) * 60 + Number(m[2]);
  if ((m = s.match(/^(\d{1,4})\s*m(in)?$/))) return Number(m[1]);
  if ((m = s.match(/^(\d{1,2}(\.\d{1,2})?)\s*h?$/))) return Math.round(Number(m[1]) * 60);
  return Number.NaN;
}

/** 90 → "1 h 30 m", 45 → "45 m", 120 → "2 h". */
export function minutesLabel(min: number | null | undefined): string {
  if (!min) return "";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return [h ? `${h} h` : "", m ? `${m} m` : ""].filter(Boolean).join(" ");
}

export interface TaskForm {
  assigned_to: string;
  title: string;
  description: string;
  due_date: string;
  priority: Priority;
}

export function taskErrors(f: TaskForm, today: string): Partial<Record<keyof TaskForm, string>> {
  const e: Partial<Record<keyof TaskForm, string>> = {};
  if (!f.assigned_to) e.assigned_to = "Choose who does it.";
  const t = f.title.trim();
  if (t.length < 2) e.title = "Give the task a title.";
  else if (t.length > 200) e.title = "Keep the title under 200 characters.";
  if (f.description.length > 4000) e.description = "Keep it under 4000 characters.";
  if (f.due_date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.due_date) || Number.isNaN(Date.parse(f.due_date))) e.due_date = "Pick a valid date.";
    else if (f.due_date < today) e.due_date = "The due date cannot be in the past.";
    else if (f.due_date > addDays(today, 366)) e.due_date = "Pick a date within a year.";
  }
  return e;
}

export interface WorkForm {
  work_date: string;
  title: string;
  details: string;
  duration: string;
  task_id: string;
}

export function workErrors(f: WorkForm, today: string): Partial<Record<keyof WorkForm, string>> {
  const e: Partial<Record<keyof WorkForm, string>> = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.work_date) || f.work_date > today || f.work_date < addDays(today, -7)) e.work_date = "Pick today or one of the last 7 days.";
  const t = f.title.trim();
  if (t.length < 2) e.title = "Say what you worked on.";
  else if (t.length > 200) e.title = "Keep the title under 200 characters.";
  const d = f.details.trim();
  if (d.length < 2) e.details = "Describe the work in detail.";
  else if (d.length > 4000) e.details = "Keep it under 4000 characters.";
  const min = parseDuration(f.duration);
  if (min !== null && (Number.isNaN(min) || min < 1 || min > 1440)) e.duration = "Use hours like 1.5 or 1:30 (up to 24 h).";
  return e;
}

/** YYYY-MM-DD plus n days (calendar arithmetic, no time zone). */
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "Due today", "Due tomorrow", "Due 3 Dec", "Overdue · 2 Dec", or "" without a date. */
export function dueLabel(t: Pick<Task, "due_date" | "status">, today: string): string {
  if (!t.due_date) return "";
  const nice = new Date(`${t.due_date}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
  const open = t.status === "todo" || t.status === "in_progress";
  if (open && t.due_date < today) return `Overdue · ${nice}`;
  if (t.due_date === today) return "Due today";
  if (t.due_date === addDays(today, 1)) return "Due tomorrow";
  return `Due ${nice}`;
}

/** The status buttons the assignee sees. */
export function nextStatuses(s: TaskStatus): { to: TaskStatus; label: string }[] {
  switch (s) {
    case "todo":
      return [{ to: "in_progress", label: "Start" }, { to: "done", label: "Mark done" }];
    case "in_progress":
      return [{ to: "done", label: "Mark done" }, { to: "todo", label: "Back to to do" }];
    case "done":
      return [{ to: "in_progress", label: "Reopen" }];
    default:
      return [];
  }
}
