// Request helpers shared by My requests and the review queue
// (request_widgets.dart). Meaning is carried in text; tone only reinforces it.

import type { Tone } from "@/components/ui";
import { clock, dayLabel } from "./attendance";

export interface Person {
  id: string;
  code: string;
  name: string;
}

export interface RequestRow {
  id: string;
  kind: string;
  state: string;
  version: number;
  employee: Person;
  target_employee: Person | null;
  leave_type: { id: string; code: string; name: string } | null;
  start_date: string | null;
  end_date: string | null;
  target_shift_date: string | null;
  units: number | null;
  edited: boolean;
  current_revision: number;
  change_category: string | null;
  request_mode: string | null;
  reviewer_assigned: boolean;
  first_opened_at: string | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RequestEvent {
  action: string;
  actor: Person | null;
  created_at: string;
  from_state: string | null;
  to_state: string | null;
  reason: string | null;
  revision_no: number | null;
}

export interface Revision {
  revision_no: number;
  created_at: string;
  payload: Record<string, unknown>;
}

export interface RequestDetail extends RequestRow {
  events: RequestEvent[];
  revisions: Revision[];
  reviewer?: Person | null;
  reserved_units?: number;
  debited_units?: number;
  credited_back_units?: number;
  approved_revision?: number | null;
  locked_revision?: number | null;
  /** Only from open_request_for_review. */
  authority?: "assigned" | "admin" | string;
  attendance_conflicts?: number;
  balance?: { available: number | null; leave_year: number; valid_to: string }[];
}

export const STATE: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  submitted: { label: "Submitted", tone: "info" },
  under_review: { label: "In review", tone: "warning" },
  returned: { label: "Returned for changes", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  rejected: { label: "Not approved", tone: "error" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  withdrawal_pending: { label: "Withdrawal pending", tone: "warning" },
  cancellation_pending: { label: "Cancellation pending", tone: "warning" },
};
export function stateOf(s: string): { label: string; tone: Tone } {
  return STATE[s] ?? { label: s.replace(/_/g, " "), tone: "neutral" };
}

export const KIND_LABEL: Record<string, string> = {
  leave: "Leave",
  correction: "Attendance correction",
  late_excuse: "Late arrival excuse",
  wfh: "Work from home",
  comp_off: "Comp-off",
  bank_details: "Salary account",
  profile_details: "Profile details",
  employee_details: "Employee details",
  employee_assignment: "Assignment change",
  employee_status: "Status change",
  salary_change: "Salary change",
  payslip_publish: "Payslip publish",
};

export const KIND_ART: Record<string, { tile: string; art: string }> = {
  leave: { tile: "bg-leave-card", art: "beach" },
  correction: { tile: "bg-attendance-card", art: "schedule" },
  late_excuse: { tile: "bg-warning-soft", art: "schedule" },
  wfh: { tile: "bg-people-card", art: "home" },
  comp_off: { tile: "bg-leave-card", art: "event_available" },
  bank_details: { tile: "bg-salary-card", art: "bank" },
};

/** "Casual Leave", "Work from home"… */
export function requestTitle(r: Pick<RequestRow, "kind" | "leave_type">): string {
  if (r.kind === "leave" && r.leave_type) return r.leave_type.name;
  return KIND_LABEL[r.kind] ?? r.kind.replace(/_/g, " ");
}

/** "Wed 18 Nov", "Wed 18 Nov – Thu 19 Nov" or "" when the request has no dates. */
export function requestDates(r: Pick<RequestRow, "start_date" | "end_date" | "target_shift_date">): string {
  const s = r.start_date ?? r.target_shift_date;
  if (!s) return "";
  const e = r.end_date;
  return !e || e === s ? dayLabel(s) : `${dayLabel(s)} – ${dayLabel(e)}`;
}

export const EVENT_LABEL: Record<string, string> = {
  submitted: "Submitted",
  resubmitted: "Resubmitted",
  edited: "Edited",
  opened: "Opened for review",
  approved: "Approved",
  auto_approved: "Approved (Admin, no approver needed)",
  revoked: "Revoked",
  rejected: "Not approved",
  returned: "Returned for changes",
  withdrawn: "Withdrawn",
  withdrawal_requested: "Withdrawal requested",
  withdrawal_accepted: "Withdrawal accepted",
  withdrawal_declined: "Withdrawal declined",
  cancellation_requested: "Cancellation requested",
  cancellation_approved: "Cancellation approved",
  cancellation_declined: "Cancellation declined",
  reassigned: "Reassigned",
  holiday_reconciled: "Adjusted for a new holiday",
};
export function eventLabel(a: string): string {
  return EVENT_LABEL[a] ?? a.replace(/_/g, " ");
}

/** What the requester may do with their own request. */
export function ownerActions(r: Pick<RequestRow, "kind" | "state">, isAdmin: boolean) {
  const editable = r.state === "draft" || r.state === "submitted" || r.state === "returned";
  return {
    edit: editable && (r.kind === "leave" || r.kind === "correction" || r.kind === "wfh" || r.kind === "late_excuse" || r.kind === "comp_off"),
    editLabel: r.state === "returned" ? "Edit & resubmit" : "Edit",
    withdraw: editable || r.state === "under_review",
    /** Under review the approver has to accept a withdrawal. */
    withdrawNeedsApproval: r.state === "under_review",
    withdrawLabel: r.state === "under_review" ? "Request withdrawal" : "Withdraw",
    cancel: r.state === "approved" && r.kind === "leave",
    cancelLabel: isAdmin ? "Revoke leave" : "Request cancellation",
  };
}

export function editHref(r: Pick<RequestRow, "kind" | "id">): string | null {
  switch (r.kind) {
    case "leave":
      return `/leave/apply?edit=${r.id}`;
    case "wfh":
      return `/requests/new/wfh?edit=${r.id}`;
    case "late_excuse":
      return `/requests/new/late?edit=${r.id}`;
    case "comp_off":
      return `/requests/new/comp-off?edit=${r.id}`;
    case "correction":
      return `/corrections/new?edit=${r.id}`;
    default:
      return null;
  }
}

export type Decision = "approve" | "reject" | "return";

/** Which reviewer controls show for a request in `state`. */
export function reviewerPanel(state: string, mayDecide: boolean): "decide" | "withdrawal" | "cancellation" | "readonly" | "none" {
  const pending = state === "under_review" || state === "withdrawal_pending" || state === "cancellation_pending";
  if (!pending) return "none";
  if (!mayDecide) return "readonly";
  return state === "under_review" ? "decide" : state === "withdrawal_pending" ? "withdrawal" : "cancellation";
}

/** Reject and return always need a reason; so does any Admin fallback decision. */
export function reasonRequired(decision: Decision | "accept" | "decline", adminFallback: boolean): boolean {
  if (decision === "reject" || decision === "return" || decision === "decline") return true;
  return adminFallback;
}

export function reasonError(reason: string, required: boolean): string | null {
  const r = reason.trim();
  if (required && r.length === 0) return "A reason is required.";
  if (r.length > 500) return "Keep it under 500 characters.";
  return null;
}

/** Keyset cursor for the next page, or null when the page wasn't full. */
export function nextCursor<T extends { id: string }>(rows: T[], limit: number, key: (r: T) => string | null): { at: string; id: string } | null {
  if (rows.length === 0 || rows.length < limit) return null;
  const last = rows[rows.length - 1];
  const at = key(last);
  return at ? { at, id: last.id } : null;
}

/** Appends a page, dropping rows already shown (a row can move between pages). */
export function appendPage<T extends { id: string }>(shown: T[], page: T[]): T[] {
  const seen = new Set(shown.map((r) => r.id));
  return shown.concat(page.filter((r) => !seen.has(r.id)));
}

/** my_requests_screen.dart: kind pills along the top… */
export const MY_KINDS = [
  { id: "", label: "All" },
  { id: "leave", label: "Leave" },
  { id: "correction", label: "Corrections" },
  { id: "wfh", label: "Work from home" },
  { id: "late_excuse", label: "Late" },
  { id: "bank_details", label: "Bank" },
] as const;

/** …and a Status filter sheet behind the filter button. */
export const MY_STATES = [
  { id: "", label: "All" },
  { id: "active", label: "Active" },
  { id: "returned", label: "Returned" },
  { id: "completed", label: "Completed" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Not approved" },
  { id: "cancelled", label: "Cancelled" },
] as const;

export function myEmptyTitle(state: string): string {
  if (!state) return "No requests yet";
  const label = MY_STATES.find((s) => s.id === state)?.label ?? state;
  return `No ${label.toLowerCase()} requests`;
}

export const REVIEW_KINDS = [
  { id: "", label: "All" },
  { id: "leave", label: "Leave" },
  { id: "correction", label: "Fixes" },
  { id: "wfh", label: "WFH" },
  { id: "late_excuse", label: "Late" },
  { id: "comp_off", label: "Comp-off" },
] as const;

/** Reads a string field from a revision payload. */
export function payloadText(p: Record<string, unknown> | undefined, k: string): string | null {
  const v = p?.[k];
  return typeof v === "string" && v.trim() ? v : null;
}

/** The last revision's payload, or {} when there is none. */
export function currentPayload(r: Pick<RequestDetail, "revisions">): Record<string, unknown> {
  const revs = r.revisions ?? [];
  return revs.length ? (revs[revs.length - 1].payload ?? {}) : {};
}

/** The reason given on the most recent "returned" event. */
export function returnReason(r: Pick<RequestDetail, "events" | "state">): string | null {
  if (r.state !== "returned") return null;
  for (let i = (r.events?.length ?? 0) - 1; i >= 0; i--) if (r.events[i].action === "returned") return r.events[i].reason;
  return null;
}

/** "18 Nov, 10:37" in the org time zone. */
export function stamp(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone }).format(d);
  return `${day}, ${clock(iso, timeZone)}`;
}

const FIELD_LABEL: Record<string, string> = {
  shift_date: "Day",
  proposed_in_at: "Checked in at",
  proposed_out_at: "Checked out at",
  personal_email: "Personal email",
  personal_phone: "Personal phone",
  address: "Address",
  emergency_contact_name: "Emergency contact name",
  emergency_contact_phone: "Emergency contact phone",
  date_of_birth: "Date of birth",
  account_holder_name: "Account holder",
  bank_name: "Bank",
  ifsc: "IFSC",
  account_last4: "Account ending",
};
/** Keys shown elsewhere on the detail screen, or internal. */
const HIDDEN = new Set([
  "reason", "days", "units", "start_date", "end_date", "start_slot", "end_slot", "leave_type_id", "leave_type_code",
  "leave_type_name", "attachment_file_version_id", "kind", "employee_id", "target_employee_id", "account_number",
]);

/** Human rows for a revision payload: known keys first, then other plain values. */
export function payloadRows(p: Record<string, unknown>, timeZone: string): { k: string; v: string }[] {
  const out: { k: string; v: string }[] = [];
  for (const [key, raw] of Object.entries(p)) {
    if (HIDDEN.has(key) || raw == null || raw === "" || typeof raw === "object") continue;
    const label = FIELD_LABEL[key] ?? key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
    let v = String(raw);
    if (key.endsWith("_at") && typeof raw === "string") v = stamp(raw, timeZone);
    else if ((key.endsWith("_date") || key === "date_of_birth") && /^\d{4}-\d{2}-\d{2}$/.test(v)) v = dayLabel(v);
    else if (typeof raw === "boolean") v = raw ? "Yes" : "No";
    out.push({ k: label, v });
  }
  const rank = (k: string) => {
    const i = Object.values(FIELD_LABEL).indexOf(k);
    return i < 0 ? 999 : i;
  };
  return out.sort((a, b) => rank(a.k) - rank(b.k));
}
