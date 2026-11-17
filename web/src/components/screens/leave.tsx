"use client";

// leave_screen.dart (balances + history), leave_apply_screen.dart (apply or
// edit with a live server preview) and the holiday calendar.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, newOperationId, rpc } from "@/lib/api";
import { dayLabel, todayIn } from "@/lib/attendance";
import {
  type Balances,
  type HolidayYear,
  type LeaveType,
  type Preview,
  type Slot,
  SLOT_LABEL,
  balanceAfter,
  daysLabel,
  holidayArt,
  leaveFormErrors,
  mapLeaveFields,
  normalizeSlots,
  slotOptions,
  splitHolidays,
} from "@/lib/leave";
import { type RequestDetail, type RequestRow, currentPayload, requestDates, requestTitle, stateOf } from "@/lib/requests";
import { caps } from "@/lib/roles";
import { useSession } from "@/lib/session";
import { useRpc } from "@/lib/use-rpc";
import { type FileClass, uploadFile } from "@/lib/files";
import { FilePicker } from "../files";
import { Glyph } from "../glyphs";
import { Art, Banner, Button, EmptyState, ErrorState, LoadingState, PageTitle, SectionCard, StatusChip, TextArea, TextField, cx } from "../ui";

const msg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/* ───────────────────────── Balances ───────────────────────── */

/** "2026", or "Apr 2026 – Mar 2027" when the leave year does not start in January. */
export function leaveYearLabel(year: number, startMonth = 1): string {
  if (startMonth === 1) return String(year);
  const mon = (m: number) => new Date(Date.UTC(2000, m - 1, 1)).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
  return `${mon(startMonth)} ${year} – ${mon(startMonth - 1)} ${year + 1}`;
}

const plainDays = (units: number | null | undefined) => {
  const d = (units ?? 0) / 2;
  return String(d);
};

