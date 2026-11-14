import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalDetail, MyRequestDetail, MyRequests, ReviewQueue } from "@/components/screens/requests";
import { SessionProvider } from "@/lib/session";
import { ctx, fail, mockFetch, ok } from "./helpers";

function wrap(ui: React.ReactNode) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SessionProvider>{ui}</SessionProvider>
    </SWRConfig>,
  );
}
afterEach(() => vi.unstubAllGlobals());

const ID = "11111111-1111-4111-8111-111111111111";
const row = (i: number, over: Record<string, unknown> = {}) => ({
  id: `r${i}`, kind: "leave", state: "submitted", version: 2, employee: { id: "e2", code: "EMP002", name: "Ravi Kumar" }, target_employee: null,
  leave_type: { id: "cl", code: "CL", name: "Casual Leave" }, start_date: "2026-11-18", end_date: "2026-11-19", target_shift_date: null, units: 3,
  edited: false, current_revision: 1, change_category: null, request_mode: null, reviewer_assigned: true, first_opened_at: null,
  submitted_at: `2026-11-${String(30 - (i % 28)).padStart(2, "0")}T10:00:00Z`, created_at: `2026-11-${String(30 - (i % 28)).padStart(2, "0")}T10:00:00Z`, updated_at: "", ...over,
});
const detail = (over: Record<string, unknown> = {}) => ({
  ...row(0, { id: ID }),
  reviewer: { id: "a1", code: "ADMIN1", name: "Demo Admin" },
  events: [{ action: "submitted", actor: { id: "e2", code: "EMP002", name: "Ravi Kumar" }, created_at: "2026-11-14T10:37:00Z", from_state: "draft", to_state: "submitted", reason: null, revision_no: 1 }],
  revisions: [{ revision_no: 1, created_at: "", payload: { reason: "Family function", days: [{ day: "2026-11-18", slot: "PM", units: 1 }, { day: "2026-11-19", slot: "FULL", units: 2 }] } }],
  ...over,
});
const session = (role: "employee" | "hr" | "admin") => ({ "/rpc/get_session_context": () => ok(ctx(role)) });

describe("My requests", () => {
  it("lists, filters by state and shows the empty text per filter", async () => {
    const calls = mockFetch({ ...session("employee"), "/rpc/list_my_requests": (b) => ok((b as { p_state: string | null }).p_state ? [] : [row(1), row(2, { kind: "wfh", leave_type: null, state: "approved", units: null })]) });
    wrap(<MyRequests />);
    expect(await screen.findByText("Casual Leave")).toBeInTheDocument();
    expect(screen.getByText("Work from home")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Casual Leave/ })).toHaveAttribute("href", "/requests/r1");
    await userEvent.click(screen.getByRole("tab", { name: "Completed" }));
    expect(await screen.findByText("Nothing completed yet")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/rpc/list_my_requests" && (c.body as { p_state: string }).p_state === "completed")).toBe(true);
    await userEvent.click(screen.getByRole("tab", { name: "Open" }));
    expect(await screen.findByText("Nothing open")).toBeInTheDocument();
  });

  it("pages with the keyset cursor and stops on a short page", async () => {
    const first = Array.from({ length: 25 }, (_, i) => row(i));
    const calls = mockFetch({
      ...session("employee"),
      "/rpc/list_my_requests": (b) => ok((b as { p_before_id?: string }).p_before_id ? [row(24), row(25), row(26)] : first),
    });
    wrap(<MyRequests />);
    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(27));
    const more = calls.find((c) => (c.body as { p_before_id?: string }).p_before_id)!;
    expect(more.body).toMatchObject({ p_before_id: "r24", p_before_created_at: first[24].created_at, p_limit: 25 });
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("a failed next page keeps the rows and offers the button again", async () => {
    mockFetch({
      ...session("employee"),
      "/rpc/list_my_requests": (b) => ((b as { p_before_id?: string }).p_before_id ? fail(500, "INTERNAL", "Page failed") : ok(Array.from({ length: 25 }, (_, i) => row(i)))),
    });
    wrap(<MyRequests />);
    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Page failed")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(25);
    expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();
  });

  it("an empty first page shows the empty state", async () => {
    mockFetch({ ...session("employee"), "/rpc/list_my_requests": () => ok([]) });
    wrap(<MyRequests />);
    expect(await screen.findByText("No requests yet")).toBeInTheDocument();
  });
});

