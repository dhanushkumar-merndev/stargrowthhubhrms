"use client";

// my_requests_screen.dart, approvals_screen.dart, approval_detail_screen.dart
// and request_widgets.dart. Every write sends the version the screen showed;
// a STALE_VERSION answer reloads instead of overwriting someone else's change.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ApiError, rpc } from "@/lib/api";
import { dayLabel } from "@/lib/attendance";
import { SLOT_LABEL, type Slot, daysLabel } from "@/lib/leave";
import {
  type Decision,
  type RequestDetail,
  type RequestEvent,
  type RequestRow,
  KIND_ART,
  MY_FILTERS,
  REVIEW_KINDS,
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
import { caps } from "@/lib/roles";
import { useSession } from "@/lib/session";
import { useRpc } from "@/lib/use-rpc";
import { Art, Banner, Button, EmptyState, ErrorState, KeyValue, LoadingState, PageTitle, PillTabs, SectionCard, Sheet, StatusChip, TextArea, cx } from "../ui";

const LIMIT = 25;
const msg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/* ───────────────────────── shared pieces ───────────────────────── */

function RequestCard({ r, href, showWho }: { r: RequestRow; href: string; showWho?: boolean }) {
  const s = stateOf(r.state);
  const art = KIND_ART[r.kind] ?? { tile: "bg-approvals-card", art: "assignment" };
  return (
    <Link href={href} className="flex items-center gap-3 rounded-card border border-border bg-surface p-card">
      <span className={cx("grid size-12 shrink-0 place-items-center rounded-[14px]", art.tile)}>
        <Art name={art.art} size={26} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate font-semibold">{showWho ? `${r.employee.name} · ${r.employee.code}` : requestTitle(r)}</span>
          <StatusChip label={s.label} tone={s.tone} />
        </span>
        <span className="mt-0.5 block truncate text-body-md text-text-secondary">
          {showWho ? `${requestTitle(r)} · ` : ""}
          {requestDates(r) || "No dates"}
          {r.kind === "leave" && r.units != null ? ` · ${daysLabel(r.units)}` : ""}
          {r.edited ? " · edited" : ""}
        </span>
      </span>
    </Link>
  );
}

/** Keyset paging over list_my_requests / list_review_queue. */
function usePaged(name: string | null, args: Record<string, unknown>, atKey: string, at: (r: RequestRow) => string | null) {
  const first = useRpc<RequestRow[]>(name, { ...args, p_limit: LIMIT });
  const listName = name ?? "";
  const key = JSON.stringify(args);
  const [state, setState] = useState<{ key: string; extra: RequestRow[]; full: boolean | null }>({ key, extra: [], full: null });
  if (state.key !== key) setState({ key, extra: [], full: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = first.data ? appendPage(first.data, state.extra) : null;
  const lastFull = state.full ?? (first.data ? first.data.length >= LIMIT : false);
  const more = async () => {
    if (!rows) return;
    const c = nextCursor(rows, rows.length, at);
    if (!c) return;
    setBusy(true);
    setError(null);
    try {
      const page = await rpc<RequestRow[]>(listName, { ...args, p_limit: LIMIT, [atKey]: c.at, p_before_id: c.id });
      setState((s) => ({ key: s.key, extra: appendPage(s.extra, page), full: page.length >= LIMIT }));
    } catch (e) {
      setError(msg(e, "Could not load more."));
    } finally {
      setBusy(false);
    }
  };
  const reload = () => {
    setState({ key, extra: [], full: null });
    return first.mutate();
  };
  return { rows, error: first.error, moreError: error, hasMore: lastFull, busy, more, reload };
}

function List({ paged, empty, href, showWho }: { paged: ReturnType<typeof usePaged>; empty: React.ReactNode; href: (r: RequestRow) => string; showWho?: boolean }) {
  if (paged.error) return <ErrorState message={msg(paged.error, "Could not load requests.")} onRetry={() => paged.reload()} />;
  if (!paged.rows) return <LoadingState />;
  if (paged.rows.length === 0) return <>{empty}</>;
  return (
    <>
      <ul className="flex flex-col gap-2">
        {paged.rows.map((r) => (
          <li key={r.id}>
            <RequestCard r={r} href={href(r)} showWho={showWho} />
          </li>
        ))}
      </ul>
      {paged.moreError && <Banner>{paged.moreError}</Banner>}
      {paged.hasMore && (
        <Button variant="outlined" busy={paged.busy} onClick={paged.more}>
          Load more
        </Button>
      )}
    </>
  );
}

function Timeline({ events, timeZone }: { events: RequestEvent[]; timeZone: string }) {
  if (!events.length) return null;
  return (
    <SectionCard>
      <h2 className="mb-2 text-title-sm font-semibold">History</h2>
      <ol className="flex flex-col gap-3" aria-label="History">
        {events.map((e, i) => (
          <li key={i} className="border-l-2 border-border pl-3">
            <p className="font-semibold">{eventLabel(e.action)}</p>
            <p className="text-body-sm text-text-secondary">
              {e.actor ? `${e.actor.name} · ` : ""}
              {stamp(e.created_at, timeZone)}
              {e.revision_no && e.revision_no > 1 ? ` · version ${e.revision_no}` : ""}
            </p>
            {e.reason && <p className="mt-1 text-body-md">“{e.reason}”</p>}
          </li>
        ))}
      </ol>
    </SectionCard>
  );
}

function Details({ r, timeZone }: { r: RequestDetail; timeZone: string }) {
  const p = currentPayload(r);
  const days = Array.isArray(p.days) ? (p.days as { day: string; slot: Slot; units: number }[]) : [];
  const reason = payloadText(p, "reason");
  const rows = payloadRows(p, timeZone);
  return (
    <SectionCard>
      <h2 className="mb-2 text-title-sm font-semibold">Details</h2>
      {requestDates(r) && <KeyValue k={r.start_date === r.end_date || !r.end_date ? "Date" : "Dates"} v={requestDates(r)} />}
      {r.kind === "leave" && <KeyValue k="Length" v={daysLabel(r.units)} />}
      {rows.map((x) => (
        <KeyValue key={x.k} k={x.k} v={x.v} />
      ))}
      {days.length > 1 && (
        <ul className="mt-2 text-body-md" aria-label="Days">
          {days.map((d) => (
            <li key={d.day}>
              • {dayLabel(d.day)} — {SLOT_LABEL[d.slot] ?? d.slot}
            </li>
          ))}
        </ul>
      )}
      {reason && (
        <div className="mt-3">
          <p className="text-body-md text-text-secondary">Reason</p>
          <p className="text-body-lg">{reason}</p>
        </div>
      )}
    </SectionCard>
  );
}

function Header({ r, who, extra }: { r: RequestDetail; who?: boolean; extra?: React.ReactNode }) {
  const s = stateOf(r.state);
  return (
    <SectionCard>
      {who && (
        <p className="text-title-md font-semibold">
          {r.employee.name} · {r.employee.code}
        </p>
      )}
      <p className={who ? "text-body-lg" : "text-title-md font-semibold"}>{requestTitle(r)}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <StatusChip label={s.label} tone={s.tone} />
        {r.edited && <StatusChip label={`Edited · version ${r.current_revision}`} tone="neutral" />}
        {extra}
      </div>
      {r.reviewer && <p className="mt-2 text-body-md text-text-secondary">Approver: {r.reviewer.name}</p>}
    </SectionCard>
  );
}

/** A confirm sheet with an optional or required reason. */
function ReasonSheet({
  title,
  body,
  confirm,
  danger,
  required,
  onClose,
  onConfirm,
}: {
  title: string;
  body?: string;
  confirm: string;
  danger?: boolean;
  required: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const e = reasonError(reason, required);
    setErr(e);
    if (e) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
    } catch (x) {
      if (x instanceof ApiError && x.fieldErrors.reason) setErr(x.fieldErrors.reason);
      setError(msg(x, "Could not save."));
      setBusy(false);
    }
  };
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {body && <p className="text-body-md text-text-secondary">{body}</p>}
        {error && <Banner>{error}</Banner>}
        <TextArea label={required ? "Reason" : "Reason (optional)"} value={reason} onChange={setReason} error={err} rows={3} />
        <Button variant={danger ? "danger" : "filled"} busy={busy} onClick={go}>
          {confirm}
        </Button>
      </div>
    </Sheet>
  );
}

/* ───────────────────────── My requests ───────────────────────── */

type MyFilter = (typeof MY_FILTERS)[number]["id"];

export function MyRequests() {
  const [filter, setFilter] = useState<MyFilter>("");
  const paged = usePaged("list_my_requests", { p_state: filter || null }, "p_before_created_at", (r) => r.created_at);
  return (
    <>
      <PageTitle title="My requests" back="/explore" />
      <div className="mx-auto flex max-w-xl flex-col gap-4 p-page">
        <PillTabs label="Filter" tabs={MY_FILTERS} value={filter} onChange={setFilter} />
        <List
          paged={paged}
          href={(r) => `/requests/${r.id}`}
          empty={
            <EmptyState
              title={filter === "" ? "No requests yet" : filter === "completed" ? "Nothing completed yet" : "Nothing open"}
              body="Leave, corrections, work from home and late excuses you send show up here."
            />
          }
        />
      </div>
    </>
  );
}

export function MyRequestDetail({ id }: { id: string }) {
  const { context } = useSession();
  const tz = context?.org.timezone ?? "Asia/Kolkata";
  const isAdmin = caps(context).isAdmin;
  const q = useRpc<RequestDetail>("get_my_request", { p_request_id: id });
  const [sheet, setSheet] = useState<"withdraw" | "cancel" | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "warning"; text: string } | null>(null);

  const act = async (fn: string, reason: string, done: string) => {
    try {
      const r = await rpc<RequestDetail>(fn, { p_request_id: id, p_expected_version: q.data!.version, p_reason: reason || null });
      await q.mutate(r, { revalidate: true });
      setSheet(null);
      setNotice({ tone: "success", text: done });
    } catch (e) {
      if (e instanceof ApiError && e.code === "STALE_VERSION") {
        setSheet(null);
        setNotice({ tone: "warning", text: "This request changed. We reloaded it; check it and try again." });
        await q.mutate();
        return;
      }
      throw e;
    }
  };

  if (q.error)
    return (
      <>
        <PageTitle title="Request" back="/requests" />
        <ErrorState message={q.error.code === "NOT_FOUND" ? "This request does not exist or is not yours." : msg(q.error, "Could not load this request.")} onRetry={() => q.mutate()} />
      </>
    );
  if (!q.data)
    return (
      <>
        <PageTitle title="Request" back="/requests" />
        <LoadingState />
      </>
    );
  const r = q.data;
  const a = ownerActions(r, isAdmin);
  const edit = a.edit ? editHref(r) : null;
  const ret = returnReason(r);

  return (
    <>
      <PageTitle title={requestTitle(r)} back="/requests" />
      <div className="mx-auto flex max-w-xl flex-col gap-4 p-page pb-32">
        {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}
        <Header r={r} />
        {r.state === "returned" && <Banner tone="warning">Returned for changes{ret ? `: “${ret}”` : "."} Edit and send it again.</Banner>}
        {r.state === "withdrawal_pending" && <Banner tone="info">Your approver has to accept the withdrawal.</Banner>}
        {r.state === "cancellation_pending" && <Banner tone="info">Your approver has to approve the cancellation. The leave stays booked until then.</Banner>}
        <Details r={r} timeZone={tz} />
        <Timeline events={r.events ?? []} timeZone={tz} />
        {(edit || a.withdraw || a.cancel) && (
          <div className="flex flex-col gap-2">
            {edit && (
              <Link href={edit} className="inline-flex min-h-[52px] items-center justify-center rounded-button bg-primary px-4 font-semibold text-white">
                {a.editLabel}
              </Link>
            )}
            {a.withdraw && (
              <Button variant="outlined" onClick={() => setSheet("withdraw")}>
                {a.withdrawLabel}
              </Button>
            )}
            {a.cancel && (
              <Button variant="outlined" className="text-error" onClick={() => setSheet("cancel")}>
                {a.cancelLabel}
              </Button>
            )}
          </div>
        )}
      </div>
      {sheet === "withdraw" && (
        <ReasonSheet
          title={a.withdrawNeedsApproval ? "Ask to withdraw?" : "Withdraw this request?"}
          body={a.withdrawNeedsApproval ? "Your approver has opened this request, so they must accept the withdrawal." : "It will be cancelled and nobody needs to review it."}
          confirm={a.withdrawLabel}
          required={false}
          onClose={() => setSheet(null)}
          onConfirm={(reason) => act("withdraw_request", reason, a.withdrawNeedsApproval ? "Withdrawal requested." : "Request withdrawn.")}
        />
      )}
      {sheet === "cancel" && (
        <ReasonSheet
          title={isAdmin ? "Revoke this leave?" : "Cancel this leave?"}
          body={isAdmin ? "The leave is cancelled and the days go back to your balance." : "Your approver must approve the cancellation. The leave stays booked until then."}
          confirm={a.cancelLabel}
          danger
          required
          onClose={() => setSheet(null)}
          onConfirm={(reason) => act("request_leave_cancellation", reason, isAdmin ? "Leave revoked." : "Cancellation requested.")}
        />
      )}
    </>
  );
}

