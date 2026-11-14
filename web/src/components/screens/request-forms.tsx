"use client";

// correction_screen.dart and attendance_request_screen.dart: a correction for
// a day, a late-arrival excuse, and work from home.

import Link from "next/link";
import { useRef, useState } from "react";
import { addDays, correctionErrors, correctionInstants, dayLabel, todayIn } from "@/lib/attendance";
import { ApiError, newOperationId, rpc } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Banner, Button, PageTitle, SectionCard, TextField } from "../ui";

/** Same operation id across retries after a network error (idempotent save),
 * a new one once the server has answered. */
function useOperation() {
  const ref = useRef<string | null>(null);
  return {
    get: () => (ref.current ??= newOperationId()),
    settle: (e?: unknown) => {
      if (!(e instanceof ApiError && e.isNetwork)) ref.current = null;
    },
  };
}

function Done({ title, body, date }: { title: string; body: string; date?: string }) {
  return (
    <SectionCard className="bg-success-soft">
      <div role="status">
        <p className="text-title-md font-semibold text-success">{title}</p>
        <p className="mt-1 text-body-md text-text">{body}</p>
      </div>
      <div className="mt-3 flex gap-4">
        <Link href="/requests" className="inline-flex min-h-12 items-center font-semibold text-primary">
          My requests
        </Link>
        {date && (
          <Link href={`/attendance/${date}`} className="inline-flex min-h-12 items-center font-semibold text-primary">
            Back to the day
          </Link>
        )}
      </div>
    </SectionCard>
  );
}

function ReasonField({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string }) {
  return (
    <div>
      <label htmlFor="reason" className="mb-1.5 block text-body-md font-medium text-text-secondary">
        Reason
      </label>
      <textarea
        id="reason"
        value={value}
        maxLength={500}
        rows={4}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "reason-err" : undefined}
        className={`w-full rounded-input border bg-surface px-4 py-3 text-body-lg outline-none focus:outline-[1.6px] focus:outline-primary ${error ? "border-error" : "border-border"}`}
      />
      {error && (
        <p id="reason-err" className="mt-1 text-body-sm text-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function CorrectionForm({ initialDate, now = new Date() }: { initialDate?: string; now?: Date }) {
  const { context } = useSession();
  const tz = context?.org.timezone ?? "Asia/Kolkata";
  const today = todayIn(tz, now);
  const [date, setDate] = useState(initialDate ?? today);
  const [inTime, setIn] = useState("");
  const [outTime, setOut] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const op = useOperation();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = correctionErrors({ date, inTime, outTime, reason }, today);
    setErrors(v);
    setError(null);
    if (Object.keys(v).length) return;
    const { inAt, outAt } = correctionInstants(date, inTime, outTime, tz);
    setBusy(true);
    try {
      await rpc("save_correction_request", {
        p_request_id: null,
        p_shift_date: date,
        p_proposed_in_at: inAt,
        p_proposed_out_at: outAt,
        p_reason: reason.trim(),
        p_submit: true,
        p_expected_version: null,
        p_operation_key: op.get(),
      });
      op.settle();
      setDone(true);
    } catch (x) {
      op.settle(x);
      if (x instanceof ApiError) {
        setErrors(mapFields(x.fieldErrors));
        setError(x.message);
      } else setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const overnight = inTime && outTime && outTime < inTime;
  return (
    <>
      <PageTitle title="Request a correction" back={initialDate ? `/attendance/${initialDate}` : "/attendance"} />
      <div className="mx-auto flex max-w-xl flex-col gap-4 p-page">
        {done ? (
          <Done title="Correction sent" body={`HR will review your times for ${dayLabel(date)}.`} date={date} />
        ) : (
          <form noValidate onSubmit={submit} className="flex flex-col gap-4">
            {error && <Banner>{error}</Banner>}
            <TextField label="Date" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} error={errors.date} />
            <div className="grid grid-cols-2 gap-3">
              <TextField label="Checked in at" type="time" value={inTime} onChange={(e) => setIn(e.target.value)} error={errors.inTime} />
              <TextField
                label="Checked out at"
                type="time"
                value={outTime}
                onChange={(e) => setOut(e.target.value)}
                error={errors.outTime}
                hint={overnight ? `Next day (${dayLabel(addDays(date, 1))})` : undefined}
              />
            </div>
            <ReasonField value={reason} onChange={setReason} error={errors.reason} />
            <Button type="submit" busy={busy}>
              Send to HR
            </Button>
          </form>
        )}
      </div>
    </>
  );
}

function mapFields(f: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) {
    const key = k === "shift_date" || k === "start_date" ? "date" : k === "proposed_in_at" ? "inTime" : k === "proposed_out_at" ? "outTime" : k === "end_date" ? "endDate" : k;
    out[key] = v;
  }
  return out;
}

export function AttendanceRequestForm({ kind, initialDate, now = new Date() }: { kind: "wfh" | "late_excuse"; initialDate?: string; now?: Date }) {
  const { context } = useSession();
  const tz = context?.org.timezone ?? "Asia/Kolkata";
  const today = todayIn(tz, now);
  const wfh = kind === "wfh";
  const [from, setFrom] = useState(initialDate ?? today);
  const [to, setTo] = useState(initialDate ?? today);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const op = useOperation();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const v: Record<string, string> = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) v.date = "Choose a date.";
    else if (!wfh && from > today) v.date = "You can only excuse a past or current day.";
    if (wfh && (!/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from)) v.endDate = "The end date must be on or after the start date.";
    if (reason.trim().length < 5) v.reason = "Tell HR why (at least 5 characters).";
    setErrors(v);
    setError(null);
    if (Object.keys(v).length) return;
    setBusy(true);
    try {
      await rpc("save_attendance_request", {
        p_kind: kind,
        p_request_id: null,
        p_start_date: from,
        p_end_date: wfh ? to : null,
        p_reason: reason.trim(),
        p_submit: true,
        p_expected_version: null,
        p_operation_key: op.get(),
      });
      op.settle();
      setDone(true);
    } catch (x) {
      op.settle(x);
      if (x instanceof ApiError) {
        setErrors(mapFields(x.fieldErrors));
        setError(x.message);
      } else setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const title = wfh ? "Work from home" : "Explain late arrival";
  return (
    <>
      <PageTitle title={title} back={initialDate ? `/attendance/${initialDate}` : "/action"} />
      <div className="mx-auto flex max-w-xl flex-col gap-4 p-page">
        {done ? (
          <Done title="Request sent" body="HR will review it and you will be notified." date={wfh ? undefined : from} />
        ) : (
          <form noValidate onSubmit={submit} className="flex flex-col gap-4">
            {error && <Banner>{error}</Banner>}
            {wfh ? (
              <div className="grid grid-cols-2 gap-3">
                <TextField label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} error={errors.date} />
                <TextField label="To" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} error={errors.endDate} />
              </div>
            ) : (
              <TextField label="Date" type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value)} error={errors.date} />
            )}
            <ReasonField value={reason} onChange={setReason} error={errors.reason} />
            <Button type="submit" busy={busy}>
              Send to HR
            </Button>
          </form>
        )}
      </div>
    </>
  );
}