describe("Request detail (owner)", () => {
  it("submitted: details, history, edit link and a plain withdraw with optional reason", async () => {
    const calls = mockFetch({ ...session("employee"), "/rpc/get_my_request": () => ok(detail()), "/rpc/withdraw_request": () => ok(detail({ state: "cancelled", version: 3 })) });
    wrap(<MyRequestDetail id={ID} />);
    expect(await screen.findByText("Family function")).toBeInTheDocument();
    expect(screen.getByText("1.5 days")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Days" })).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Approver: Demo Admin")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute("href", `/leave/apply?edit=${ID}`);
    await userEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("Reason (optional)")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Withdraw" }));
    expect(await screen.findByText("Request withdrawn.")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/withdraw_request")!.body).toEqual({ p_request_id: ID, p_expected_version: 2, p_reason: null });
  });

  it("under review: asks to withdraw, no edit", async () => {
    mockFetch({ ...session("employee"), "/rpc/get_my_request": () => ok(detail({ state: "under_review" })) });
    wrap(<MyRequestDetail id={ID} />);
    await userEvent.click(await screen.findByRole("button", { name: "Request withdrawal" }));
    expect(screen.getByRole("dialog", { name: "Ask to withdraw?" })).toHaveTextContent(/must accept the withdrawal/);
    expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("returned: shows the approver's reason and Edit & resubmit", async () => {
    mockFetch({
      ...session("employee"),
      "/rpc/get_my_request": () =>
        ok(detail({ state: "returned", events: [{ action: "returned", actor: null, created_at: "2026-11-14T11:00:00Z", from_state: "under_review", to_state: "returned", reason: "Pick one day", revision_no: 1 }] })),
    });
    wrap(<MyRequestDetail id={ID} />);
    expect(await screen.findByText(/Returned for changes: “Pick one day”/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Edit & resubmit" })).toBeInTheDocument();
  });

  it("approved leave: cancellation needs a reason before calling the server", async () => {
    const calls = mockFetch({ ...session("employee"), "/rpc/get_my_request": () => ok(detail({ state: "approved" })), "/rpc/request_leave_cancellation": () => ok(detail({ state: "cancellation_pending", version: 3 })) });
    wrap(<MyRequestDetail id={ID} />);
    await userEvent.click(await screen.findByRole("button", { name: "Request cancellation" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Request cancellation" }));
    expect(within(dialog).getByText("A reason is required.")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/rpc/request_leave_cancellation")).toBe(false);
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Plans changed");
    await userEvent.click(within(dialog).getByRole("button", { name: "Request cancellation" }));
    expect(await screen.findByText("Cancellation requested.")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/request_leave_cancellation")!.body).toMatchObject({ p_reason: "Plans changed", p_expected_version: 2 });
  });

  it("Admin revokes their own approved leave", async () => {
    mockFetch({ ...session("admin"), "/rpc/get_my_request": () => ok(detail({ state: "approved" })) });
    wrap(<MyRequestDetail id={ID} />);
    expect(await screen.findByRole("button", { name: "Revoke leave" })).toBeInTheDocument();
  });

  it("a stale version reloads and explains", async () => {
    let loads = 0;
    mockFetch({
      ...session("employee"),
      "/rpc/get_my_request": () => ok(detail(loads++ === 0 ? {} : { state: "under_review", version: 3 })),
      "/rpc/withdraw_request": () => fail(409, "STALE_VERSION", "changed"),
    });
    wrap(<MyRequestDetail id={ID} />);
    await userEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Withdraw" }));
    expect(await screen.findByText(/We reloaded it/)).toBeInTheDocument();
    expect(await screen.findByText("In review")).toBeInTheDocument();
  });

  it.each(["rejected", "cancelled", "cancellation_pending"])("%s: no actions", async (state) => {
    mockFetch({ ...session("employee"), "/rpc/get_my_request": () => ok(detail({ state })) });
    wrap(<MyRequestDetail id={ID} />);
    await screen.findByText("Family function");
    expect(screen.queryByRole("button", { name: /Withdraw|cancellation|Revoke/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Edit/ })).not.toBeInTheDocument();
  });

  it("someone else's request reads as not found", async () => {
    mockFetch({ ...session("employee"), "/rpc/get_my_request": () => fail(404, "NOT_FOUND", "Not found") });
    wrap(<MyRequestDetail id={ID} />);
    expect(await screen.findByText("This request does not exist or is not yours.")).toBeInTheDocument();
  });
});

describe("Review queue", () => {
  it("is closed to employees", async () => {
    const calls = mockFetch({ ...session("employee"), "/rpc/list_review_queue": () => ok([]) });
    wrap(<ReviewQueue />);
    expect(await screen.findByText("Only HR or Admin can review requests")).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/rpc/list_review_queue").every((c) => (c.body as { p_scope: string }).p_scope === "mine")).toBe(true);
  });

  it("HR sees only their queue; filters change the query", async () => {
    const calls = mockFetch({ ...session("hr"), "/rpc/list_review_queue": () => ok([row(1)]) });
    wrap(<ReviewQueue />);
    expect(await screen.findByText("Ravi Kumar · EMP002")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Everyone" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "WFH" }));
    await userEvent.click(screen.getByRole("tab", { name: "Decided" }));
    await waitFor(() => expect(calls.at(-1)!.body).toMatchObject({ p_scope: "mine", p_kind: "wfh", p_state: "completed" }));
  });

  it("Admin can look at everyone and at requests with no approver", async () => {
    const calls = mockFetch({ ...session("admin"), "/rpc/list_review_queue": () => ok([]) });
    wrap(<ReviewQueue initialScope="unassigned" />);
    expect(await screen.findByText("All caught up")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "No approver" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("tab", { name: "Everyone" }));
    await waitFor(() => expect(calls.at(-1)!.body).toMatchObject({ p_scope: "all" }));
  });

  it("a non-admin cannot force another scope through the URL", async () => {
    const calls = mockFetch({ ...session("hr"), "/rpc/list_review_queue": () => ok([]) });
    wrap(<ReviewQueue initialScope="all" />);
    await screen.findByText("All caught up");
    expect(calls.filter((c) => c.path === "/rpc/list_review_queue").every((c) => (c.body as { p_scope: string }).p_scope === "mine")).toBe(true);
  });
});

describe("Approval detail", () => {
  const opened = (over: Record<string, unknown> = {}) => detail({ state: "under_review", version: 3, authority: "assigned", attendance_conflicts: 0, balance: [{ available: 21, leave_year: 2026, valid_to: "2027-01-01" }], ...over });

  it("opens once, shows the balance and approves with the version", async () => {
    const calls = mockFetch({ ...session("hr"), "/rpc/open_request_for_review": () => ok(opened()), "/rpc/decide_request": () => ok(opened({ state: "approved", version: 4 })) });
    wrap(<ApprovalDetail id={ID} />);
    expect(await screen.findByText("Ravi Kumar · EMP002")).toBeInTheDocument();
    expect(screen.getByText("10.5 days")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = screen.getByRole("dialog", { name: "Approve this request?" });
    expect(within(dialog).getByLabelText("Reason (optional)")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Approved.")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/decide_request")!.body).toEqual({ p_request_id: ID, p_expected_version: 3, p_decision: "approve", p_reason: null });
    expect(calls.filter((c) => c.path === "/rpc/open_request_for_review")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("reject and return need a reason", async () => {
    const calls = mockFetch({ ...session("hr"), "/rpc/open_request_for_review": () => ok(opened()), "/rpc/decide_request": () => ok(opened({ state: "returned" })) });
    wrap(<ApprovalDetail id={ID} />);
    await userEvent.click(await screen.findByRole("button", { name: "Not approve" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Not approve" }));
    expect(screen.getByText("A reason is required.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.click(screen.getByRole("button", { name: "Return for changes" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Pick one day");
    await userEvent.click(within(dialog).getByRole("button", { name: "Return" }));
    expect(await screen.findByText("Returned for changes.")).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/rpc/decide_request").map((c) => (c.body as { p_decision: string }).p_decision)).toEqual(["return"]);
  });

  it("attendance conflicts block approval", async () => {
    mockFetch({ ...session("hr"), "/rpc/open_request_for_review": () => ok(opened({ attendance_conflicts: 2 })) });
    wrap(<ApprovalDetail id={ID} />);
    expect(await screen.findByText(/already has attendance on 2 of these days/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });

  it("Admin fallback: asks why before opening, then needs a reason to approve", async () => {
    const calls = mockFetch({
      ...session("admin"),
      "/rpc/open_request_for_review": (b) => ((b as { p_reason: string | null }).p_reason ? ok(opened({ authority: "admin" })) : fail(422, "VALIDATION_FAILED", "Reason needed", { reason: "Required" })),
    });
    wrap(<ApprovalDetail id={ID} />);
    const go = await screen.findByRole("button", { name: "Review it myself" });
    expect(go).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Reason"), "Approver on leave");
    await userEvent.click(go);
    expect(await screen.findByText("Admin fallback")).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/rpc/open_request_for_review").map((c) => (c.body as { p_reason: string | null }).p_reason)).toEqual([null, "Approver on leave"]);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(within(screen.getByRole("dialog")).getByLabelText("Reason")).toBeInTheDocument();
  });

  it("withdrawal and cancellation requests", async () => {
    const calls = mockFetch({ ...session("hr"), "/rpc/open_request_for_review": () => ok(opened({ state: "withdrawal_pending" })), "/rpc/resolve_withdrawal": () => ok(opened({ state: "cancelled" })) });
    wrap(<ApprovalDetail id={ID} />);
    await userEvent.click(await screen.findByRole("button", { name: "Decline withdrawal" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Decline" }));
    expect(screen.getByText("A reason is required.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.click(screen.getByRole("button", { name: "Accept withdrawal" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Withdrawal accepted.")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/resolve_withdrawal")!.body).toMatchObject({ p_accept: true, p_expected_version: 3 });
  });

  it("cancellation panel", async () => {
    mockFetch({ ...session("hr"), "/rpc/open_request_for_review": () => ok(opened({ state: "cancellation_pending" })) });
    wrap(<ApprovalDetail id={ID} />);
    expect(await screen.findByRole("button", { name: "Approve cancellation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep the leave approved" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Assign another approver" })).not.toBeInTheDocument();
  });

  it("a stale decision reopens the request", async () => {
    let opens = 0;
    mockFetch({
      ...session("hr"),
      "/rpc/open_request_for_review": () => ok(opened(opens++ === 0 ? {} : { state: "withdrawal_pending", version: 5 })),
      "/rpc/decide_request": () => fail(409, "STALE_VERSION", "changed"),
    });
    wrap(<ApprovalDetail id={ID} />);
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("button", { name: "Accept withdrawal" })).toBeInTheDocument();
    expect(screen.getByText(/changed while you were looking/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Admin reassigns to someone other than the requester and current approver", async () => {
    const calls = mockFetch({
      ...session("admin"),
      "/rpc/open_request_for_review": () => ok(opened()),
      "/rpc/list_reviewer_candidates": () =>
        ok([
          { id: "a1", code: "ADMIN1", name: "Demo Admin", roles: ["admin"] },
          { id: "e2", code: "EMP002", name: "Ravi Kumar", roles: ["hr"] },
          { id: "h1", code: "HR1", name: "Meena HR", roles: ["hr"] },
        ]),
      "/rpc/reassign_request": () => ok(opened({ version: 4 })),
    });
    wrap(<ApprovalDetail id={ID} />);
    await userEvent.click(await screen.findByRole("button", { name: "Assign another approver" }));
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByRole("radio", { name: /Meena HR/ })).toBeInTheDocument();
    expect(within(dialog).getAllByRole("radio")).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole("button", { name: "Assign" }));
    expect(within(dialog).getByText("Choose an approver.")).toBeInTheDocument();
    expect(within(dialog).getByText("A reason is required.")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("radio", { name: /Meena HR/ }));
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Workload");
    await userEvent.click(within(dialog).getByRole("button", { name: "Assign" }));
    expect(await screen.findByText("Approver changed.")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/reassign_request")!.body).toEqual({ p_request_id: ID, p_expected_version: 3, p_new_reviewer_id: "h1", p_reason: "Workload" });
  });

  it("access denied reads plainly", async () => {
    mockFetch({ ...session("hr"), "/rpc/open_request_for_review": () => fail(403, "ACCESS_DENIED", "denied") });
    wrap(<ApprovalDetail id={ID} />);
    expect(await screen.findByText("You cannot review this request.")).toBeInTheDocument();
  });
});
