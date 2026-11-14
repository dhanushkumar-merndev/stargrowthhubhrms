"use client";

// hours_report_screen.dart: HR/Admin hours per person for a date range,
// expandable to days, with CSV export (new on the web).

import { useState } from "react";
import { dayLabel, dayStatus, duration, monthRange, todayIn, type DayRow, type Totals } from "@/lib/attendance";
import { rpc } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useRpc } from "@/lib/use-rpc";
import { Banner, Button, EmptyState, ErrorState, LoadingState, PageTitle, SectionCard, StatusChip, TextField } from "../ui";
import { Glyph } from "../glyphs";

interface ReportRow {
  employee: { id: string; code: string; name: string; status: string };
  totals: Totals;
}
interface Report {
  rows: ReportRow[];
  total: number;
  totals: Totals;
}

export const PAGE = 25;

export function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  // Neutralise spreadsheet formulas and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function reportCsv(rows: ReportRow[]): string {
  const head = ["Employee code", "Name", "Present days", "Late days", "Absent days", "Leave days", "Worked hours", "Required hours", "Short hours"];
  const h = (s: number) => (Math.round((s / 3600) * 100) / 100).toFixed(2);
  const lines = rows.map((r) =>
    [
      r.employee.code,
      r.employee.name,
      r.totals.present_days,
      r.totals.late_days,
      r.totals.absent_days,
      r.totals.leave_days,
      h(r.totals.credited_seconds),
      h(r.totals.required_seconds),
      h(r.totals.shortfall_seconds),
    ]
      .map(csvCell)
      .join(","),
  );
  return [head.map(csvCell).join(","), ...lines].join("\r\n") + "\r\n";
}

export function HoursReport({ now = new Date() }: { now?: Date }) {
  const { context, caps } = useSession();
  const today = todayIn(context?.org.timezone ?? "Asia/Kolkata", now);
  const month = monthRange(today);
  const [from, setFrom] = useState(month.from);
  const [to, setTo] = useState(today);
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const valid = from <= to;
  const q = useRpc<Report>(caps.isHrOrAdmin && valid ? "get_hours_report" : null, {
    p_from: from,
    p_to: to,
    p_limit: PAGE,
    p_offset: page * PAGE,
  });

  if (!caps.isHrOrAdmin) {
    return (
      <>
        <PageTitle title="Hours report" back="/explore" />
        <EmptyState art="lock" title="Not available" body="Only HR and Admin can see the hours report." />
      </>
    );
  }

  const exportAll = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const all: ReportRow[] = [];
      for (let offset = 0; offset < 5000; offset += 100) {
        const r = await rpc<Report>("get_hours_report", { p_from: from, p_to: to, p_limit: 100, p_offset: offset });
        all.push(...r.rows);
        if (r.rows.length < 100 || all.length >= r.total) break;
      }
      const url = URL.createObjectURL(new Blob([reportCsv(all)], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `hours-${from}-to-${to}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / PAGE)) : 1;
  return (
    <>
      <PageTitle title="Hours report" back="/explore" />
      <div className="mx-auto flex max-w-xl flex-col gap-4 p-page">
        <div className="grid grid-cols-2 gap-3">
          <TextField label="From" type="date" value={from} max={to} onChange={(e) => (setFrom(e.target.value), setPage(0))} />
          <TextField label="To" type="date" value={to} min={from} onChange={(e) => (setTo(e.target.value), setPage(0))} />
        </div>
        {!valid && <Banner>The start date must be on or before the end date.</Banner>}
        {exportError && <Banner>{exportError}</Banner>}
        {q.error ? (
          <ErrorState message={q.error.message} onRetry={() => void q.mutate()} />
        ) : !valid ? null : !q.data ? (
          <LoadingState />
        ) : q.data.rows.length === 0 ? (
          <EmptyState art="insights" title="No one to report" body="No employees match this period." />
        ) : (
          <>
            <SectionCard>
              <p className="text-body-md text-text-secondary">
                {q.data.total} people · worked {duration(q.data.totals?.credited_seconds)} of {duration(q.data.totals?.required_seconds)}
              </p>
            </SectionCard>
            <ul className="flex flex-col gap-2">
              {q.data.rows.map((r) => (
                <li key={r.employee.id}>
                  <SectionCard>
                    <button
                      type="button"
                      aria-expanded={open === r.employee.id}
                      onClick={() => setOpen((o) => (o === r.employee.id ? null : r.employee.id))}
                      className="flex w-full items-center gap-3 text-left"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-title-sm font-semibold">{r.employee.name}</span>
                        <span className="block text-body-md text-text-secondary">
                          {r.employee.code} · {duration(r.totals.credited_seconds)} / {duration(r.totals.required_seconds)} · late{" "}
                          {r.totals.late_days} · absent {r.totals.absent_days}
                        </span>
                      </span>
                      <Glyph name="expand_more" className={open === r.employee.id ? "rotate-180" : ""} />
                    </button>
                    {open === r.employee.id && <Days employeeId={r.employee.id} from={from} to={to} />}
                  </SectionCard>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between">
              <Button variant="text" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <span className="text-body-md text-text-secondary">
                Page {page + 1} of {pages}
              </span>
              <Button variant="text" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
            <Button variant="outlined" busy={exporting} onClick={exportAll}>
              Download CSV
            </Button>
          </>
        )}
      </div>
    </>
  );
}

function Days({ employeeId, from, to }: { employeeId: string; from: string; to: string }) {
  const q = useRpc<{ rows: DayRow[] }>("get_hours_report_days", { p_employee_id: employeeId, p_from: from, p_to: to });
  if (q.error) return <p className="mt-3 text-body-md text-error">{q.error.message}</p>;
  if (!q.data) return <LoadingState />;
  return (
    <ul className="mt-3 flex flex-col divide-y divide-border">
      {q.data.rows.map((d) => {
        const s = dayStatus(d);
        return (
          <li key={d.shift_date} className="flex items-center gap-3 py-2">
            <span className="flex-1 text-body-md">{dayLabel(d.shift_date)}</span>
            <span className="text-body-md text-text-secondary">{duration(d.credited_seconds)}</span>
            <StatusChip label={s.label} tone={s.tone} />
          </li>
        );
      })}
    </ul>
  );
}