/* ───────────────────────── Review queue ───────────────────────── */

type Scope = "mine" | "all" | "unassigned";
type ReviewKind = (typeof REVIEW_KINDS)[number]["id"];

export function ReviewQueue({ initialScope }: { initialScope?: Scope }) {
  const { context } = useSession();
  const c = caps(context);
  const [wanted, setScope] = useState<Scope>(initialScope ?? "mine");
  // Only Admin may look beyond their own queue; wait for the session before asking.
  const scope: Scope = c.isAdmin ? wanted : "mine";
  const [kind, setKind] = useState<ReviewKind>("");
  const [done, setDone] = useState<"" | "completed">("");
  const paged = usePaged(
    context ? "list_review_queue" : null,
    { p_scope: scope, p_kind: kind || null, p_state: done || null },
    "p_before_submitted_at",
    (r) => r.submitted_at,
  );
  if (!c.canReview)
    return (
      <>
        <PageTitle title="Review requests" back="/explore" />
        <EmptyState art="lock" title="Only HR or Admin can review requests" />
      </>
    );
  const scopes = [
    { id: "mine" as const, label: "Assigned to me" },
    ...(c.isAdmin ? [{ id: "all" as const, label: "Everyone" }, { id: "unassigned" as const, label: "No approver" }] : []),
  ];
  return (
    <>
      <PageTitle title="Review requests" back="/explore" />
      <div className="mx-auto flex max-w-xl flex-col gap-3 p-page">
        {scopes.length > 1 && <PillTabs label="Whose requests" tabs={scopes} value={scope} onChange={setScope} />}
        <PillTabs label="Kind" tabs={REVIEW_KINDS} value={kind} onChange={setKind} />
        <PillTabs
          label="Status"
          tabs={[
            { id: "" as const, label: "Waiting" },
            { id: "completed" as const, label: "Decided" },
          ]}
          value={done}
          onChange={setDone}
        />
        <List
          paged={paged}
          showWho
          href={(r) => `/approvals/${r.id}`}
          empty={<EmptyState art="check_circle" title={done ? "Nothing decided yet" : "All caught up"} body={done ? undefined : "No requests are waiting for you."} />}
        />
      </div>
    </>
  );
}

