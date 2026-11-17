"use client";

// attendance_screen.dart: list / calendar toggle, month bar, the "Worked this
// month" card, day rows (today first, upcoming days folded away), a calendar
// grid, and the "Fix a punch" button. Excel and print downloads are web extras.

import Link from "next/link";
import { useState } from "react";
import { clock, dayStatus, duration, leaveSlotLabel, monthRange, todayIn, type DayRow, type Totals } from "@/lib/attendance";
import { useSession } from "@/lib/session";
import { useRpc } from "@/lib/use-rpc";
import { attendanceFileName, attendanceRows, buildXlsx } from "@/lib/xlsx";
import { Glyph } from "../glyphs";
import { Art, EmptyState, ErrorState, LoadingState, PageTitle, cx, type Tone } from "../ui";

const TONE: Record<Tone, { bg: string; fg: string; border: string }> = {
  success: { bg: "bg-success-soft", fg: "text-success", border: "border-success" },
  warning: { bg: "bg-warning-soft", fg: "text-warning", border: "border-warning" },
  error: { bg: "bg-error-soft", fg: "text-error", border: "border-error" },
  info: { bg: "bg-attendance-card", fg: "text-primary", border: "border-primary" },
  neutral: { bg: "bg-[#eff1f4]", fg: "text-text-secondary", border: "border-text-secondary" },
};

function dateParts(ymd: string) {
  const d = new Date(`${ymd}T00:00:00Z`);
  return { day: d.getUTCDate(), weekday: d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }) };
}

