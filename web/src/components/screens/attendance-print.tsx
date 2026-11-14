"use client";

// A printable month of one's own attendance ("Save as PDF" from the print
// dialog gives the PDF; no PDF library needed).

import { type DayRow, type Totals, monthRange, todayIn } from "@/lib/attendance";
import { useSession } from "@/lib/session";
import { useRpc } from "@/lib/use-rpc";
import { ATTENDANCE_HEADER, attendanceRows } from "@/lib/xlsx";
import { Button, ErrorState, LoadingState, PageTitle } from "../ui";

export function AttendancePrint({ month, now = new Date() }: { month: string | null; now?: Date }) {
  const { context } = useSession();
  const tz = context?.org.timezone ?? "Asia/Kolkata";
  const today = todayIn(tz, now);
  const start = month && month <= today ? month : today;
  const range = monthRange(start, 0);
  const q = useRpc<{ rows: DayRow[]; totals: Totals }>("list_my_attendance", { p_from: range.from, p_to: range.to });
  const table = q.data ? attendanceRows(q.data.rows, q.data.totals, today) : [];
  const body = table.slice(1).filter((r) => r.length > 0);

  return (
    <>
      <div className="print:hidden">
        <PageTitle title="Print attendance" back="/attendance" />
      </div>
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-page print:max-w-none print:p-0">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-title-lg font-semibold">Attendance · {range.label}</h1>
            {context && (
              <p className="text-body-md text-text-secondary">
                {context.employee.name} ({context.employee.code}) · {context.org.name}
              </p>
            )}
          </div>
          <Button className="print:hidden" disabled={!q.data} onClick={() => window.print()}>
            Print / Save as PDF
          </Button>
        </div>
        {q.error ? (
          <ErrorState message={q.error.message} onRetry={() => void q.mutate()} />
        ) : !q.data ? (
          <LoadingState />
        ) : body.length <= 1 ? (
          <p className="text-body-md text-text-secondary">No days to show for this month yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-body-sm">
              <thead>
                <tr>
                  {ATTENDANCE_HEADER.map((h) => (
                    <th key={h} scope="col" className="border-b border-border px-2 py-1.5 text-left font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.map((r, i) => (
                  <tr key={i} className={i === body.length - 1 ? "font-semibold" : undefined}>
                    {r.map((c, j) => (
                      <td key={j} className="border-b border-border px-2 py-1.5">
                        {c ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-body-sm text-text-secondary">Generated {new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(now)} ({tz}).</p>
      </div>
    </>
  );
}