/* ───────────────────────── Approval detail ───────────────────────── */

type Pending = { kind: "decide"; decision: Decision } | { kind: "withdrawal" | "cancellation"; accept: boolean } | { kind: "reassign" } | null;

export function ApprovalDetail({ id }: { id: string }) {
  const { context } = useSession();
  const tz = context?.org.timezone ?? "Asia/Kolkata";
  const c = caps(context);
  const [r, setR] = useState<RequestDetail | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [needsReason, setNeedsReason] = useState(false);
  const [openReason, setOpenReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "warning"; text: string } | null>(null);

  const open = useCallback(
    async (reason: string | null) => {
      setBusy(true);
      setError(null);
      try {
        const res = await rpc<RequestDetail>("open_request_for_review", { p_request_id: id, p_reason: reason });
        setR(res);
        setNeedsReason(false);
      } catch (e) {
        if (e instanceof ApiError && e.code === "VALIDATION_FAILED" && e.fieldErrors.reason) setNeedsReason(true);
        else setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        setBusy(false);
      }
    },
    [id],
  );
  useEffect(() => {
    // Opening locks the current revision for review; do it once on arrival.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading data on mount
    void open(null);
  }, [open]);

  const write = async (fn: string, args: Record<string, unknown>, done: string) => {
    try {
      const res = await rpc<RequestDetail>(fn, { p_request_id: id, p_expected_version: r!.version, ...args });
      setPending(null);
      setNotice({ tone: "success", text: done });
      // Decisions return the request; re-open only if it still needs a decision.
      if (res && typeof res === "object" && "state" in res) setR((old) => ({ ...(old as RequestDetail), ...res }));
    } catch (e) {
      if (e instanceof ApiError && e.code === "STALE_VERSION") {
        setPending(null);
        setNotice({ tone: "warning", text: "This request changed while you were looking. We reloaded it." });
        await open(null);
        return;
      }
      throw e;
    }
  };

  const title = "Review request";
  if (needsReason)
    return (
      <>
        <PageTitle title={title} back="/approvals" />
        <div className="mx-auto flex max-w-xl flex-col gap-4 p-page">
          <Banner tone="warning">This request has no approver. As Admin you can review it yourself; say why. Reviewing locks the current version.</Banner>
          <TextArea label="Reason" value={openReason} onChange={setOpenReason} error={openReason.trim() ? null : undefined} rows={3} />
          <Button busy={busy} disabled={!openReason.trim()} onClick={() => open(openReason.trim())}>
            Review it myself
          </Button>
        </div>
      </>
    );
  if (error)
    return (
      <>
        <PageTitle title={title} back="/approvals" />
        <ErrorState
          message={error instanceof ApiError && error.code === "ACCESS_DENIED" ? "You cannot review this request." : msg(error, "Could not open this request.")}
          onRetry={() => open(null)}
        />
      </>
    );
  if (!r)
    return (
      <>
        <PageTitle title={title} back="/approvals" />
        <LoadingState />
      </>
    );

  const adminFallback = r.authority === "admin";
  const conflicts = r.attendance_conflicts ?? 0;
  const panel = reviewerPanel(r.state, c.canReview);
  const bal = r.balance?.[0];

  return (
    <>
      <PageTitle title={title} back="/approvals" />
      <div className="mx-auto flex max-w-xl flex-col gap-4 p-page pb-32">
        {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}
        <Header r={r} who extra={adminFallback ? <StatusChip label="Admin fallback" tone="warning" /> : null} />
        {r.kind === "leave" && bal && (
          <SectionCard className="bg-leave-card">
            <KeyValue k="Left after this request" v={bal.available == null ? "No limit" : daysLabel(bal.available)} />
            <KeyValue k="This request" v={daysLabel(r.units)} />
          </SectionCard>
        )}
        {conflicts > 0 && (
          <Banner tone="warning">
            {r.employee.name} already has attendance on {conflicts} of these day{conflicts === 1 ? "" : "s"}. Resolve it before approving.
          </Banner>
        )}
        <Details r={r} timeZone={tz} />
        <Timeline events={r.events ?? []} timeZone={tz} />

        {panel === "readonly" && <p className="text-body-md text-text-secondary">Only HR or Admin can approve, return or reject requests.</p>}
        {panel === "decide" && (
          <div className="flex flex-col gap-2">
            <Button disabled={conflicts > 0} onClick={() => setPending({ kind: "decide", decision: "approve" })}>
              Approve
            </Button>
            <Button variant="outlined" onClick={() => setPending({ kind: "decide", decision: "return" })}>
              Return for changes
            </Button>
            <Button variant="outlined" className="text-error" onClick={() => setPending({ kind: "decide", decision: "reject" })}>
              Not approve
            </Button>
          </div>
        )}
        {panel === "withdrawal" && (
          <div className="flex flex-col gap-2">
            <p className="text-body-md">The employee asked to withdraw this request.</p>
            <Button onClick={() => setPending({ kind: "withdrawal", accept: true })}>Accept withdrawal</Button>
            <Button variant="outlined" onClick={() => setPending({ kind: "withdrawal", accept: false })}>
              Decline withdrawal
            </Button>
          </div>
        )}
        {panel === "cancellation" && (
          <div className="flex flex-col gap-2">
            <p className="text-body-md">The employee asked to cancel this approved leave. It stays booked until you decide.</p>
            <Button onClick={() => setPending({ kind: "cancellation", accept: true })}>Approve cancellation</Button>
            <Button variant="outlined" onClick={() => setPending({ kind: "cancellation", accept: false })}>
              Keep the leave approved
            </Button>
          </div>
        )}
        {c.isAdmin && panel !== "none" && (
          <Button variant="text" onClick={() => setPending({ kind: "reassign" })}>
            Assign another approver
          </Button>
        )}
      </div>

      {pending?.kind === "decide" && (
        <ReasonSheet
          title={pending.decision === "approve" ? "Approve this request?" : pending.decision === "return" ? "Return for changes" : "Not approve this request?"}
          body={
            pending.decision === "return"
              ? "Say what needs to change. The employee can edit and send it again."
              : adminFallback
                ? "You are deciding as Admin without being the approver, so a reason is required."
                : undefined
          }
          confirm={pending.decision === "approve" ? "Approve" : pending.decision === "return" ? "Return" : "Not approve"}
          danger={pending.decision === "reject"}
          required={reasonRequired(pending.decision, adminFallback)}
          onClose={() => setPending(null)}
          onConfirm={(reason) =>
            write(
              "decide_request",
              { p_decision: pending.decision, p_reason: reason || null },
              pending.decision === "approve" ? "Approved." : pending.decision === "return" ? "Returned for changes." : "Marked not approved.",
            )
          }
        />
      )}
      {(pending?.kind === "withdrawal" || pending?.kind === "cancellation") && (
        <ReasonSheet
          title={
            pending.kind === "withdrawal"
              ? pending.accept
                ? "Accept the withdrawal?"
                : "Decline the withdrawal?"
              : pending.accept
                ? "Approve the cancellation?"
                : "Keep the leave approved?"
          }
          confirm={pending.accept ? "Confirm" : "Decline"}
          required={reasonRequired(pending.accept ? "accept" : "decline", adminFallback)}
          onClose={() => setPending(null)}
          onConfirm={(reason) =>
            write(
              pending.kind === "withdrawal" ? "resolve_withdrawal" : "resolve_cancellation",
              { p_accept: pending.accept, p_reason: reason || null },
              pending.kind === "withdrawal"
                ? pending.accept
                  ? "Withdrawal accepted."
                  : "Withdrawal declined."
                : pending.accept
                  ? "Cancellation approved."
                  : "Leave kept approved.",
            )
          }
        />
      )}
      {pending?.kind === "reassign" && (
        <ReassignSheet
          current={r.reviewer?.id ?? null}
          requester={r.employee.id}
          onClose={() => setPending(null)}
          onConfirm={async (who, reason) => {
            await write("reassign_request", { p_new_reviewer_id: who, p_reason: reason }, "Approver changed.");
            await open(null).catch(() => undefined);
          }}
        />
      )}
    </>
  );
}

