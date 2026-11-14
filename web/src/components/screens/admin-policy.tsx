"use client";

// leave_policies_screen.dart (policies, holidays, leave types),
// outside_work_screen.dart, sheet_sync_screen.dart, audit_screen.dart,
// maintenance health, announcements and the workspace summary.

import Link from "next/link";
import { useState } from "react";
import { rpc } from "@/lib/api";
import {
  type AuditRow,
  type LeaveTypeForm,
  type PolicyForm,
  AUDIT_AREAS,
  ORDINAL,
  actionLabel,
  auditCursor,
  bytesLabel,
  changeLines,
  dayCount,
  leaveTypeArgs,
  leaveTypeErrors,
  localDayStartIso,
  nextDay,
  policyErrors,
  satLabel,
  satWeeks,
  sheetId,
  storagePercent,
  unitsOf,
} from "@/lib/admin";
import { dayLabel, todayIn } from "@/lib/attendance";
import type { LeaveType } from "@/lib/leave";
import type { EmployeeRow, OrgStructure } from "@/lib/people";
import { caps } from "@/lib/roles";
import { useSession } from "@/lib/session";
import { useRpc } from "@/lib/use-rpc";
import { type Saved, Select, SheetForm, Toggle, activeOpts, useAction } from "../forms";
import { Banner, Button, EmptyState, ErrorState, KeyValue, LoadingState, PageTitle, PillTabs, SectionCard, StatusChip, TextArea, TextField, cx } from "../ui";
import { EmployeePicker } from "./payroll";

const msg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const days = (units: number | null | undefined) => (units == null ? "—" : `${units / 2} day${units === 2 ? "" : "s"}`);

function Page({ title, back = "/explore", children, action }: { title: string; back?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <>
      <PageTitle title={title} back={back} action={action} />
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-page">{children}</div>
    </>
  );
}

function State({ q, children }: { q: { data?: unknown; error?: unknown; mutate: () => unknown }; children: React.ReactNode }) {
  if (q.error) return <ErrorState message={msg(q.error, "Could not load this.")} onRetry={() => q.mutate()} />;
  if (q.data === undefined) return <LoadingState />;
  return <>{children}</>;
}

/* ───────────────────────── Leave policies, holidays, leave types ───────────────────────── */

type PolicyTab = "policies" | "holidays" | "types";

