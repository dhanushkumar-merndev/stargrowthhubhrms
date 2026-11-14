import { describe, expect, it } from "vitest";
import {
  type LeaveType,
  balanceAfter,
  daysLabel,
  holidayArt,
  leaveFormErrors,
  mapLeaveFields,
  normalizeSlots,
  slotOptions,
  splitHolidays,
  usedShare,
} from "@/lib/leave";
import {
  type RequestDetail,
  type RequestRow,
  appendPage,
  currentPayload,
  editHref,
  eventLabel,
  nextCursor,
  ownerActions,
  payloadRows,
  payloadText,
  reasonError,
  reasonRequired,
  requestDates,
  requestTitle,
  returnReason,
  reviewerPanel,
  stamp,
  stateOf,
} from "@/lib/requests";

const type = (over: Partial<LeaveType> = {}): LeaveType => ({
  id: "cl", code: "CL", name: "Casual Leave", paid: true, active: true, half_day_allowed: true, requires_attachment: false,
  attachment_class: null, advance_notice_days: null, backdate_days: null, max_consecutive_days: null, version: 1, ...over,
});
const form = (over = {}) => ({ typeId: "cl", start: "2026-11-18", end: "2026-11-19", reason: "Family function", hasAttachment: false, ...over });
const TODAY = "2026-11-14";

describe("daysLabel", () => {
  it.each([
    [1, "½ day"],
    [2, "1 day"],
    [3, "1.5 days"],
    [24, "12 days"],
    [0, "0 days"],
    [-1, "-½ day"],
    [-2, "-1 day"],
    [-5, "-2.5 days"],
  ])("%d units → %s", (u, s) => expect(daysLabel(u)).toBe(s));
  it("handles missing and non-finite values", () => {
    expect(daysLabel(null)).toBe("—");
    expect(daysLabel(undefined)).toBe("—");
    expect(daysLabel(Number.NaN)).toBe("—");
    expect(daysLabel(Infinity)).toBe("—");
  });
});

describe("slots", () => {
  it("offers only Full day when half days are not allowed", () => {
    expect(slotOptions(true, "start", false)).toEqual([{ value: "FULL", label: "Full day" }]);
    expect(slotOptions(false, "end", false)).toHaveLength(1);
  });
  it("single day offers all three; a range offers PM start and AM end", () => {
    expect(slotOptions(true, "start", true).map((o) => o.value)).toEqual(["FULL", "AM", "PM"]);
    expect(slotOptions(false, "start", true).map((o) => o.value)).toEqual(["FULL", "PM"]);
    expect(slotOptions(false, "end", true).map((o) => o.value)).toEqual(["FULL", "AM"]);
  });
  it("normalizes impossible combinations", () => {
    expect(normalizeSlots("AM", "PM", false, true)).toEqual({ start: "FULL", end: "FULL" });
    expect(normalizeSlots("PM", "AM", false, true)).toEqual({ start: "PM", end: "AM" });
    expect(normalizeSlots("AM", "FULL", true, true)).toEqual({ start: "AM", end: "AM" });
    expect(normalizeSlots("PM", "AM", true, false)).toEqual({ start: "FULL", end: "FULL" });
  });
});