export function LeaveBalances() {
  const [year, setYear] = useState<number | null>(null);
  const bal = useRpc<Balances>("get_leave_balances", { p_leave_year: year });
  const history = useRpc<RequestRow[]>("list_my_requests", { p_kind: "leave", p_limit: 10 });
  const shown = bal.data?.leave_year ?? year;

  return (
    <>
      <PageTitle title="Leave" back="/explore" />
      <div className="mx-auto flex max-w-xl flex-col gap-3 px-page pb-24 pt-2 md:max-w-3xl lg:max-w-5xl">
        {shown != null && (
          <div className="flex items-center">
            <button type="button" onClick={() => setYear(shown - 1)} aria-label="Previous leave year" className="grid size-12 place-items-center rounded-full">
              <Glyph name="chevron_right" className="rotate-180" />
            </button>
            <p className="flex-1 text-center text-title-md font-medium" aria-live="polite">
              Leave year {leaveYearLabel(shown, bal.data?.leave_year_start_month)}
            </p>
            <button type="button" onClick={() => setYear(shown + 1)} aria-label="Next leave year" className="grid size-12 place-items-center rounded-full">
              <Glyph name="chevron_right" />
            </button>
          </div>
        )}
        {bal.error ? (
          <ErrorState message={msg(bal.error, "Could not load balances.")} onRetry={() => bal.mutate()} />
        ) : !bal.data ? (
          <LoadingState />
        ) : bal.data.balances.length === 0 ? (
          <EmptyState art="beach" title="No leave types yet" body="Your Admin has not published leave types for this organisation." />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2" aria-label="Balances">
            {bal.data.balances.map((b) => (
              <li key={b.leave_type.id}>
                <SectionCard className="bg-leave-card">
                  <div className="flex items-center gap-2">
                    <p className="flex-1 text-title-md font-medium">{b.leave_type.name}</p>
                    {b.leave_type.paid ? (
                      <p className="text-leave-action">
                        <span className="text-[28px] font-bold">{b.available_units == null ? "∞" : plainDays(b.available_units)}</span>
                        {" days left"}
                      </p>
                    ) : (
                      <StatusChip label="Unpaid" tone="neutral" />
                    )}
                  </div>
                  {b.leave_type.paid && (
                    <dl className="mt-3 flex">
                      {(
                        [
                          ["Allocated", b.allocated_units],
                          ["Used", b.used_units],
                          ["Pending", b.reserved_units],
                          ...(b.expired_units > 0 ? ([["Expired", b.expired_units]] as [string, number][]) : []),
                        ] as [string, number][]
                      ).map(([label, units]) => (
                        <div key={label} className="flex-1">
                          <dt className="text-body-sm text-text-secondary">{label}</dt>
                          <dd className="text-[16px] font-semibold">{plainDays(units)}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </SectionCard>
              </li>
            ))}
          </ul>
        )}
        <h2 className="mt-3 text-title-md font-medium">Leave history</h2>
        {history.error ? (
          <ErrorState message={msg(history.error, "Could not load your leave.")} onRetry={() => history.mutate()} />
        ) : !history.data ? (
          <LoadingState />
        ) : history.data.length === 0 ? (
          <p className="p-4 text-body-md text-text-secondary">No leave requests yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {history.data.map((r) => {
              const s = stateOf(r.state);
              return (
                <li key={r.id}>
                  <Link href={`/requests/${r.id}`} className="flex items-center gap-3 rounded-row border border-border bg-surface p-3">
                    <span className="grid size-icon-tile shrink-0 place-items-center rounded-xl bg-leave-card">
                      <Art name="beach" size={28} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-title-sm font-semibold">{requestTitle(r)}</span>
                      <span className="block text-body-md text-text-secondary">
                        {requestDates(r)} · {daysLabel(r.units)}
                      </span>
                    </span>
                    <StatusChip label={s.label} tone={s.tone} />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <Link
        href="/leave/apply"
        className="fixed bottom-[calc(84px+env(safe-area-inset-bottom))] right-4 z-20 inline-flex h-14 items-center gap-2 rounded-2xl bg-leave-card px-4 text-[15px] font-semibold text-text shadow-[0_3px_8px_rgba(38,51,66,0.18)] md:bottom-6"
      >
        <Glyph name="add" />
        Apply leave
      </Link>
    </>
  );
}

/* ───────────────────────── Apply / edit ───────────────────────── */

function SlotPicker({ legend, value, options, onChange }: { legend: string; value: Slot; options: { value: Slot; label: string }[]; onChange: (s: Slot) => void }) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-body-md font-medium text-text-secondary">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <label
            key={o.value}
            className={cx(
              "inline-flex min-h-10 cursor-pointer items-center rounded-[20px] px-4 text-body-md font-semibold",
              value === o.value ? "bg-primary text-white" : "border border-border bg-surface text-text",
            )}
          >
            <input type="radio" className="sr-only" name={legend} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Debounced server preview. Answers are keyed by their inputs, so a late
 * answer for old dates is never shown for new ones. */
function usePreview(typeId: string, start: string, end: string, startSlot: Slot, endSlot: Slot, delay = 300) {
  const [result, setResult] = useState<{ key: string; preview: Preview } | null>(null);
  const ready = !!typeId && /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end) && end >= start;
  const key = ready ? [typeId, start, end, startSlot, endSlot].join("|") : "";
  useEffect(() => {
    if (!key) return;
    let live = true;
    const t = setTimeout(() => {
      rpc<Preview>("preview_leave", { p_leave_type_id: typeId, p_start_date: start, p_end_date: end, p_start_slot: startSlot, p_end_slot: endSlot })
        .then((p) => live && setResult({ key, preview: p }))
        .catch((e) => live && setResult({ key, preview: { valid: false, errors: { start_date: msg(e, "Could not check these dates.") } } }));
    }, delay);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key, typeId, start, end, startSlot, endSlot, delay]);
  const current = key && result?.key === key ? result.preview : null;
  return { preview: current, loading: !!key && !current };
}

export function LeaveApply({ editId, now = new Date() }: { editId?: string; now?: Date }) {
  const router = useRouter();
  const { context } = useSession();
  const isAdmin = caps(context).isAdmin;
  const tz = context?.org.timezone ?? "Asia/Kolkata";
  const today = todayIn(tz, now);
  const types = useRpc<LeaveType[]>("list_leave_types", { p_include_inactive: false });
  const bal = useRpc<Balances>("get_leave_balances", { p_leave_year: null });
  const existing = useRpc<RequestDetail>(editId ? "get_my_request" : null, { p_request_id: editId });

  const [typeId, setTypeId] = useState("");
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(today);
  const [startSlot, setStartSlot] = useState<Slot>("FULL");
  const [endSlot, setEndSlot] = useState<Slot>("FULL");
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [kept, setKept] = useState<string | null>(null);
  const uploaded = useRef<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<RequestDetail | null>(null);
  const loaded = useRef(false);
  const op = useRef<string | null>(null);

  // Fill the form once from the request being edited.
  useEffect(() => {
    const r = existing.data;
    if (!r || loaded.current) return;
    loaded.current = true;
    const p = currentPayload(r);
    setTypeId(String(p.leave_type_id ?? r.leave_type?.id ?? ""));
    setStart(String(p.start_date ?? r.start_date ?? today));
    setEnd(String(p.end_date ?? r.end_date ?? today));
    setStartSlot((p.start_slot as Slot) ?? "FULL");
    setEndSlot((p.end_slot as Slot) ?? "FULL");
    setReason(String(p.reason ?? ""));
    setKept(p.attachment_file_version_id ? String(p.attachment_file_version_id) : null);
  }, [existing.data, today]);

  const type = types.data?.find((t) => t.id === typeId);
  const single = start === end;
  const datesOk = /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end) && !Number.isNaN(Date.parse(start)) && !Number.isNaN(Date.parse(end)) && end >= start;
  const halfDay = type?.half_day_allowed ?? true;
  const slots = normalizeSlots(startSlot, endSlot, single, halfDay);
  const { preview, loading } = usePreview(typeId, start, end, slots.start, slots.end);
  const balance = bal.data?.balances.find((b) => b.leave_type.id === typeId);
  const after = type?.paid ? balanceAfter(balance?.available_units, preview?.units) : null;
  const previewErrors = useMemo(() => Object.values(preview?.errors ?? {}), [preview]);
  const editable = !existing.data || ["draft", "submitted", "returned"].includes(existing.data.state);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = leaveFormErrors({ typeId, start, end, reason, hasAttachment: !!file || !!kept }, type, today);
    setErrors(v);
    setError(null);
    if (Object.keys(v).length || fileProblem) return;
    setBusy(true);
    op.current ??= newOperationId();
    try {
      if (file && !uploaded.current) uploaded.current = await uploadFile(file, { cls: attachmentClass(type) });
      const r = await rpc<RequestDetail>("save_leave_request", {
        p_request_id: editId ?? null,
        p_leave_type_id: typeId,
        p_start_date: start,
        p_end_date: end,
        p_start_slot: slots.start,
        p_end_slot: single ? slots.start : slots.end,
        p_reason: reason.trim(),
        p_attachment_file_version_id: file ? uploaded.current : kept,
        p_submit: true,
        p_expected_version: existing.data?.version ?? null,
        p_operation_key: op.current,
      });
      op.current = null;
      setDone(r);
    } catch (x) {
      if (!(x instanceof ApiError && x.isNetwork)) op.current = null;
      if (x instanceof ApiError) {
        setErrors(mapLeaveFields(x.fieldErrors));
        setError(x.code === "STALE_VERSION" ? "This request changed since you opened it. Reload to see the latest version." : x.message);
      } else setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const title = editId ? "Edit leave" : "Apply for leave";
  if (editId && existing.error) {
    return (
      <>
        <PageTitle title={title} back="/requests" />
        <ErrorState message={msg(existing.error, "Could not load this request.")} onRetry={() => existing.mutate()} />
      </>
    );
  }
  return (
    <>
      <PageTitle title={title} back={editId ? `/requests/${editId}` : "/explore"} />
      <div className="mx-auto flex max-w-xl md:max-w-3xl lg:max-w-5xl flex-col gap-4 p-page">
        {done ? (
          <SectionCard className="bg-success-soft">
            <div role="status">
              <p className="text-title-md font-semibold text-success">{done.state === "approved" ? "Leave approved" : editId ? "Changes sent" : "Leave request sent"}</p>
              <p className="mt-1 text-body-md text-text">
                {requestTitle(done)} · {requestDates(done)} · {daysLabel(done.units)}.{" "}
                {done.state === "approved" ? "As Admin, your leave is approved straight away." : "You can edit it until your approver opens it."}
              </p>
            </div>
            <div className="mt-3 flex gap-4">
              <Link href={`/requests/${done.id}`} className="inline-flex min-h-12 items-center font-semibold text-primary">
                View request
              </Link>
              <Link href="/leave" className="inline-flex min-h-12 items-center font-semibold text-primary">
                Leave balance
              </Link>
            </div>
          </SectionCard>
        ) : (editId && !existing.data) || !types.data ? (
          types.error ? <ErrorState message={msg(types.error, "Could not load leave types.")} onRetry={() => types.mutate()} /> : <LoadingState />
        ) : !editable ? (
          <Banner tone="warning">This request can no longer be edited ({stateOf(existing.data!.state).label.toLowerCase()}).</Banner>
        ) : (
          <form noValidate onSubmit={submit} className="flex flex-col gap-4">
            {error && <Banner>{error}</Banner>}
            {existing.data?.state === "returned" && <Banner tone="warning">Your approver returned this request. Change what they asked for and send it again.</Banner>}
            <div>
              <label htmlFor="leave-type" className="mb-1.5 block text-body-md font-medium text-text-secondary">
                Leave type
              </label>
              <select
                id="leave-type"
                value={typeId}
                onChange={(e) => setTypeId(e.target.value)}
                aria-invalid={errors.leave_type_id ? true : undefined}
                className={cx("min-h-[52px] w-full rounded-input border bg-surface px-4 text-body-lg", errors.leave_type_id ? "border-error" : "border-border")}
              >
                <option value="">Choose…</option>
                {types.data.map((t) => {
                  const b = bal.data?.balances.find((x) => x.leave_type.id === t.id);
                  return (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.paid && b?.available_units != null ? ` · ${daysLabel(b.available_units)} left` : t.paid ? "" : " · unpaid"}
                    </option>
                  );
                })}
              </select>
              {errors.leave_type_id && <p className="mt-1 text-body-sm text-error">{errors.leave_type_id}</p>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <TextField
                label="From"
                type="date"
                value={start}
                onChange={(e) => {
                  setStart(e.target.value);
                  if (end < e.target.value) setEnd(e.target.value);
                }}
                error={errors.start_date}
              />
              <TextField label="To" type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} error={errors.end_date} />
            </div>
            {halfDay &&
              datesOk &&
              (single ? (
                <SlotPicker legend="Day" value={slots.start} options={slotOptions(true, "start", true)} onChange={(s) => setStartSlot(s)} />
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <SlotPicker legend={`First day (${dayLabel(start)})`} value={slots.start} options={slotOptions(false, "start", true)} onChange={setStartSlot} />
                  <SlotPicker legend={`Last day (${dayLabel(end)})`} value={slots.end} options={slotOptions(false, "end", true)} onChange={setEndSlot} />
                </div>
              ))}
            <TextArea label="Reason" value={reason} onChange={setReason} error={errors.reason} />
            {kept && !file ? (
              <div className="flex items-center justify-between rounded-input border border-border bg-surface px-4 py-3">
                <span className="text-body-md">Supporting document attached</span>
                <Button variant="text" type="button" onClick={() => setKept(null)}>
                  Replace
                </Button>
              </div>
            ) : (
              <FilePicker
                label={type?.requires_attachment ? "Supporting document" : "Supporting document (optional)"}
                cls={attachmentClass(type)}
                file={file}
                error={fileProblem ?? errors.attachment}
                hint={type?.attachment_class === "medical" ? "Medical certificate: PDF, JPG or PNG up to 5 MB. Only HR sees it." : "PDF, JPG or PNG up to 5 MB."}
                onChange={(f, p) => {
                  setFile(f);
                  setFileProblem(p);
                  uploaded.current = null;
                }}
              />
            )}
            {(preview || loading) && (
              <SectionCard className={previewErrors.length ? "bg-error-soft" : "bg-leave-card"}>
                <div aria-live="polite">
                  {loading && !preview ? (
                    <p className="text-body-md text-text-secondary">Checking these dates…</p>
                  ) : previewErrors.length ? (
                    <ul className="list-disc pl-5 text-body-md text-error">
                      {previewErrors.map((m) => (
                        <li key={m}>{m}</li>
                      ))}
                    </ul>
                  ) : preview ? (
                    <>
                      <p className="text-title-md font-semibold">{daysLabel(preview.units)} of leave</p>
                      <p className="text-body-sm text-text-secondary">Holidays and weekly offs are not counted.</p>
                      {preview.days && preview.days.length > 0 && (
                        <ul className="mt-2 text-body-md">
                          {preview.days.map((d) => (
                            <li key={d.day}>
                              {dayLabel(d.day)} — {SLOT_LABEL[d.slot]}
                            </li>
                          ))}
                        </ul>
                      )}
                      {after != null && <p className={cx("mt-2 font-semibold", after < 0 ? "text-error" : "text-text")}>Balance after: {daysLabel(after)}</p>}
                      {(preview.attendance_conflicts ?? 0) > 0 && (
                        <p className="mt-2 text-body-md text-warning">You already have attendance on {preview.attendance_conflicts} of these days. HR will need to resolve it before approving.</p>
                      )}
                    </>
                  ) : null}
                </div>
              </SectionCard>
            )}
            <p className="text-body-sm text-text-secondary">
              {isAdmin ? "As Admin, your leave is approved straight away. You can revoke it later with a reason." : "You can edit it until your approver opens it."}
            </p>
            <Button type="submit" busy={busy} disabled={previewErrors.length > 0}>
              {editId ? "Save and send" : "Send request"}
            </Button>
            {editId && (
              <Button type="button" variant="text" onClick={() => router.push(`/requests/${editId}`)}>
                Cancel
              </Button>
            )}
          </form>
        )}
      </div>
    </>
  );
}

/* ───────────────────────── Holidays ───────────────────────── */

export function HolidayCalendar({ initialYear, now = new Date() }: { initialYear?: number; now?: Date }) {
  const { context } = useSession();
  const today = todayIn(context?.org.timezone ?? "Asia/Kolkata", now);
  const [year, setYear] = useState(initialYear ?? Number(today.slice(0, 4)));
  const data = useRpc<HolidayYear>("list_holidays", { p_year: year });
  const split = data.data ? splitHolidays(data.data.holidays, today) : null;
  const all = split ? [...split.upcoming, ...split.past].sort((a, b) => a.date.localeCompare(b.date)) : [];
  const index = new Map(all.map((h, i) => [h.id, i]));

  const list = (title: string, items: typeof all) =>
    items.length > 0 && (
      <section aria-label={title} className="flex flex-col gap-2">
        <h2 className="text-title-md font-semibold">{title}</h2>
        <ul className="flex flex-col gap-2">
          {items.map((h) => (
            <li key={h.id} className="flex items-center gap-3 rounded-card border border-border bg-surface p-3">
              <Art name={holidayArt(index.get(h.id) ?? 0, year)} size={56} big />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{h.name}</p>
                <p className="text-body-md text-text-secondary">
                  {dayLabel(h.date)}
                  {h.office_name ? ` · ${h.office_name} only` : ""}
                </p>
              </div>
              {h.date === today && <StatusChip label="Today" tone="success" />}
            </li>
          ))}
        </ul>
      </section>
    );

  return (
    <>
      <PageTitle title="Holiday calendar" back="/explore" />
      <div className="mx-auto flex max-w-xl md:max-w-3xl lg:max-w-5xl flex-col gap-4 p-page">
        <div className="flex items-center justify-between">
          <Button variant="text" onClick={() => setYear(year - 1)} aria-label="Previous year">
            ‹ {year - 1}
          </Button>
          <p className="text-title-md font-semibold" aria-live="polite">
            {year}
          </p>
          <Button variant="text" onClick={() => setYear(year + 1)} aria-label="Next year">
            {year + 1} ›
          </Button>
        </div>
        {data.error ? (
          <ErrorState message={msg(data.error, "Could not load holidays.")} onRetry={() => data.mutate()} />
        ) : !data.data || !split ? (
          <LoadingState />
        ) : (
          <>
            <SectionCard className="bg-holiday-card">
              <p className="text-title-md font-semibold">
                {data.data.published_count} holiday{data.data.published_count === 1 ? "" : "s"} in {year}
              </p>
              <p className="text-body-md text-text-secondary">No attendance or leave is needed on published holidays.</p>
              {data.data.saturday_off_weeks > 0 && <p className="mt-1 text-body-md text-text-secondary">Saturdays off: {data.data.saturday_off_weeks} per month.</p>}
              {data.data.can_manage && (
                <Link href="/admin/leave-policies?tab=holidays" className="mt-2 inline-flex min-h-12 items-center font-semibold text-primary">
                  Manage holidays
                </Link>
              )}
            </SectionCard>
            {all.length === 0 ? (
              <EmptyState art="celebration" title="No holidays published for this year" />
            ) : (
              <>
                {list("Upcoming", split.upcoming)}
                {list("Past", split.past)}
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

/** Which upload class a leave type's document uses. */
export function attachmentClass(type: { attachment_class: string | null } | undefined): FileClass {
  return type?.attachment_class === "medical" ? "medical_attachment" : "leave_attachment";
}