interface Candidate {
  id: string;
  code: string;
  name: string;
  roles: string[];
}

function ReassignSheet({
  current,
  requester,
  onClose,
  onConfirm,
}: {
  current: string | null;
  requester: string;
  onClose: () => void;
  onConfirm: (who: string, reason: string) => Promise<void>;
}) {
  const list = useRpc<Candidate[]>("list_reviewer_candidates", {});
  const options = (list.data ?? []).filter((p) => p.id !== requester && p.id !== current);
  const [who, setWho] = useState("");
  const [reason, setReason] = useState("");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const e: Record<string, string> = {};
    if (!who) e.who = "Choose an approver.";
    const re = reasonError(reason, true);
    if (re) e.reason = re;
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(who, reason.trim());
    } catch (x) {
      setError(msg(x, "Could not reassign."));
      setBusy(false);
    }
  };
  return (
    <Sheet title="Assign another approver" onClose={onClose}>
      <div className="flex flex-col gap-4">
        {error && <Banner>{error}</Banner>}
        {list.error ? (
          <Banner>{msg(list.error, "Could not load approvers.")}</Banner>
        ) : !list.data ? (
          <LoadingState />
        ) : options.length === 0 ? (
          <p className="text-body-md text-text-secondary">Nobody else can review this request.</p>
        ) : (
          <fieldset>
            <legend className="mb-1.5 text-body-md font-medium text-text-secondary">Approver</legend>
            <div className="flex flex-col gap-1">
              {options.map((p) => (
                <label key={p.id} className="flex min-h-12 items-center gap-3 rounded-row px-2">
                  <input type="radio" name="reviewer" value={p.id} checked={who === p.id} onChange={() => setWho(p.id)} />
                  <span>
                    {p.name} · {p.code}
                    <span className="ml-1 text-body-sm text-text-secondary">({p.roles.join(", ")})</span>
                  </span>
                </label>
              ))}
            </div>
            {errs.who && <p className="mt-1 text-body-sm text-error">{errs.who}</p>}
          </fieldset>
        )}
        <TextArea label="Reason" value={reason} onChange={setReason} error={errs.reason} rows={3} />
        <Button busy={busy} disabled={options.length === 0} onClick={go}>
          Assign
        </Button>
      </div>
    </Sheet>
  );
}