describe("leaveFormErrors", () => {
  it("accepts a valid form", () => expect(leaveFormErrors(form(), type(), TODAY)).toEqual({}));
  it("needs a type", () => {
    expect(leaveFormErrors(form({ typeId: "" }), undefined, TODAY).leave_type_id).toBeTruthy();
    expect(leaveFormErrors(form(), undefined, TODAY).leave_type_id).toBeTruthy();
  });
  it("rejects bad and reversed dates", () => {
    expect(leaveFormErrors(form({ start: "" }), type(), TODAY).start_date).toBeTruthy();
    expect(leaveFormErrors(form({ start: "2026-02-30x" }), type(), TODAY).start_date).toBeTruthy();
    expect(leaveFormErrors(form({ end: "nope" }), type(), TODAY).end_date).toBeTruthy();
    expect(leaveFormErrors(form({ start: "2026-11-20", end: "2026-11-19" }), type(), TODAY).end_date).toMatch(/on or after/);
  });
  it("same-day range is fine", () => expect(leaveFormErrors(form({ end: "2026-11-18" }), type(), TODAY)).toEqual({}));
  it("enforces backdating limits, including zero", () => {
    expect(leaveFormErrors(form({ start: "2026-11-13", end: "2026-11-13" }), type({ backdate_days: 0 }), TODAY).start_date).toMatch(/past/);
    expect(leaveFormErrors(form({ start: "2026-11-14", end: "2026-11-14" }), type({ backdate_days: 0 }), TODAY)).toEqual({});
    expect(leaveFormErrors(form({ start: "2026-11-10", end: "2026-11-10" }), type({ backdate_days: 3 }), TODAY).start_date).toMatch(/3 day/);
    expect(leaveFormErrors(form({ start: "2026-11-11", end: "2026-11-11" }), type({ backdate_days: 3 }), TODAY)).toEqual({});
    expect(leaveFormErrors(form({ start: "2025-01-01", end: "2025-01-01" }), type({ backdate_days: null }), TODAY)).toEqual({});
  });
  it("enforces advance notice at the boundary", () => {
    expect(leaveFormErrors(form({ start: "2026-11-16", end: "2026-11-16" }), type({ advance_notice_days: 3 }), TODAY).start_date).toMatch(/3 day/);
    expect(leaveFormErrors(form({ start: "2026-11-17", end: "2026-11-17" }), type({ advance_notice_days: 3 }), TODAY)).toEqual({});
  });
  it("enforces max consecutive days inclusively", () => {
    expect(leaveFormErrors(form({ start: "2026-11-18", end: "2026-11-20" }), type({ max_consecutive_days: 3 }), TODAY)).toEqual({});
    expect(leaveFormErrors(form({ start: "2026-11-18", end: "2026-11-21" }), type({ max_consecutive_days: 3 }), TODAY).end_date).toMatch(/3 days/);
  });
  it("needs an attachment when the type requires one", () => {
    expect(leaveFormErrors(form(), type({ requires_attachment: true }), TODAY).attachment).toBeTruthy();
    expect(leaveFormErrors(form({ hasAttachment: true }), type({ requires_attachment: true }), TODAY).attachment).toBeUndefined();
  });
  it("checks reason length after trimming", () => {
    expect(leaveFormErrors(form({ reason: "  ab  " }), type(), TODAY).reason).toBeTruthy();
    expect(leaveFormErrors(form({ reason: "abc" }), type(), TODAY).reason).toBeUndefined();
    expect(leaveFormErrors(form({ reason: "x".repeat(501) }), type(), TODAY).reason).toMatch(/500/);
  });
});

describe("balance and fields", () => {
  it("balanceAfter is null when uncapped or unknown", () => {
    expect(balanceAfter(null, 2)).toBeNull();
    expect(balanceAfter(4, undefined)).toBeNull();
    expect(balanceAfter(4, 6)).toBe(-2);
  });
  it("usedShare clamps and handles zero allocation", () => {
    expect(usedShare({ allocated_units: 0, used_units: 4, reserved_units: 0 })).toBe(0);
    expect(usedShare({ allocated_units: 24, used_units: 6, reserved_units: 6 })).toBe(0.5);
    expect(usedShare({ allocated_units: 4, used_units: 6, reserved_units: 0 })).toBe(1);
    expect(usedShare({ allocated_units: 4, used_units: -2, reserved_units: 0 })).toBe(0);
  });
  it("maps server fields onto the form, first message wins", () => {
    expect(mapLeaveFields({ start_slot: "Bad slot", start_date: "Too early", attachment_file_version_id: "Missing", reason: "Required" })).toEqual({
      start_date: "Bad slot",
      attachment: "Missing",
      reason: "Required",
    });
  });
});

describe("holidays", () => {
  const h = (id: string, date: string, state = "published", name = id) => ({ id, date, name, state, version: 1, office_id: null, office_name: null, source: null });
  it("keeps only published, sorted, split at today (today is upcoming)", () => {
    const s = splitHolidays([h("b", "2026-12-25"), h("a", "2026-01-26"), h("d", "2026-11-14"), h("x", "2026-10-02", "draft")], TODAY);
    expect(s.upcoming.map((x) => x.id)).toEqual(["d", "b"]);
    expect(s.past.map((x) => x.id)).toEqual(["a"]);
  });
  it("orders same-day holidays by name", () => {
    expect(splitHolidays([h("2", "2026-12-01", "published", "Zed"), h("1", "2026-12-01", "published", "Alpha")], TODAY).upcoming.map((x) => x.name)).toEqual(["Alpha", "Zed"]);
  });
  it("art is stable, in range and rotates by year", () => {
    expect(holidayArt(0, 2026)).toBe(holidayArt(0, 2026));
    for (let i = 0; i < 50; i++) expect(Number(holidayArt(i, 2026).slice(7))).toBeGreaterThanOrEqual(1);
    expect(new Set(Array.from({ length: 21 }, (_, i) => holidayArt(i, 2026))).size).toBe(21);
    expect(holidayArt(0, 2026)).not.toBe(holidayArt(0, 2027));
  });
});

