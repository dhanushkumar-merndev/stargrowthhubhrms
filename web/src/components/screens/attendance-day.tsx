"use client";

// attendance_day_screen.dart: one day's schedule, punches, corrections and
// related requests, with shortcuts to fix it.

import Link from "next/link";
import { clock, dayLabel, dayStatus, duration, leaveSlotLabel, sourceLabel, type DayRow } from "@/lib/attendance";
import { useSession } from "@/lib/session";
import { useRpc } from "@/lib/use-rpc";
import { ActionRow, EmptyState, ErrorState, LoadingState, PageTitle, SectionCard, StatusChip } from "../ui";

interface Day extends DayRow {
  scheduled: boolean;
  own?: boolean;
  shift?: { name: string; start_local: string; end_local: string; grace_seconds: number } | null;
  events?: { id: string; action: "IN" | "OUT"; at: string; distance_m: number | null; accuracy_m: number | null; integrity_level: string | null }[];
  adjustments?: { revision: number; effective_in_at: string | null; effective_out_at: string | null; reason: string; approved_by: string | null }[];
  requests?: { id: string; kind: string; state: string; submitted_at: string | null }[];
  late_excuse?: { approved_by: string; at: string } | null;
}

const KIND: Record<string, string> = { correction: "Correction", late_excuse: "Late excuse", wfh: "Work from home", leave: "Leave" };

export function AttendanceDay({ date, employeeId }: { date: string; employeeId?: string }) {
  const { context } = useSession();
  const who = employeeId ?? context?.employee.id;
  const q = useRpc<Day>(who ? "get_attendance_day" : null, { p_employee_id: who, p_shift_date: date });
  const d = q.data;

  return (
    <>
      <PageTitle title={dayLabel(date)} back={employeeId ? undefined : "/attendance"} />
      <div className="mx-auto flex max-w-xl md:max-w-3xl lg:max-w-5xl flex-col gap-4 p-page">
        {q.error ? (
          <ErrorState message={q.error.message} onRetry={() => void q.mutate()} />
        ) : !d ? (
          <LoadingState />
        ) : !d.scheduled ? (
          <EmptyState art="event_busy" title="Nothing scheduled" body="There was no shift on this day." />
        ) : (
          <>
            <SectionCard>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-title-sm font-semibold">{d.shift?.name ?? "Shift"}</p>
                  <p className="text-body-md text-text-secondary">
                    {clock(d.start_at, d.timezone)} – {clock(d.end_at, d.timezone)}
                    {leaveSlotLabel(d.leave_slots) && ` · ${leaveSlotLabel(d.leave_slots)}`}
                  </p>
                </div>
                <StatusChip {...dayStatus(d)} />
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-body-md">
                <Item k="Checked in" v={clock(d.effective_in_at, d.timezone)} />
                <Item k="Checked out" v={clock(d.effective_out_at, d.timezone)} />
                <Item k="Worked" v={duration(d.credited_seconds)} />
                <Item k="Required" v={duration(d.required_seconds)} />
                {d.is_late && <Item k="Late by" v={`${duration(d.late_seconds)}${d.late_excused ? " (excused)" : ""}`} />}
                {d.is_early_departure && <Item k="Left early by" v={duration(d.early_seconds)} />}
                {d.shortfall_seconds > 0 && <Item k="Short by" v={duration(d.shortfall_seconds)} />}
                {d.extra_seconds > 0 && <Item k="Extra" v={duration(d.extra_seconds)} />}
              </dl>
              {d.effective_in_at && <p className="mt-3 text-body-sm text-text-secondary">{sourceLabel(d.effective_source)}</p>}
            </SectionCard>

            <section aria-labelledby="punches">
              <h2 id="punches" className="mb-2 text-title-sm font-semibold">
                Punches
              </h2>
              {(d.events ?? []).length === 0 ? (
                <p className="text-body-md text-text-secondary">No punches recorded.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {d.events!.map((e) => (
                    <li key={e.id}>
                      <SectionCard className="flex items-center gap-3">
                        <p className="min-w-0 flex-1 text-body-lg font-medium">
                          {e.action === "IN" ? "Check-in" : "Check-out"} · {clock(e.at, d.timezone)}
                        </p>
                        {e.distance_m != null && <span className="text-body-sm text-text-secondary">{Math.round(e.distance_m)} m away</span>}
                      </SectionCard>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {(d.adjustments ?? []).length > 0 && (
              <section aria-labelledby="adj">
                <h2 id="adj" className="mb-2 text-title-sm font-semibold">
                  Corrections applied
                </h2>
                <ul className="flex flex-col gap-2">
                  {d.adjustments!.map((a) => (
                    <li key={a.revision}>
                      <SectionCard>
                        <p className="text-body-md font-medium">
                          {clock(a.effective_in_at, d.timezone)} – {clock(a.effective_out_at, d.timezone)}
                        </p>
                        <p className="text-body-sm text-text-secondary">
                          {a.reason}
                          {a.approved_by && ` · approved by ${a.approved_by}`}
                        </p>
                      </SectionCard>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {(d.requests ?? []).length > 0 && (
              <section aria-labelledby="reqs">
                <h2 id="reqs" className="mb-2 text-title-sm font-semibold">
                  Requests for this day
                </h2>
                <ul className="flex flex-col gap-2">
                  {d.requests!.map((r) => (
                    <li key={r.id}>
                      <Link href={`/requests/${r.id}`}>
                        <SectionCard className="flex items-center justify-between">
                          <span className="text-body-md font-medium">{KIND[r.kind] ?? r.kind}</span>
                          <StatusChip label={r.state.replace(/_/g, " ")} tone={r.state === "approved" ? "success" : r.state === "rejected" ? "error" : "info"} />
                        </SectionCard>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {d.own !== false && !employeeId && (
              <div className="flex flex-col gap-2">
                <ActionRow
                  art="tile_fix_punch"
                  tile="bg-attendance-card"
                  label="Request a correction"
                  subtitle="Fix a missed or wrong punch"
                  href={`/corrections/new?date=${date}`}
                />
                {!d.is_required && d.presence_seconds >= 3 * 3600 && (
                  <ActionRow
                    art="event_available"
                    tile="bg-leave-card"
                    label="Request comp-off"
                    subtitle="You worked on a day off"
                    href={`/requests/new/comp-off?date=${date}`}
                  />
                )}
                {d.is_late && !d.late_excused && (
                  <ActionRow
                    art="schedule"
                    tile="bg-approvals-card"
                    label="Explain late arrival"
                    subtitle="Ask HR to excuse it"
                    href={`/requests/new/late?date=${date}`}
                  />
                )}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

function Item({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-body-sm text-text-secondary">{k}</dt>
      <dd className="font-medium">{v}</dd>
    </div>
  );
}