export function Attendance({ now = new Date(), filter: initialFilter = null }: { now?: Date; filter?: string | null }) {
  const { context } = useSession();
  const tz = context?.org.timezone ?? "Asia/Kolkata";
  const today = todayIn(tz, now);
  const [delta, setDelta] = useState(0);
  const [calendar, setCalendar] = useState(false);
  const [showUpcoming, setShowUpcoming] = useState(false);
  const [filter, setFilter] = useState<string | null>(initialFilter);
  const range = monthRange(today, delta);
  const q = useRpc<{ rows: DayRow[]; totals: Totals }>("list_my_attendance", { p_from: range.from, p_to: range.to });
  const all = q.data?.rows ?? [];
  const rows = all.filter((r) => !filter || r.status === filter);
  const past = rows.filter((r) => r.shift_date <= today).sort((a, b) => b.shift_date.localeCompare(a.shift_date));
  const upcoming = rows.filter((r) => r.shift_date > today).sort((a, b) => a.shift_date.localeCompare(b.shift_date));

  return (
    <>
      <PageTitle
        title="Attendance"
        back="/home"
        action={
          <button type="button" aria-label={calendar ? "Show list" : "Show calendar"} onClick={() => setCalendar((c) => !c)} className="grid size-12 place-items-center rounded-full">
            <Art name={calendar ? "view_list" : "calendar"} size={24} />
          </button>
        }
      />
      <div className="mx-auto max-w-xl px-page pb-24 md:max-w-3xl lg:max-w-5xl">
        <div className="flex items-center py-2">
          <button type="button" aria-label="Previous month" onClick={() => setDelta((d) => d - 1)} className="grid size-10 place-items-center rounded-full bg-attendance-card text-text">
            <Glyph name="chevron_right" className="rotate-180" />
          </button>
          <div className="flex-1 text-center" aria-live="polite">
            <h2 className="text-[17px] font-bold">{range.label}</h2>
            {delta === 0 && <p className="text-[12px] text-text-secondary">This month</p>}
          </div>
          <button
            type="button"
            aria-label="Next month"
            disabled={delta >= 0}
            onClick={() => setDelta((d) => Math.min(0, d + 1))}
            className="grid size-10 place-items-center rounded-full bg-attendance-card text-text disabled:bg-[#eff1f4] disabled:opacity-40"
          >
            <Glyph name="chevron_right" />
          </button>
        </div>
        {filter && (
          <div className="mb-2">
            <span className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-border bg-surface pl-3 text-body-md font-medium">
              Needs correction
              <button type="button" aria-label="Remove filter" onClick={() => setFilter(null)} className="grid size-8 place-items-center">
                <Glyph name="close" size={18} />
              </button>
            </span>
          </div>
        )}

        {q.error ? (
          <ErrorState message={q.error.message} onRetry={() => void q.mutate()} />
        ) : !q.data ? (
          <LoadingState />
        ) : (
          <div className="flex flex-col gap-4">
            <TotalsCard totals={q.data.totals} inProgress={all.filter((r) => r.status === "in_progress").length} needsCorrection={all.filter((r) => r.status === "needs_correction").length} />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={past.length === 0}
                onClick={() => {
                  const data = q.data;
                  if (!data) return;
                  saveFile(buildXlsx(range.label, attendanceRows(data.rows.filter((r) => r.shift_date <= today), data.totals, today)), attendanceFileName(range.from));
                }}
                className="inline-flex min-h-12 items-center rounded-button border border-border bg-surface px-4 text-[15px] font-semibold text-primary disabled:opacity-40"
              >
                Download Excel
              </button>
              <Link href={`/attendance/print?month=${range.from.slice(0, 7)}`} className="inline-flex min-h-12 items-center rounded-button px-4 text-[15px] font-semibold text-primary">
                Print / PDF
              </Link>
            </div>
            {calendar ? (
              <CalendarGrid from={range.from} rows={rows} today={today} />
            ) : rows.length === 0 ? (
              <EmptyState art="event_note" title="No attendance days" body="There are no scheduled days for this period." />
            ) : (
              <>
                <ul className="flex flex-col gap-2">
                  {past.map((r) => (
                    <DayRowItem key={r.shift_date} r={r} today={today} />
                  ))}
                </ul>
                {upcoming.length > 0 && past.length > 0 && (
                  <button type="button" onClick={() => setShowUpcoming((s) => !s)} className="mx-auto flex min-h-12 items-center gap-1 px-3 text-[15px] font-semibold text-primary">
                    <Glyph name="expand_more" size={20} className={cx(showUpcoming && "rotate-180")} />
                    {showUpcoming ? "Hide upcoming days" : `Show ${upcoming.length} upcoming ${upcoming.length === 1 ? "day" : "days"}`}
                  </button>
                )}
                {(showUpcoming || past.length === 0) && upcoming.length > 0 && (
                  <ul className="flex flex-col gap-2" aria-label="Upcoming days">
                    {upcoming.map((r) => (
                      <DayRowItem key={r.shift_date} r={r} today={today} />
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
      </div>
      <Link
        href="/corrections/new"
        className="fixed bottom-[calc(84px+env(safe-area-inset-bottom))] right-4 z-20 inline-flex h-14 items-center gap-3 rounded-2xl bg-attendance-card px-4 text-[15px] font-semibold text-primary shadow-[0_3px_8px_rgba(38,51,66,0.18)] md:bottom-6"
      >
        <Art name="edit_calendar" size={24} />
        Fix a punch
      </Link>
    </>
  );
}

function TotalsCard({ totals, inProgress, needsCorrection }: { totals: Totals; inProgress: number; needsCorrection: number }) {
  const n = (v: number | undefined) => v ?? 0;
  const required = n(totals.required_seconds);
  const worked = n(totals.credited_seconds);
  const short = n(totals.shortfall_seconds);
  const extra = n(totals.extra_seconds);
  const progress = required <= 0 ? 0 : Math.min(1, worked / required);
  const counts: [number, string, Tone][] = [
    [n(totals.present_days), "Present", "success"],
    [n(totals.absent_days), "Absent", n(totals.absent_days) > 0 ? "error" : "neutral"],
    [n(totals.leave_days), "Leave", "info"],
  ];
  if (n(totals.late_days) > 0) counts.push([n(totals.late_days), "Late", "warning"]);
  if (inProgress > 0) counts.push([inProgress, "In progress", "info"]);
  if (needsCorrection > 0) counts.push([needsCorrection, "To fix", "error"]);
  return (
    <section aria-label="Month totals" className="rounded-card border border-border bg-surface p-card">
      <div className="flex items-center gap-3">
        <Art name="timer" size={44} />
        <div>
          <p className="text-[13px] text-text-secondary">Worked this month</p>
          <p className="mt-0.5">
            <span className="text-[24px] font-extrabold">{duration(worked)}</span>
            <span className="text-[14px] text-text-secondary">{`  of ${duration(required)}`}</span>
          </p>
        </div>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#eff1f4]" role="progressbar" aria-label={`Worked ${duration(worked)} of ${duration(required)}`} aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-success" style={{ width: `${progress * 100}%` }} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Metric label="Shortfall" value={duration(short)} tone={short > 0 ? "error" : "neutral"} />
        <Metric label="Extra time" value={duration(extra)} tone={extra > 0 ? "info" : "neutral"} />
      </div>
      <ul className="mt-3 grid grid-cols-3 gap-2">
        {counts.map(([count, label, tone]) => (
          <li key={label} aria-label={`${count} ${label}`} className={cx("rounded-[14px] py-2.5 text-center", TONE[tone].bg, TONE[tone].fg)}>
            <span aria-hidden className="block text-[20px] font-extrabold">
              {count}
            </span>
            <span aria-hidden className="block text-[12px] font-semibold">
              {label}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-body-sm text-text-secondary">
        {needsCorrection > 0
          ? "Days to fix are left out of the totals until you send a correction."
          : inProgress > 0
            ? "Today is added to the totals when you check out."
            : "Extra time is shown for information. It is not overtime pay."}
      </p>
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className={cx("rounded-[14px] px-3.5 py-2.5", TONE[tone].bg)}>
      <p className="text-[12px] text-text-secondary">{label}</p>
      <p className={cx("mt-0.5 text-[17px] font-bold", tone === "neutral" ? "text-text" : TONE[tone].fg)}>{value}</p>
    </div>
  );
}

const MODE: Record<string, string> = { outside: "Outside work", wfh: "Work from home" };

export function dayDetail(r: DayRow & { outside_reason?: string | null }): string {
  const tz = r.timezone;
  const mode = r.effective_source ? MODE[r.effective_source] : undefined;
  const source = r.effective_source === "manual" ? " · manual" : r.effective_source === "mixed" ? " · corrected" : "";
  const parts: string[] = [];
  if (mode) parts.push(`${mode}${!r.outside_reason || r.outside_reason === mode ? "" : ` · ${r.outside_reason}`} · no check-in needed`);
  else if (r.effective_in_at) parts.push(`${clock(r.effective_in_at, tz)} – ${r.effective_out_at ? clock(r.effective_out_at, tz) : "now"}${source}`);
  else if (r.is_required && r.start_at) parts.push(`Shift ${clock(r.start_at, tz)} – ${clock(r.end_at, tz)}`);
  const leave = leaveSlotLabel(r.leave_slots);
  if (leave) parts.push(leave);
  return parts.join(" · ");
}

function DayRowItem({ r, today }: { r: DayRow; today: string }) {
  const s = dayStatus(r);
  const t = TONE[s.tone];
  const isToday = r.shift_date === today;
  const { day, weekday } = dateParts(r.shift_date);
  const detail = dayDetail(r);
  return (
    <li>
      <Link
        href={`/attendance/${r.shift_date}`}
        aria-label={`${weekday} ${day}: ${s.label}${detail ? `, ${detail}` : ""}`}
        className={cx("flex items-center gap-3 rounded-row bg-surface p-3", isToday ? "border-[1.5px] border-primary/50" : "border border-border")}
      >
        <span className={cx("flex h-[54px] w-[50px] shrink-0 flex-col items-center justify-center rounded-xl", t.bg, t.fg)}>
          <span className="text-[19px] font-extrabold leading-[1.1]">{day}</span>
          <span className="text-[11px] font-semibold">{weekday}</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className={cx("truncate text-[15px] font-bold", t.fg)}>{s.label}</span>
            {isToday && <span className="rounded-md bg-primary px-1.5 py-0.5 text-[10px] font-bold text-white">Today</span>}
          </span>
          {detail && <span className="mt-[3px] block truncate text-[13px] text-text-secondary">{detail}</span>}
        </span>
        {r.status === "present" && (
          <span className="ml-1 text-right">
            <span className="block text-[15px] font-extrabold">{duration(r.credited_seconds)}</span>
            {r.shortfall_seconds > 0 && <span className="block text-[12px] font-semibold text-error">-{duration(r.shortfall_seconds)}</span>}
          </span>
        )}
        <Glyph name="chevron_right" size={20} className="text-[#B0B9C6]" />
      </Link>
      {fixLink(r) && (
        <Link href={fixLink(r)!.href} className="mt-1 inline-flex min-h-11 items-center px-2 text-body-md font-semibold text-primary">
          {fixLink(r)!.label}
        </Link>
      )}
    </li>
  );
}

function CalendarGrid({ from, rows, today }: { from: string; rows: DayRow[]; today: string }) {
  const byDate = new Map(rows.map((r) => [r.shift_date, r]));
  const first = new Date(`${from}T00:00:00Z`);
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // Monday first
  const ym = from.slice(0, 8);
  return (
    <section aria-label="Calendar" className="rounded-card border border-border bg-surface p-3">
      <div className="grid grid-cols-7 text-center text-[12px] font-bold text-text-secondary" aria-hidden>
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-7 gap-1.5">
        {Array.from({ length: lead }, (_, i) => (
          <span key={`l${i}`} />
        ))}
        {Array.from({ length: days }, (_, i) => {
          const d = i + 1;
          const date = `${ym}${String(d).padStart(2, "0")}`;
          const r = byDate.get(date);
          const s = r ? dayStatus(r) : { label: "No schedule", tone: "neutral" as Tone };
          const plain = !r || r.status === "upcoming";
          const cls = cx(
            "grid aspect-square place-items-center rounded-[10px] text-[14px]",
            plain ? "font-medium text-text-secondary" : cx("font-bold", TONE[s.tone].bg, TONE[s.tone].fg),
            date === today && "border-2 border-primary",
          );
          return r ? (
            <Link key={date} href={`/attendance/${date}`} aria-label={`${d}, ${s.label}`} className={cls}>
              {d}
            </Link>
          ) : (
            <span key={date} aria-label={`${d}, ${s.label}`} className={cls}>
              {d}
            </span>
          );
        })}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5 text-body-sm text-text-secondary">
        {(
          [
            ["success", "Present"],
            ["warning", "Late / pending"],
            ["error", "Absent / fix"],
            ["info", "Leave"],
            ["neutral", "Holiday / off"],
          ] as [Tone, string][]
        ).map(([tone, label]) => (
          <li key={label} className="flex items-center gap-1.5">
            <span className={cx("size-3.5 rounded border-[1.5px]", TONE[tone].bg, TONE[tone].border)} aria-hidden />
            {label}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A self-service fix for a day that needs one (forgotten check-out, missing punch). */
export function fixLink(r: Pick<DayRow, "status" | "shift_date" | "effective_in_at" | "effective_out_at">): { href: string; label: string } | null {
  if (r.status !== "needs_correction") return null;
  const label = new Date(`${r.shift_date}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  if (r.effective_in_at && !r.effective_out_at) return { href: `/corrections/new?date=${r.shift_date}&fix=out`, label: `Fix check-out for ${label}` };
  return { href: `/corrections/new?date=${r.shift_date}`, label: `Request a correction for ${label}` };
}

export function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
