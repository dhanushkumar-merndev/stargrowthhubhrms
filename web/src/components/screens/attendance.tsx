"use client";

// attendance_screen.dart: month picker, totals and the day list.

import Link from "next/link";
import { useState } from "react";
import { dayLabel, dayStatus, duration, leaveSlotLabel, monthRange, todayIn, clock, type DayRow, type Totals } from "@/lib/attendance";
import { useSession } from "@/lib/session";
import { useRpc } from "@/lib/use-rpc";
import { attendanceFileName, attendanceRows, buildXlsx } from "@/lib/xlsx";
import { Button, EmptyState, ErrorState, LoadingState, PageTitle, SectionCard, StatusChip } from "../ui";
import { Glyph } from "../glyphs";

export function Attendance({ now = new Date() }: { now?: Date }) {
  const { context } = useSession();
  const tz = context?.org.timezone ?? "Asia/Kolkata";
  const today = todayIn(tz, now);
  const [delta, setDelta] = useState(0);
  const range = monthRange(today, delta);
  const q = useRpc<{ rows: DayRow[]; totals: Totals }>("list_my_attendance", { p_from: range.from, p_to: range.to });
  const rows = (q.data?.rows ?? []).filter((r) => r.shift_date <= today);

  return (
    <>
      <PageTitle title="My attendance" back="/home" />
      <div className="mx-auto flex max-w-xl md:max-w-3xl lg:max-w-5xl flex-col gap-4 p-page">
        <div className="flex items-center gap-2">
          <button type="button" aria-label="Previous month" onClick={() => setDelta((d) => d - 1)} className="grid size-12 place-items-center rounded-full">
            <Glyph name="arrow_back" />
          </button>
          <h2 className="flex-1 text-center text-title-md font-semibold" aria-live="polite">
            {range.label}
          </h2>
          <button
            type="button"
            aria-label="Next month"
            disabled={delta >= 0}
            onClick={() => setDelta((d) => Math.min(0, d + 1))}
            className="grid size-12 rotate-180 place-items-center rounded-full disabled:opacity-30"
          >
            <Glyph name="arrow_back" />
          </button>
        </div>

        {q.error ? (
          <ErrorState message={q.error.message} onRetry={() => void q.mutate()} />
        ) : !q.data ? (
          <LoadingState />
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3" aria-label="Month totals">
              <Stat label="Present" value={String(q.data.totals.present_days ?? 0)} />
              <Stat label="Late" value={String(q.data.totals.late_days ?? 0)} />
              <Stat label="Absent" value={String(q.data.totals.absent_days ?? 0)} />
              <Stat label="Worked" value={duration(q.data.totals.credited_seconds)} />
              <Stat label="Required" value={duration(q.data.totals.required_seconds)} />
              <Stat label="Short by" value={duration(q.data.totals.shortfall_seconds)} />
            </div>
            <div className="flex flex-wrap gap-3">
              <Button
                variant="outlined"
                disabled={rows.length === 0}
                onClick={() => {
                  const data = q.data;
                  if (!data) return;
                  saveFile(buildXlsx(range.label, attendanceRows(data.rows, data.totals, today)), attendanceFileName(range.from));
                }}
              >
                Download Excel
              </Button>
              <Link href={`/attendance/print?month=${range.from.slice(0, 7)}`} className="inline-flex min-h-12 items-center rounded-full px-4 font-semibold text-primary">
                Print / PDF
              </Link>
            </div>
            {rows.length === 0 ? (
              <EmptyState art="calendar" title="No days yet" body="Days appear here once your shifts start." />
            ) : (
              <ul className="flex flex-col gap-2">
                {rows.map((r) => {
                  const s = dayStatus(r);
                  const leave = leaveSlotLabel(r.leave_slots);
                  const fix = fixLink(r);
                  return (
                    <li key={r.shift_date}>
                      <Link href={`/attendance/${r.shift_date}`} className="block">
                        <SectionCard className="flex items-center gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="text-title-sm font-semibold">{dayLabel(r.shift_date)}</p>
                            <p className="text-body-md text-text-secondary">
                              {r.effective_in_at ? `${clock(r.effective_in_at, r.timezone)} – ${clock(r.effective_out_at, r.timezone)}` : "No punches"}
                              {r.credited_seconds > 0 && ` · ${duration(r.credited_seconds)}`}
                              {leave && ` · ${leave}`}
                            </p>
                          </div>
                          <StatusChip label={s.label} tone={s.tone} />
                        </SectionCard>
                      </Link>
                      {fix && (
                        <Link href={fix.href} className="mt-1 inline-flex min-h-12 items-center px-2 text-body-md font-semibold text-primary">
                          {fix.label}
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </>
  );
}

/** A self-service fix for a day that needs one (forgotten check-out, missing punch). */
export function fixLink(r: Pick<DayRow, "status" | "shift_date" | "effective_in_at" | "effective_out_at">): { href: string; label: string } | null {
  if (r.status !== "needs_correction") return null;
  if (r.effective_in_at && !r.effective_out_at) return { href: `/corrections/new?date=${r.shift_date}&fix=out`, label: `Fix check-out for ${dayLabel(r.shift_date)}` };
  return { href: `/corrections/new?date=${r.shift_date}`, label: `Request a correction for ${dayLabel(r.shift_date)}` };
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-row bg-surface px-3 py-3">
      <p className="text-body-sm text-text-secondary">{label}</p>
      <p className="text-title-md font-semibold">{value}</p>
    </div>
  );
}