const row = (over: Partial<RequestRow> = {}): RequestRow => ({
  id: "r1", kind: "leave", state: "submitted", version: 2, employee: { id: "e1", code: "EMP001", name: "Asha" }, target_employee: null,
  leave_type: { id: "cl", code: "CL", name: "Casual Leave" }, start_date: "2026-11-18", end_date: "2026-11-19", target_shift_date: null,
  units: 3, edited: false, current_revision: 1, change_category: null, request_mode: null, reviewer_assigned: true, first_opened_at: null,
  submitted_at: "2026-11-14T10:00:00Z", created_at: "2026-11-14T10:00:00Z", updated_at: "2026-11-14T10:00:00Z", ...over,
});

describe("request labels", () => {
  it("state labels, with a readable fallback", () => {
    expect(stateOf("under_review")).toEqual({ label: "In review", tone: "warning" });
    expect(stateOf("rejected").label).toBe("Not approved");
    expect(stateOf("brand_new_state")).toEqual({ label: "brand new state", tone: "neutral" });
  });
  it("titles", () => {
    expect(requestTitle(row())).toBe("Casual Leave");
    expect(requestTitle(row({ leave_type: null }))).toBe("Leave");
    expect(requestTitle(row({ kind: "wfh" }))).toBe("Work from home");
    expect(requestTitle(row({ kind: "mystery_kind" }))).toBe("mystery kind");
  });
  it("dates: range, single, shift date, none", () => {
    expect(requestDates(row())).toBe("Wed, 18 Nov – Thu, 19 Nov");
    expect(requestDates(row({ end_date: "2026-11-18" }))).toBe("Wed, 18 Nov");
    expect(requestDates(row({ end_date: null }))).toBe("Wed, 18 Nov");
    expect(requestDates(row({ start_date: null, end_date: null, target_shift_date: "2026-11-12" }))).toBe("Thu, 12 Nov");
    expect(requestDates(row({ start_date: null, end_date: null }))).toBe("");
  });
  it("event labels", () => {
    expect(eventLabel("auto_approved")).toMatch(/Admin/);
    expect(eventLabel("something_new")).toBe("something new");
  });
  it("stamp formats in the org zone and tolerates junk", () => {
    expect(stamp("2026-11-14T10:37:00Z", "Asia/Kolkata")).toMatch(/14 Nov, 4:07\s?PM/i);
    expect(stamp(null, "Asia/Kolkata")).toBe("—");
    expect(stamp("not a date", "Asia/Kolkata")).toBe("—");
  });
});

describe("owner actions", () => {
  it.each(["draft", "submitted", "returned"])("%s: edit and plain withdraw", (state) => {
    const a = ownerActions(row({ state }), false);
    expect(a.edit && a.withdraw && !a.withdrawNeedsApproval && !a.cancel).toBe(true);
    expect(a.withdrawLabel).toBe("Withdraw");
  });
  it("returned says Edit & resubmit", () => expect(ownerActions(row({ state: "returned" }), false).editLabel).toBe("Edit & resubmit"));
  it("under review: no edit, withdrawal needs approval", () => {
    const a = ownerActions(row({ state: "under_review" }), false);
    expect(a.edit).toBe(false);
    expect(a.withdrawNeedsApproval).toBe(true);
    expect(a.withdrawLabel).toBe("Request withdrawal");
  });
  it("approved leave can be cancelled; Admin revokes", () => {
    expect(ownerActions(row({ state: "approved" }), false)).toMatchObject({ cancel: true, cancelLabel: "Request cancellation", withdraw: false, edit: false });
    expect(ownerActions(row({ state: "approved" }), true).cancelLabel).toBe("Revoke leave");
  });
  it("approved corrections cannot be cancelled", () => expect(ownerActions(row({ state: "approved", kind: "correction" }), false).cancel).toBe(false));
  it.each(["rejected", "cancelled", "withdrawal_pending", "cancellation_pending"])("%s: nothing to do", (state) => {
    const a = ownerActions(row({ state }), false);
    expect(a.edit || a.withdraw || a.cancel).toBe(false);
  });
  it("bank details cannot be edited from here", () => expect(ownerActions(row({ kind: "bank_details" }), false).edit).toBe(false));
  it("edit links per kind", () => {
    expect(editHref(row())).toBe("/leave/apply?edit=r1");
    expect(editHref(row({ kind: "late_excuse" }))).toBe("/requests/new/late?edit=r1");
    expect(editHref(row({ kind: "correction" }))).toBe("/corrections/new?edit=r1");
    expect(editHref(row({ kind: "salary_change" }))).toBeNull();
  });
});