export function LeavePolicies({ initialTab = "policies", now = new Date() }: { initialTab?: PolicyTab; now?: Date }) {
  const { context } = useSession();
  const today = todayIn(context?.org.timezone ?? "Asia/Kolkata", now);
  const [tab, setTab] = useState<PolicyTab>(initialTab);
  return (
    <Page title="Leave and holidays">
      <PillTabs
        label="Section"
        tabs={[
          { id: "policies", label: "Entitlements" },
          { id: "holidays", label: "Holidays" },
          { id: "types", label: "Leave types" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "policies" && <PolicyPanel year={Number(today.slice(0, 4))} />}
      {tab === "holidays" && <HolidayPanel year={Number(today.slice(0, 4))} today={today} />}
      {tab === "types" && <TypesPanel />}
    </Page>
  );
}

interface Policy {
  id: string;
  leave_type: { id: string; code: string; name: string; paid: boolean };
  annual_units: number;
  carry_cap_units: number | null;
  carry_expiry_months: number | null;
  prorata: boolean;
  state: "draft" | "published" | string;
  published_at: string | null;
}

function PolicyPanel({ year: thisYear }: { year: number }) {
  const [year, setYear] = useState(thisYear);
  const q = useRpc<{ leave_year: number; leave_year_start_month: number; policies: Policy[] }>("list_leave_policies", { p_leave_year: year });
  const types = useRpc<LeaveType[]>("list_leave_types", { p_include_inactive: false });
  const [edit, setEdit] = useState<{ type: LeaveType; policy?: Policy } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pub = useAction();
  const paid = (types.data ?? []).filter((t) => t.paid);
  return (
    <>
      <Select label="Leave year" value={String(year)} onChange={(v) => setYear(Number(v))} options={[thisYear - 1, thisYear, thisYear + 1].map((y) => ({ value: String(y), label: String(y) }))} />
      {notice && <Banner tone="success">{notice}</Banner>}
      {pub.error && <Banner>{pub.error}</Banner>}
      <State q={q}>
        {paid.length === 0 ? (
          <EmptyState art="leave" title="No paid leave types" body="Add a paid leave type first." />
        ) : (
          paid.map((t) => {
            const p = q.data?.policies.find((x) => x.leave_type.id === t.id);
            return (
              <SectionCard key={t.id}>
                <div className="mb-1 flex items-center gap-2">
                  <h2 className="flex-1 text-title-sm font-semibold">
                    {t.name} <span className="font-normal text-text-secondary">· {t.code}</span>
                  </h2>
                  <StatusChip label={!p ? "Not set" : p.state === "published" ? "Published" : "Draft"} tone={!p ? "warning" : p.state === "published" ? "success" : "info"} />
                </div>
                {p && (
                  <>
                    <KeyValue k="Per year" v={days(p.annual_units)} />
                    <KeyValue k="Carry forward" v={p.carry_cap_units ? `Up to ${days(p.carry_cap_units)}${p.carry_expiry_months ? `, used within ${p.carry_expiry_months} months` : ""}` : "None"} />
                    <KeyValue k="New joiners" v={p.prorata ? "Pro-rata from joining" : "Full amount"} />
                  </>
                )}
                {p?.state !== "published" && (
                  <div className="flex gap-4">
                    <Button variant="text" onClick={() => setEdit({ type: t, policy: p })}>
                      {p ? "Edit" : "Set entitlement"}
                    </Button>
                    {p && (
                      <Button
                        variant="text"
                        busy={pub.busy}
                        onClick={() =>
                          pub.run(async () => {
                            await rpc("publish_leave_policy", { p_policy_id: p.id });
                            setNotice(`${t.name} for ${year} published. Balances are credited now.`);
                            await q.mutate();
                          }, "Could not publish.")
                        }
                      >
                        Publish
                      </Button>
                    )}
                  </div>
                )}
              </SectionCard>
            );
          })
        )}
      </State>
      {edit && (
        <PolicySheet
          type={edit.type}
          policy={edit.policy}
          year={year}
          onClose={() => setEdit(null)}
          onSaved={async () => {
            setEdit(null);
            setNotice("Draft saved. Publish it to credit balances.");
            await q.mutate();
          }}
        />
      )}
    </>
  );
}

function PolicySheet({ type, policy, year, onClose, onSaved }: { type: LeaveType; policy?: Policy; year: number } & Saved) {
  const [f, setF] = useState<PolicyForm>({
    annual_days: policy ? String(policy.annual_units / 2) : "",
    carry_cap_days: policy?.carry_cap_units ? String(policy.carry_cap_units / 2) : "",
    carry_expiry_months: policy?.carry_expiry_months != null ? String(policy.carry_expiry_months) : "",
    prorata: policy?.prorata ?? true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const a = useAction();
  return (
    <SheetForm
      title={`${type.name} · ${year}`}
      submit="Save draft"
      busy={a.busy}
      error={a.error}
      onClose={onClose}
      onSubmit={() => {
        const e = policyErrors(f);
        setErrors(e);
        if (Object.keys(e).length) return;
        a.run(async () => {
          await rpc("save_leave_policy", {
            p_leave_type_id: type.id,
            p_leave_year: year,
            p_annual_units: unitsOf(f.annual_days),
            p_carry_cap_units: f.carry_cap_days.trim() ? unitsOf(f.carry_cap_days) : null,
            p_carry_expiry_months: f.carry_expiry_months.trim() ? Number(f.carry_expiry_months) : null,
            p_prorata: f.prorata,
          });
          await onSaved();
        }, "Could not save.");
      }}
    >
      <TextField label="Days per year" inputMode="decimal" value={f.annual_days} onChange={(e) => setF({ ...f, annual_days: e.target.value })} error={errors.annual_days ?? a.fields.annual_units} hint="Half days allowed, like 12 or 7.5." />
      <TextField label="Carry forward up to (days, optional)" inputMode="decimal" value={f.carry_cap_days} onChange={(e) => setF({ ...f, carry_cap_days: e.target.value })} error={errors.carry_cap_days} />
      <TextField label="Carried days expire after (months, optional)" inputMode="numeric" value={f.carry_expiry_months} onChange={(e) => setF({ ...f, carry_expiry_months: e.target.value })} error={errors.carry_expiry_months} />
      <Toggle label="Pro-rata for people who join during the year" checked={f.prorata} onChange={(v) => setF({ ...f, prorata: v })} />
    </SheetForm>
  );
}

interface Holiday {
  id: string;
  date: string;
  name: string;
  state: "draft" | "published" | string;
  version: number;
  office_id: string | null;
  office_name: string | null;
  source: string | null;
}
interface HolidayList {
  year: number;
  target: number;
  can_manage: boolean;
  can_set_weekly_off: boolean;
  saturday_off_weeks: number;
  published_count: number;
  holidays: Holiday[];
}
interface Suggestion {
  id: string;
  date: string;
  name: string;
  category: string | null;
  state: string;
  existing_holiday: { id: string; name: string; state: string } | null;
}

function HolidayPanel({ year: thisYear, today }: { year: number; today: string }) {
  const [year, setYear] = useState(thisYear);
  const q = useRpc<HolidayList>("list_holidays", { p_year: year, p_office_id: null });
  const sugg = useRpc<{ suggestions: Suggestion[]; last_fetched_at: string | null }>(q.data?.can_manage ? "list_holiday_suggestions" : null, { p_year: year });
  const structure = useRpc<OrgStructure>("list_org_structure", {});
  const [edit, setEdit] = useState<Holiday | "new" | null>(null);
  const [weekly, setWeekly] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const a = useAction();
  const h = q.data;
  const drafts = (h?.holidays ?? []).filter((x) => x.state === "draft");
  const open = (sugg.data?.suggestions ?? []).filter((s) => s.state === "new" || s.state === "pending" || (!s.existing_holiday && s.state !== "dismissed" && s.state !== "added"));
  const act = (fn: () => Promise<unknown>, done: string) =>
    a.run(async () => {
      await fn();
      setNotice(done);
      await Promise.all([q.mutate(), sugg.mutate()]);
    }, "Could not save.");
  return (
    <>
      <Select label="Year" value={String(year)} onChange={(v) => setYear(Number(v))} options={[thisYear - 1, thisYear, thisYear + 1].map((y) => ({ value: String(y), label: String(y) }))} />
      {notice && <Banner tone="success">{notice}</Banner>}
      {a.error && <Banner>{a.error}</Banner>}
      <State q={q}>
        {h && (
          <>
            <SectionCard>
              <KeyValue k="Published" v={`${h.published_count} of ${h.target} planned`} />
              <KeyValue k="Weekly off" v={satLabel(h.saturday_off_weeks)} />
              <div className="flex flex-wrap gap-4">
                {h.can_manage && (
                  <Button variant="text" onClick={() => setEdit("new")}>
                    Add holiday
                  </Button>
                )}
                {h.can_set_weekly_off && (
                  <Button variant="text" onClick={() => setWeekly(true)}>
                    Saturdays off
                  </Button>
                )}
                {h.can_manage && drafts.length > 0 && (
                  <Button variant="text" busy={a.busy} onClick={() => act(() => rpc("publish_holidays", { p_ids: drafts.map((d) => d.id) }), `${drafts.length} holiday(s) published. Schedules are updated.`)}>
                    Publish {drafts.length} draft{drafts.length === 1 ? "" : "s"}
                  </Button>
                )}
              </div>
            </SectionCard>
            {h.holidays.length === 0 ? (
              <EmptyState art="holiday" title={`No holidays for ${year} yet`} />
            ) : (
              <ul className="flex flex-col gap-2">
                {h.holidays.map((x) => (
                  <li key={x.id} className="flex items-center gap-3 rounded-card border border-border bg-surface p-card">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">{x.name}</p>
                      <p className="text-body-sm text-text-secondary">
                        {dayLabel(x.date)} · {x.office_name ?? "All offices"}
                      </p>
                    </div>
                    <StatusChip label={x.state === "published" ? "Published" : "Draft"} tone={x.state === "published" ? "success" : "info"} />
                    {h.can_manage && x.state === "draft" && (
                      <>
                        <Button variant="text" onClick={() => setEdit(x)}>
                          Edit
                        </Button>
                        <Button variant="text" className="text-error" onClick={() => act(() => rpc("delete_holiday_draft", { p_id: x.id }), "Draft removed.")}>
                          Delete
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {open.length > 0 && (
              <SectionCard>
                <h2 className="mb-2 text-title-sm font-semibold">Suggested holidays</h2>
                {open.map((s) => (
                  <div key={s.id} className="flex items-center gap-2 border-b border-border py-2 last:border-0">
                    <span className="min-w-0 flex-1">
                      <span className="font-semibold">{s.name}</span> <span className="text-text-secondary">· {dayLabel(s.date)}</span>
                    </span>
                    <Button variant="text" onClick={() => act(() => rpc("add_holiday_from_suggestion", { p_id: s.id, p_office_id: null }), `${s.name} added as a draft.`)}>
                      Add
                    </Button>
                    <Button variant="text" onClick={() => act(() => rpc("dismiss_holiday_suggestion", { p_id: s.id }), "Suggestion dismissed.")}>
                      Dismiss
                    </Button>
                  </div>
                ))}
              </SectionCard>
            )}
          </>
        )}
      </State>
      {edit && (
        <HolidaySheet
          holiday={edit === "new" ? null : edit}
          year={year}
          today={today}
          offices={activeOpts(structure.data?.offices)}
          onClose={() => setEdit(null)}
          onSaved={async () => {
            setEdit(null);
            setNotice("Saved as a draft. Publish to add it to schedules.");
            await q.mutate();
          }}
        />
      )}
      {weekly && h && (
        <WeeklyOffSheet
          mask={h.saturday_off_weeks}
          onClose={() => setWeekly(false)}
          onSaved={async () => {
            setWeekly(false);
            setNotice("Weekly off updated. Future schedules are refreshed.");
            await q.mutate();
          }}
        />
      )}
    </>
  );
}

function HolidaySheet({ holiday, year, today, offices, onClose, onSaved }: { holiday: Holiday | null; year: number; today: string; offices: { value: string; label: string }[] } & Saved) {
  const [date, setDate] = useState(holiday?.date ?? (String(year) === today.slice(0, 4) ? today : `${year}-01-01`));
  const [name, setName] = useState(holiday?.name ?? "");
  const [office, setOffice] = useState(holiday?.office_id ?? "");
  const a = useAction();
  return (
    <SheetForm
      title={holiday ? "Edit holiday" : "Add holiday"}
      submit="Save draft"
      busy={a.busy}
      error={a.error}
      onClose={onClose}
      onSubmit={() => {
        if (!date || !date.startsWith(String(year))) return a.setError(`Choose a date in ${year}.`);
        if (name.trim().length < 2) return a.setError("Give the holiday a name.");
        a.run(async () => {
          await rpc("save_holiday", { p_id: holiday?.id ?? null, p_date: date, p_name: name.trim(), p_office_id: office || null, p_expected_version: holiday?.version ?? null });
          await onSaved();
        }, "Could not save the holiday.");
      }}
    >
      <TextField label="Date" type="date" min={`${year}-01-01`} max={`${year}-12-31`} value={date} onChange={(e) => setDate(e.target.value)} error={a.fields.date ?? a.fields.holiday_date} />
      <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} error={a.fields.name} />
      <Select label="Office" value={office} onChange={setOffice} options={offices} placeholder="All offices" />
    </SheetForm>
  );
}

function WeeklyOffSheet({ mask, onClose, onSaved }: { mask: number } & Saved) {
  const [weeks, setWeeks] = useState(satWeeks(mask));
  const a = useAction();
  return (
    <SheetForm
      title="Saturdays off"
      submit="Save"
      busy={a.busy}
      error={a.error}
      onClose={onClose}
      onSubmit={() =>
        a.run(async () => {
          await rpc("set_saturday_off_weeks", { p_weeks: weeks });
          await onSaved();
        }, "Could not save.")
      }
    >
      <p className="text-body-md text-text-secondary">Pick which Saturdays of each month are off. Shifts that include Saturday skip those days.</p>
      {[1, 2, 3, 4, 5].map((w) => (
        <Toggle key={w} label={`${ORDINAL[w - 1]} Saturday`} checked={weeks.includes(w)} onChange={(on) => setWeeks(on ? [...weeks, w].sort() : weeks.filter((x) => x !== w))} />
      ))}
    </SheetForm>
  );
}

function TypesPanel() {
  const q = useRpc<(LeaveType & { version: number; active: boolean })[]>("list_leave_types", { p_include_inactive: true });
  const [edit, setEdit] = useState<(LeaveType & { version: number; active: boolean }) | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <>
      {notice && <Banner tone="success">{notice}</Banner>}
      <Button variant="outlined" onClick={() => setEdit("new")}>
        Add leave type
      </Button>
      <State q={q}>
        <ul className="flex flex-col gap-2">
          {(q.data ?? []).map((t) => (
            <li key={t.id} className="flex items-center gap-3 rounded-card border border-border bg-surface p-card">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {t.name} <span className="font-normal text-text-secondary">· {t.code}</span>
                </p>
                <p className="text-body-sm text-text-secondary">
                  {[t.paid ? "Paid" : "Unpaid", t.half_day_allowed ? "Half days" : "Full days only", t.requires_attachment ? (t.attachment_class === "medical" ? "Medical certificate" : "Document needed") : null, t.backdate_days != null ? `Back-date ${t.backdate_days}d` : null, t.advance_notice_days ? `${t.advance_notice_days}d notice` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              {!t.active && <StatusChip label="Inactive" tone="neutral" />}
              <Button variant="text" onClick={() => setEdit(t)}>
                Edit
              </Button>
            </li>
          ))}
        </ul>
      </State>
      {edit && (
        <LeaveTypeSheet
          type={edit === "new" ? null : edit}
          onClose={() => setEdit(null)}
          onSaved={async () => {
            setEdit(null);
            setNotice("Leave type saved.");
            await q.mutate();
          }}
        />
      )}
    </>
  );
}

function LeaveTypeSheet({ type, onClose, onSaved }: { type: (LeaveType & { version: number; active: boolean }) | null } & Saved) {
  const t = type;
  const [f, setF] = useState<LeaveTypeForm>({
    code: t?.code ?? "",
    name: t?.name ?? "",
    paid: t?.paid ?? true,
    half_day_allowed: t?.half_day_allowed ?? true,
    requires_attachment: t?.requires_attachment ?? false,
    attachment_class: t?.attachment_class === "medical" ? "medical" : "general",
    max_consecutive_days: t?.max_consecutive_days != null ? String(t.max_consecutive_days) : "",
    advance_notice_days: t?.advance_notice_days != null ? String(t.advance_notice_days) : "",
    backdate_days: t?.backdate_days != null ? String(t.backdate_days) : "",
    active: t?.active ?? true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const a = useAction();
  const set = (k: keyof LeaveTypeForm) => (v: string | boolean) => setF({ ...f, [k]: v });
  const err = (k: string) => errors[k] ?? a.fields[k];
  return (
    <SheetForm
      title={t ? `Edit ${t.name}` : "Add leave type"}
      submit="Save"
      busy={a.busy}
      error={a.error}
      onClose={onClose}
      onSubmit={() => {
        const e = leaveTypeErrors(f);
        setErrors(e);
        if (Object.keys(e).length) return;
        a.run(async () => {
          await rpc("save_leave_type", leaveTypeArgs(t?.id ?? null, f, t?.version ?? null));
          await onSaved();
        }, "Could not save the leave type.");
      }}
    >
      <div className="grid grid-cols-3 gap-3">
        <TextField label="Code" value={f.code} maxLength={10} onChange={(e) => set("code")(e.target.value.toUpperCase())} error={err("code")} />
        <div className="col-span-2">
          <TextField label="Name" value={f.name} onChange={(e) => set("name")(e.target.value)} error={err("name")} />
        </div>
      </div>
      <Toggle label="Paid" checked={f.paid} onChange={set("paid")} hint="Paid types use an entitlement; unpaid ones deduct salary." />
      <Toggle label="Allow half days" checked={f.half_day_allowed} onChange={set("half_day_allowed")} />
      <Toggle label="Needs a supporting document" checked={f.requires_attachment} onChange={set("requires_attachment")} />
      <Select
        label="Document kind"
        value={f.attachment_class}
        onChange={(v) => set("attachment_class")(v)}
        options={[
          { value: "general", label: "General document" },
          { value: "medical", label: "Medical certificate (HR only)" },
        ]}
      />
      <div className="grid grid-cols-3 gap-3">
        <TextField label="Max days in a row" inputMode="numeric" value={f.max_consecutive_days} onChange={(e) => set("max_consecutive_days")(e.target.value)} error={err("max_consecutive_days")} />
        <TextField label="Notice (days)" inputMode="numeric" value={f.advance_notice_days} onChange={(e) => set("advance_notice_days")(e.target.value)} error={err("advance_notice_days")} />
        <TextField label="Back-date (days)" inputMode="numeric" value={f.backdate_days} onChange={(e) => set("backdate_days")(e.target.value)} error={err("backdate_days")} />
      </div>
      {t && <Toggle label="Active" checked={f.active} onChange={set("active")} />}
    </SheetForm>
  );
}

/* ───────────────────────── Outside work ───────────────────────── */

interface OutsideRow {
  id: string;
  work_date: string;
  reason: string | null;
  kind: "outside" | "wfh" | string;
  request_id: string | null;
  employee: { id: string; code: string; name: string };
}

export function OutsideWork({ initialKind = "", now = new Date() }: { initialKind?: "" | "outside" | "wfh"; now?: Date }) {
  const { context } = useSession();
  const today = todayIn(context?.org.timezone ?? "Asia/Kolkata", now);
  const [kind, setKind] = useState<"" | "outside" | "wfh">(initialKind);
  const [pages, setPages] = useState<OutsideRow[][]>([]);
  const q = useRpc<OutsideRow[]>("list_outside_work", { p_from: null, p_limit: 30, p_before_date: null, p_before_id: null, p_kind: kind || null });
  const [grant, setGrant] = useState(false);
  const [revoke, setRevoke] = useState<OutsideRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const rows = [...(q.data ?? []), ...pages.flat()];
  const last = rows[rows.length - 1];
  const loadMore = async () => {
    if (!last) return;
    setMore(true);
    try {
      const next = await rpc<OutsideRow[]>("list_outside_work", { p_from: null, p_limit: 30, p_before_date: last.work_date, p_before_id: last.id, p_kind: kind || null });
      setPages([...pages, next]);
    } finally {
      setMore(false);
    }
  };
  const reload = async () => {
    setPages([]);
    await q.mutate();
  };
  return (
    <Page
      title="Outside work and WFH"
      action={
        <Button variant="text" onClick={() => setGrant(true)}>
          Send out
        </Button>
      }
    >
      <PillTabs
        label="Kind"
        tabs={[
          { id: "", label: "All" },
          { id: "outside", label: "Outside work" },
          { id: "wfh", label: "Work from home" },
        ]}
        value={kind}
        onChange={(k) => {
          setKind(k);
          setPages([]);
        }}
      />
      {notice && <Banner tone="success">{notice}</Banner>}
      <State q={q}>
        {rows.length === 0 ? (
          <EmptyState art="outside" title="Nobody is marked outside" body="Outside-work days count as present without a punch at the office." />
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center gap-3 rounded-card border border-border bg-surface p-card">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">
                    {r.employee.name} <span className="font-normal text-text-secondary">· {r.employee.code}</span>
                  </p>
                  <p className="truncate text-body-sm text-text-secondary">
                    {dayLabel(r.work_date)} · {r.kind === "wfh" ? "Work from home" : "Outside work"}
                    {r.reason ? ` · ${r.reason}` : ""}
                  </p>
                </div>
                {r.request_id && (
                  <Link href={`/approvals/${r.request_id}`} className="text-body-md font-semibold text-primary">
                    Request
                  </Link>
                )}
                {r.work_date >= today && (
                  <Button variant="text" className="text-error" onClick={() => setRevoke(r)}>
                    Cancel
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {(q.data?.length ?? 0) >= 30 && (pages.length === 0 || pages[pages.length - 1].length >= 30) && (
          <Button variant="outlined" busy={more} onClick={loadMore}>
            Load more
          </Button>
        )}
      </State>
      {grant && (
        <GrantSheet
          today={today}
          onClose={() => setGrant(false)}
          onSaved={async (n: number) => {
            setGrant(false);
            setNotice(`${n} day(s) marked as outside work.`);
            await reload();
          }}
        />
      )}
      {revoke && (
        <RevokeOutsideSheet
          row={revoke}
          onClose={() => setRevoke(null)}
          onSaved={async () => {
            setRevoke(null);
            setNotice("Cancelled. The day is checked against punches again.");
            await reload();
          }}
        />
      )}
    </Page>
  );
}

function GrantSheet({ today, onClose, onSaved }: { today: string; onClose: () => void; onSaved: (n: number) => Promise<void> }) {
  const [people, setPeople] = useState<EmployeeRow[]>([]);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [reason, setReason] = useState("");
  const a = useAction();
  const n = dayCount(from, to);
  return (
    <SheetForm
      title="Send people out"
      submit="Save"
      busy={a.busy}
      error={a.error}
      onClose={onClose}
      onSubmit={() => {
        if (!people.length) return a.setError("Choose at least one person.");
        if (n == null) return a.setError("The last day must be on or after the first day.");
        if (n > 31) return a.setError("Pick up to 31 days.");
        if (reason.trim().length < 3) return a.setError("Give a reason (client visit, event…).");
        a.run(async () => {
          const r = await rpc<{ days_added: number }>("grant_outside_work", { p_employee_ids: people.map((p) => p.id), p_from: from, p_to: to, p_reason: reason.trim() });
          await onSaved(r?.days_added ?? 0);
        }, "Could not save.");
      }}
    >
      <EmployeePicker value={null} onChange={(e) => e && !people.some((p) => p.id === e.id) && setPeople([...people, e])} />
      {people.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Chosen people">
          {people.map((p) => (
            <li key={p.id} className="flex items-center gap-1 rounded-[20px] border border-border px-3 py-1 text-body-md">
              {p.name}
              <button type="button" aria-label={`Remove ${p.name}`} className="px-1 text-text-secondary" onClick={() => setPeople(people.filter((x) => x.id !== p.id))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-2 gap-3">
        <TextField label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <TextField label="To" type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      {n != null && <p className="text-body-sm text-text-secondary">{n} day(s) × {people.length || 0} people. Working days only.</p>}
      <TextArea label="Reason" value={reason} onChange={setReason} maxLength={500} />
    </SheetForm>
  );
}

function RevokeOutsideSheet({ row, onClose, onSaved }: { row: OutsideRow } & Saved) {
  const [reason, setReason] = useState("");
  const a = useAction();
  return (
    <SheetForm
      title="Cancel outside work?"
      submit="Cancel it"
      busy={a.busy}
      error={a.error}
      onClose={onClose}
      onSubmit={() => {
        if (reason.trim().length < 3) return a.setError("Give a reason.");
        a.run(async () => {
          await rpc("revoke_outside_work", { p_id: row.id, p_reason: reason.trim() });
          await onSaved();
        }, "Could not cancel.");
      }}
    >
      <p className="text-body-md">
        {row.employee.name} on {dayLabel(row.work_date)}.
      </p>
      <TextArea label="Reason" value={reason} onChange={setReason} maxLength={500} />
    </SheetForm>
  );
}

/* ───────────────────────── Google Sheet ───────────────────────── */

interface SheetSync {
  spreadsheet_id: string | null;
  enabled: boolean;
  include_salary: boolean;
  last_attempt_at?: string | null;
  last_synced_at?: string | null;
  last_error?: string | null;
}

export function SheetSyncScreen() {
  const q = useRpc<SheetSync>("get_sheet_sync", {});
  const [version, setVersion] = useState<number | null>(null);
  return (
    <Page title="Google Sheet">
      <State q={q}>{q.data && <SheetForm2 key={JSON.stringify(q.data)} s={q.data} version={version} setVersion={setVersion} reload={() => q.mutate()} />}</State>
    </Page>
  );
}

function SheetForm2({ s, version, setVersion, reload }: { s: SheetSync; version: number | null; setVersion: (v: number) => void; reload: () => unknown }) {
  const [link, setLink] = useState(s.spreadsheet_id ? `https://docs.google.com/spreadsheets/d/${s.spreadsheet_id}` : "");
  const [enabled, setEnabled] = useState(s.enabled);
  const [salary, setSalary] = useState(s.include_salary);
  const [done, setDone] = useState(false);
  const a = useAction();
  return (
    <>
      <SectionCard>
        <KeyValue k="Status" v={s.enabled ? "Syncing" : "Off"} />
        <KeyValue k="Last synced" v={s.last_synced_at ? new Date(s.last_synced_at).toLocaleString("en-IN") : "Never"} />
        {s.last_error && <Banner>Last attempt failed: {s.last_error}</Banner>}
      </SectionCard>
      <SectionCard>
        <div className="flex flex-col gap-3">
          {done && <Banner tone="success">Saved. The sheet updates within a few minutes.</Banner>}
          {a.error && <Banner>{a.error}</Banner>}
          <p className="text-body-md text-text-secondary">Share the sheet with the HRMS service account as an editor, then paste its link. Employee, attendance and leave tabs are kept up to date.</p>
          <TextField label="Sheet link" value={link} onChange={(e) => setLink(e.target.value)} error={a.fields.spreadsheet_id} />
          <Toggle label="Sync on" checked={enabled} onChange={setEnabled} />
          <Toggle label="Include salary and payslip amounts" checked={salary} onChange={setSalary} hint="Anyone with access to the sheet will see pay. Leave off unless the sheet is restricted." />
          <Button
            busy={a.busy}
            onClick={() => {
              const id = link.trim() ? sheetId(link) : null;
              if (link.trim() && !id) return a.setError("That does not look like a Google Sheet link.");
              if (enabled && !id) return a.setError("Add the sheet link first.");
              a.run(async () => {
                const r = await rpc<SheetSync & { version?: number }>("set_sheet_sync", { p_spreadsheet_id: id, p_enabled: enabled, p_include_salary: salary, p_expected_version: version ?? 0 });
                if (typeof r?.version === "number") setVersion(r.version);
                setDone(true);
                await reload();
              }, "Could not save.");
            }}
          >
            Save
          </Button>
        </div>
      </SectionCard>
    </>
  );
}

/* ───────────────────────── Audit ───────────────────────── */

const AUDIT_PAGE = 50;

export function Audit({ now = new Date() }: { now?: Date }) {
  const { context } = useSession();
  const tz = context?.org.timezone ?? "Asia/Kolkata";
  const today = todayIn(tz, now);
  const [area, setArea] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [extra, setExtra] = useState<AuditRow[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [more, setMore] = useState(false);
  const rangeBad = !!from && !!to && to < from;
  const base = { p_from: from ? localDayStartIso(from, tz) : null, p_to: to ? localDayStartIso(nextDay(to), tz) : null, p_actor_id: null, p_action_prefix: area || null, p_target_employee_id: null, p_limit: AUDIT_PAGE };
  const q = useRpc<AuditRow[]>(context && !rangeBad ? "list_audit" : null, { ...base, p_before_created_at: null, p_before_id: null });
  const rows = [...(q.data ?? []), ...extra];
  const cursor = auditCursor(extra.length ? extra : (q.data ?? []), AUDIT_PAGE);
  const reset = (fn: () => void) => {
    fn();
    setExtra([]);
  };
  return (
    <Page title="Audit log">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Select label="Area" value={area} onChange={(v) => reset(() => setArea(v))} options={AUDIT_AREAS} />
        <TextField label="From" type="date" max={today} value={from} onChange={(e) => reset(() => setFrom(e.target.value))} />
        <TextField label="To" type="date" max={today} value={to} onChange={(e) => reset(() => setTo(e.target.value))} error={rangeBad ? "Must be on or after From." : undefined} />
      </div>
      {!rangeBad && (
        <State q={q}>
          {rows.length === 0 ? (
            <EmptyState art="audit" title="Nothing recorded for these filters" />
          ) : (
            <ul className="flex flex-col gap-2">
              {rows.map((r) => {
                const lines = changeLines(r.changes);
                return (
                  <li key={r.id} className="rounded-card border border-border bg-surface p-card">
                    <button type="button" className="w-full text-left" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
                      <div className="flex items-center gap-2">
                        <p className="min-w-0 flex-1 truncate font-semibold">{actionLabel(r.action)}</p>
                        <StatusChip label={r.classification} tone={r.classification === "security" ? "error" : r.classification === "access" ? "warning" : "neutral"} />
                      </div>
                      <p className="text-body-sm text-text-secondary">
                        {new Date(r.created_at).toLocaleString("en-IN", { timeZone: tz, dateStyle: "medium", timeStyle: "short" })} · {r.actor?.name ?? "System"}
                        {r.target_employee ? ` → ${r.target_employee.name} (${r.target_employee.code})` : ""}
                      </p>
                    </button>
                    {open === r.id && (
                      <div className="mt-2 border-t border-border pt-2 text-body-sm">
                        {lines.length ? lines.map((l, i) => <p key={i}>{l}</p>) : <p className="text-text-secondary">No details.</p>}
                        {r.request_id && <p className="mt-1 font-mono text-text-secondary">Request {r.request_id}</p>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {cursor && (
            <Button
              variant="outlined"
              busy={more}
              onClick={async () => {
                setMore(true);
                try {
                  setExtra([...extra, ...(await rpc<AuditRow[]>("list_audit", { ...base, ...cursor }))]);
                } finally {
                  setMore(false);
                }
              }}
            >
              Load more
            </Button>
          )}
        </State>
      )}
    </Page>
  );
}

/* ───────────────────────── Jobs & health ───────────────────────── */

interface JobRun {
  name: string;
  runs: number;
  failures: number;
  last_run_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
}
interface Health {
  stale: boolean;
  outbox_backlog: number;
  outbox_failed: number;
  pending_uploads: number;
  last_tick: { at: string; ok: boolean } | null;
}

const JOB_LABEL: Record<string, string> = {
  "maintenance.tick": "Every-minute upkeep",
  "maintenance.daily": "Daily upkeep (archive, holidays, reminders)",
  "sessions.purge": "Expired sign-ins removed",
  "live_events.purge": "Old live events removed",
  "notifications.push": "Push notifications",
  "sheet.sync": "Google Sheet sync",
};

export function Jobs() {
  const runs = useRpc<JobRun[]>("list_job_runs", {}, { refreshInterval: 30_000 });
  const health = useRpc<Health>("get_maintenance_health", {}, { refreshInterval: 30_000 });
  const h = health.data;
  const when = (s: string | null) => (s ? new Date(s).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "Never");
  return (
    <Page title="Background jobs">
      <State q={health}>
        {h && (
          <SectionCard>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-title-sm font-semibold">Health</h2>
              <StatusChip label={h.stale ? "Stalled" : "Running"} tone={h.stale ? "error" : "success"} />
            </div>
            {h.stale && <Banner>Upkeep has not run recently. Check that the server is awake (UptimeRobot) and the database is reachable.</Banner>}
            <KeyValue k="Last upkeep" v={h.last_tick ? `${when(h.last_tick.at)}${h.last_tick.ok ? "" : " · failed"}` : "Never"} />
            <KeyValue k="Notifications waiting" v={`${h.outbox_backlog}${h.outbox_failed ? ` · ${h.outbox_failed} failed` : ""}`} />
            <KeyValue k="Uploads in progress" v={String(h.pending_uploads)} />
          </SectionCard>
        )}
      </State>
      <State q={runs}>
        <ul className="flex flex-col gap-2">
          {(runs.data ?? []).map((j) => (
            <li key={j.name} className="rounded-card border border-border bg-surface p-card">
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 font-semibold">{JOB_LABEL[j.name] ?? j.name}</p>
                <StatusChip label={j.last_error ? "Error" : j.runs ? "OK" : "Waiting"} tone={j.last_error ? "error" : j.runs ? "success" : "neutral"} />
              </div>
              <p className="text-body-sm text-text-secondary">
                Last run {when(j.last_run_at)} · {j.runs} runs{j.failures ? ` · ${j.failures} failed` : ""}
              </p>
              {j.last_error && <p className="mt-1 text-body-sm text-error">{j.last_error}</p>}
            </li>
          ))}
        </ul>
      </State>
    </Page>
  );
}

/* ───────────────────────── Announcement ───────────────────────── */

export function AnnouncementNew() {
  const structure = useRpc<OrgStructure>("list_org_structure", {});
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [team, setTeam] = useState("");
  const [sent, setSent] = useState<number | null>(null);
  const a = useAction();
  return (
    <Page title="Announcement" back="/workspace">
      {sent != null ? (
        <>
          <Banner tone="success">Sent to {sent} {sent === 1 ? "person" : "people"}.</Banner>
          <Button
            variant="outlined"
            onClick={() => {
              setSent(null);
              setTitle("");
              setBody("");
            }}
          >
            Write another
          </Button>
        </>
      ) : (
        <SectionCard>
          <form
            noValidate
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (title.trim().length < 3) return a.setError("Give it a title.");
              if (title.trim().length > 120) return a.setError("Keep the title under 120 characters.");
              if (body.length > 2000) return a.setError("Keep the message under 2000 characters.");
              a.run(async () => {
                const r = await rpc<{ recipients: number }>("publish_announcement", { p_title: title.trim(), p_body: body.trim() || null, p_team_id: team || null });
                setSent(r?.recipients ?? 0);
              }, "Could not send.");
            }}
          >
            {a.error && <Banner>{a.error}</Banner>}
            <TextField label="Title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} error={a.fields.title} />
            <TextArea label="Message" value={body} onChange={setBody} maxLength={2000} rows={6} />
            <Select label="Send to" value={team} onChange={setTeam} options={activeOpts(structure.data?.teams)} placeholder="Everyone" />
            <p className="text-body-sm text-text-secondary">People get a notification and see it in their inbox.</p>
            <Button type="submit" busy={a.busy}>
              Send
            </Button>
          </form>
        </SectionCard>
      )}
    </Page>
  );
}

/* ───────────────────────── Workspace ───────────────────────── */

interface Workspace {
  scope: "organization" | "team" | string;
  pending_reviews: number;
  unassigned_reviews: number;
  missed_punches_7d: number;
  team_today: { total: number; on_time: number; late: number; not_yet_in: number; out_of_office: number };
  storage?: { budget_bytes: number; used_bytes: number; reserved_bytes: number };
  admin_tasks: { label?: string; title?: string; href?: string; count?: number }[];
  week: { from: string; to: string; totals: { present_days: number; absent_days: number; late_days: number; leave_days: number; wfh_days: number; outside_days: number; shortfall_seconds: number } };
}

function Stat({ label, value, tone, href }: { label: string; value: number | string; tone?: "error" | "warning"; href?: string }) {
  const inner = (
    <>
      <p className={cx("text-headline-sm font-semibold", tone === "error" && "text-error", tone === "warning" && "text-warning")}>{value}</p>
      <p className="text-body-sm text-text-secondary">{label}</p>
    </>
  );
  return href ? (
    <Link href={href} className="rounded-card border border-border bg-surface p-card hover:bg-background">
      {inner}
    </Link>
  ) : (
    <div className="rounded-card border border-border bg-surface p-card">{inner}</div>
  );
}

export function WorkspaceScreen() {
  const { context } = useSession();
  const c = caps(context);
  const q = useRpc<Workspace>("get_workspace_summary", {}, { refreshInterval: 60_000 });
  const w = q.data;
  const tools = [
    { label: "Who's in", href: "/devices/live", show: true },
    { label: "Approvals", href: "/approvals", show: c.canReview },
    { label: "Hours report", href: "/reports/hours", show: c.canOrgReports },
    { label: "Employees", href: "/employees", show: c.canViewEmployees },
    { label: "Payslip uploads", href: "/payroll/uploads", show: c.canManagePayroll },
    { label: "Outside work", href: "/admin/outside-work", show: c.isHrOrAdmin },
    { label: "Announcement", href: "/announcements/new", show: c.canAnnounce },
    { label: "Attendance machines", href: "/devices", show: c.canManageDevices },
  ].filter((t) => t.show);
  return (
    <Page title="Workspace">
      <State q={q}>
        {w && (
          <>
            <p className="text-body-md text-text-secondary">{w.scope === "organization" ? "Whole organisation" : w.scope === "team" ? "Your teams" : "Your reviews"} · today</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="On time" value={w.team_today.on_time} />
              <Stat label="Late" value={w.team_today.late} tone={w.team_today.late ? "warning" : undefined} />
              <Stat label="Not in yet" value={w.team_today.not_yet_in} href="/devices/live" />
              <Stat label="Out of office" value={w.team_today.out_of_office} />
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label="Waiting for review" value={w.pending_reviews} tone={w.pending_reviews ? "warning" : undefined} href="/approvals" />
              {c.isAdmin && <Stat label="Unassigned reviews" value={w.unassigned_reviews} tone={w.unassigned_reviews ? "error" : undefined} href="/approvals?scope=unassigned" />}
              <Stat label="Missed punches (7 days)" value={w.missed_punches_7d} />
            </div>
            <SectionCard>
              <h2 className="mb-2 text-title-sm font-semibold">
                This week · {dayLabel(w.week.from)} – {dayLabel(w.week.to)}
              </h2>
              <KeyValue k="Present days" v={String(w.week.totals.present_days)} />
              <KeyValue k="Absent days" v={String(w.week.totals.absent_days)} />
              <KeyValue k="Late days" v={String(w.week.totals.late_days)} />
              <KeyValue k="Leave / WFH / outside" v={`${w.week.totals.leave_days} / ${w.week.totals.wfh_days} / ${w.week.totals.outside_days}`} />
              <KeyValue k="Hours short" v={`${Math.round(w.week.totals.shortfall_seconds / 360) / 10} h`} />
            </SectionCard>
            {w.storage && c.isAdmin && (
              <SectionCard>
                <KeyValue k="Storage" v={`${bytesLabel(w.storage.used_bytes + w.storage.reserved_bytes)} of ${bytesLabel(w.storage.budget_bytes)} (${storagePercent(w.storage.used_bytes, w.storage.reserved_bytes, w.storage.budget_bytes)}%)`} />
              </SectionCard>
            )}
            {w.admin_tasks.length > 0 && (
              <SectionCard>
                <h2 className="mb-2 text-title-sm font-semibold">Needs attention</h2>
                {w.admin_tasks.map((t, i) => (
                  <p key={i} className="py-1">
                    {t.href ? (
                      <Link href={t.href} className="font-semibold text-primary">
                        {t.label ?? t.title}
                      </Link>
                    ) : (
                      (t.label ?? t.title)
                    )}
                    {t.count != null ? ` (${t.count})` : ""}
                  </p>
                ))}
              </SectionCard>
            )}
          </>
        )}
      </State>
      <div className="grid grid-cols-2 gap-2">
        {tools.map((t) => (
          <Link key={t.href} href={t.href} className="inline-flex min-h-12 items-center justify-center rounded-button border border-border bg-surface px-3 text-center font-semibold text-primary">
            {t.label}
          </Link>
        ))}
      </div>
    </Page>
  );
}
