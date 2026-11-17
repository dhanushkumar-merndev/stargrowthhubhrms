"use client";

// Employee page → "Attendance" tab (HR/Admin): days and hours worked in a
// month, late marks, and the salary estimate. Figures come from
// get_month_summary, which counts machine punches, app check-ins, leave and
// the shift's grace (every 4 unexcused late days = 1 day of salary).

import { useState } from "react";
import { duration, monthRange } from "@/lib/attendance";
import { money } from "@/lib/people";
import { useRpc } from "@/lib/use-rpc";
import { Glyph } from "../glyphs";
import { ErrorState, KeyValue, LoadingState, SectionCard } from "../ui";

export type MonthSummary = {
  month: string;
  counted_to: string;
  days_in_month: number;
  worked_days?: number;
  worked_seconds?: number;
  workdays_so_far?: number;
  present_days: number;
  late_days: number;
  excused_late_days: number;
  late_penalty_days: number;
  lates_until_next_cut: number;
  unpaid_with_permission_days: number;
  unpaid_without_permission_days: number;
  paid_leave_days: number;
  medical_leave_days: number;
  outside_days: number;
  wfh_days: number;
  cut_days: number;
  monthly_salary?: number | string | null;
  currency?: string;
  per_day_amount?: number | string | null;
  estimated_deduction?: number | string | null;
  estimated_pay?: number | string | null;
};

const num = (v: number | string | null | undefined) => (v == null ? 0 : Number(v));
const days = (v: number | string | null | undefined) => {
  const n = num(v);
  return `${n % 1 ? n.toFixed(1) : n} ${n === 1 ? "day" : "days"}`;
};

export function EmployeeMonth({ employeeId, today, canSeePay }: { employeeId: string; today: string; canSeePay: boolean }) {
  const [delta, setDelta] = useState(0);
  const m = monthRange(today, delta);
  const q = useRpc<MonthSummary>("get_month_summary", { p_employee_id: employeeId, p_month: m.from });
  const s = q.data;

  return (
    <>
      <div className="flex items-center py-2">
        <button type="button" aria-label="Previous month" onClick={() => setDelta((d) => d - 1)} className="grid size-10 place-items-center rounded-full bg-attendance-card text-text">
          <Glyph name="chevron_right" className="rotate-180" />
        </button>
        <div className="flex-1 text-center" aria-live="polite">
          <h2 className="text-[17px] font-bold">{m.label}</h2>
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
      {q.error ? (
        <ErrorState message="Could not load this month." onRetry={() => q.mutate()} />
      ) : !s ? (
        <LoadingState />
      ) : (
        <>
          <SectionCard>
            <h3 className="mb-2 text-title-sm font-semibold">Worked</h3>
            <KeyValue k="Days worked" v={`${s.worked_days ?? s.present_days} of ${s.workdays_so_far ?? "—"} workdays`} />
            <KeyValue k="Hours worked" v={duration(s.worked_seconds ?? 0)} />
            <KeyValue k="Absent (no leave)" v={days(s.unpaid_without_permission_days)} />
            {num(s.paid_leave_days) + num(s.medical_leave_days) > 0 && (
              <KeyValue k="Paid leave" v={days(num(s.paid_leave_days) + num(s.medical_leave_days))} />
            )}
            {num(s.unpaid_with_permission_days) > 0 && <KeyValue k="Unpaid leave" v={days(s.unpaid_with_permission_days)} />}
            {num(s.outside_days) + num(s.wfh_days) > 0 && <KeyValue k="Outside work / WFH" v={days(num(s.outside_days) + num(s.wfh_days))} />}
            <p className="mt-2 text-body-sm text-text-secondary">Counted up to {s.counted_to}.</p>
          </SectionCard>
          <SectionCard>
            <h3 className="mb-2 text-title-sm font-semibold">Late</h3>
            <KeyValue k="Late days" v={String(s.late_days)} />
            {s.excused_late_days > 0 && <KeyValue k="Excused (approved request)" v={String(s.excused_late_days)} />}
            <KeyValue k="Salary days cut for lates" v={days(s.late_penalty_days)} />
            <p className="mt-2 text-body-sm text-text-secondary">
              Late = punched in after the shift start plus its grace. Every 4 late days in a month cut 1 day of salary
              {s.late_days % 4 ? ` · ${s.lates_until_next_cut} more until the next cut` : ""}.
            </p>
          </SectionCard>
          {canSeePay && (
            <SectionCard>
              <h3 className="mb-2 text-title-sm font-semibold">Salary estimate</h3>
              {s.monthly_salary == null ? (
                <p className="text-body-md text-text-secondary">No monthly salary is set. Add it in the Pay tab to see the estimate.</p>
              ) : (
                <>
                  <KeyValue k="Monthly salary" v={money(s.monthly_salary, s.currency)} />
                  <KeyValue k="Per day" v={`${money(s.per_day_amount, s.currency)} (÷ ${s.days_in_month} days)`} />
                  <KeyValue k="Days cut" v={`${days(s.cut_days)} (late ${num(s.late_penalty_days)} · absent ${num(s.unpaid_without_permission_days)} · unpaid leave ${num(s.unpaid_with_permission_days)})`} />
                  <KeyValue k="Deduction" v={money(s.estimated_deduction, s.currency)} />
                  <KeyValue k="Estimated pay" v={money(s.estimated_pay, s.currency)} />
                  <p className="mt-2 text-body-sm text-text-secondary">An estimate to prepare the payslip; it changes as the month goes on.</p>
                </>
              )}
            </SectionCard>
          )}
        </>
      )}
    </>
  );
}