describe("reviewer rules", () => {
  it("panel per state", () => {
    expect(reviewerPanel("under_review", true)).toBe("decide");
    expect(reviewerPanel("withdrawal_pending", true)).toBe("withdrawal");
    expect(reviewerPanel("cancellation_pending", true)).toBe("cancellation");
    expect(reviewerPanel("under_review", false)).toBe("readonly");
    expect(reviewerPanel("approved", true)).toBe("none");
    expect(reviewerPanel("submitted", true)).toBe("none");
  });
  it("reasons: reject/return/decline always; approve only for Admin fallback", () => {
    expect(reasonRequired("reject", false)).toBe(true);
    expect(reasonRequired("return", false)).toBe(true);
    expect(reasonRequired("decline", false)).toBe(true);
    expect(reasonRequired("approve", false)).toBe(false);
    expect(reasonRequired("accept", false)).toBe(false);
    expect(reasonRequired("approve", true)).toBe(true);
  });
  it("reasonError", () => {
    expect(reasonError("   ", true)).toBeTruthy();
    expect(reasonError("", false)).toBeNull();
    expect(reasonError("ok", true)).toBeNull();
    expect(reasonError("x".repeat(501), false)).toMatch(/500/);
  });
});

describe("paging", () => {
  it("cursor only when the page was full", () => {
    const rows = [row({ id: "a" }), row({ id: "b", created_at: "2026-11-13T00:00:00Z" })];
    expect(nextCursor(rows, 3, (r) => r.created_at)).toBeNull();
    expect(nextCursor(rows, 2, (r) => r.created_at)).toEqual({ at: "2026-11-13T00:00:00Z", id: "b" });
    expect(nextCursor(rows, 2, () => null)).toBeNull();
    expect(nextCursor([] as RequestRow[], 0, (r) => r.created_at)).toBeNull();
  });
  it("appendPage drops duplicates but keeps order", () => {
    expect(appendPage([row({ id: "a" }), row({ id: "b" })], [row({ id: "b" }), row({ id: "c" })]).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("payloads", () => {
  const detail = (over: Partial<RequestDetail> = {}): RequestDetail => ({ ...row(), events: [], revisions: [], ...over });
  it("currentPayload uses the last revision", () => {
    expect(currentPayload(detail())).toEqual({});
    expect(currentPayload(detail({ revisions: [{ revision_no: 1, created_at: "", payload: { a: 1 } }, { revision_no: 2, created_at: "", payload: { a: 2 } }] }))).toEqual({ a: 2 });
  });
  it("payloadText ignores blanks and non-strings", () => {
    expect(payloadText({ reason: "  " }, "reason")).toBeNull();
    expect(payloadText({ reason: 4 }, "reason")).toBeNull();
    expect(payloadText({ reason: "Fever" }, "reason")).toBe("Fever");
    expect(payloadText(undefined, "reason")).toBeNull();
  });
  it("payloadRows formats known keys and hides internal ones", () => {
    const rows = payloadRows(
      { shift_date: "2026-11-12", proposed_in_at: "2026-11-12T03:30:00Z", reason: "x", days: [], leave_type_id: "cl", account_number: "123456789", overnight: true, note: null, extra_field: "hi" },
      "Asia/Kolkata",
    );
    expect(rows[0]).toEqual({ k: "Day", v: "Thu, 12 Nov" });
    expect(rows[1].k).toBe("Checked in at");
    expect(rows[1].v).toMatch(/9:00\s?AM/i);
    expect(rows.find((r) => r.k === "Overnight")?.v).toBe("Yes");
    expect(rows.find((r) => r.k === "Extra field")?.v).toBe("hi");
    expect(rows.map((r) => r.k).join()).not.toMatch(/reason|account|leave type/i);
  });
  it("returnReason takes the latest returned event, only while returned", () => {
    const events = [
      { action: "returned", reason: "first", actor: null, created_at: "", from_state: null, to_state: null, revision_no: 1 },
      { action: "resubmitted", reason: null, actor: null, created_at: "", from_state: null, to_state: null, revision_no: 2 },
      { action: "returned", reason: "second", actor: null, created_at: "", from_state: null, to_state: null, revision_no: 2 },
    ];
    expect(returnReason(detail({ state: "returned", events }))).toBe("second");
    expect(returnReason(detail({ state: "submitted", events }))).toBeNull();
    expect(returnReason(detail({ state: "returned", events: [] }))).toBeNull();
  });
});
