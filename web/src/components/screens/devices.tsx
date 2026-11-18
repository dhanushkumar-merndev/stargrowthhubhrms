"use client";

// Attendance machines (eSSL) console for HR/Admin, ported from fingertipssl:
// Today board, live punch feed, unmatched PINs, machines, staff PINs.
// Live updates come from the SSE hub (ids only; everything is re-read).

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { ApiError, newOperationId, post, rpc } from "@/lib/api";
import { type OrgStructure, toCsv } from "@/lib/people";
import { Select, activeOpts } from "../forms";
import {
  COMMAND_KIND,
  COMMAND_STATUS,
  DAY_STATUS,
  SCAN_KIND,
  commandOpen,
  correctionErrors,
  countByStatus,
  deviceFormErrors,
  devicePayload,
  drift,
  formatLocal,
  isOnline,
  localTime,
  mergePunches,
  minutes,
  rejectionLabel,
  relative,
  suggestMatch,
  verifyLabel,
  windowError,
  type AttendanceDayBoard,
  type AttendanceDevice,
  type DayRow,
  type DeviceCommand,
  type EnrolStep,
  enrolFailure,
  enrolStep,
  openEnrolment,
  type DeviceForm,
  type DeviceLink,
  type DevicePunch,
  type EmployeeDeviceStatus,
  type EmployeeRef,
  type IngestRejection,
  type MachineUser,
  type UnmatchedPin,
  DEVICE_TABS as TABS,
  type DeviceTab as TabKey,
  type HireDefaults,
  type MachinePerson,
  hireDefaultsErrors,
  machineHireBody,
  machineHireName,
  machinePersonKey,
} from "@/lib/devices";
import { clock, todayIn } from "@/lib/attendance";
import { useLive, type Conn } from "@/lib/live";
import { caps } from "@/lib/roles";
import { employeeSignInUrl } from "@/lib/routing";
import { useSession } from "@/lib/session";
import { useRpc } from "@/lib/use-rpc";
import { SignInShare } from "../sign-in-share";
import { Banner, Button, EmptyState, ErrorState, LoadingState, PageTitle, SectionCard, Sheet, StatusChip, TextField, cx } from "../ui";


const msg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export function DevicesConsole({ initialTab = "today" }: { initialTab?: TabKey }) {
  const { context } = useSession();
  const [tab, setTab] = useState<TabKey>(initialTab);
  const c = caps(context);
  if (!context) return <LoadingState />;
  if (!c.canManageDevices) {
    return (
      <>
        <PageTitle title="Attendance machines" back="/action" />
        <div className="p-page">
          <EmptyState art="lock" title="Only HR and Admin can open this" />
        </div>
      </>
    );
  }
  const select = (k: TabKey) => {
    setTab(k);
    if (typeof window !== "undefined") window.history.replaceState(null, "", `/devices?tab=${k}`);
  };
  return (
    <>
      <PageTitle title="Attendance machines" back="/action" />
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-page">
        <div role="tablist" aria-label="Sections" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              type="button"
              aria-selected={tab === t.key}
              onClick={() => select(t.key)}
              className={cx(
                "min-h-10 shrink-0 rounded-[20px] px-4 text-body-md font-semibold",
                tab === t.key ? "bg-primary text-white" : "border border-border bg-surface text-text",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === "today" && <TodayBoard isAdmin={c.isAdmin} timezone={context.org.timezone} />}
        {tab === "live" && <LiveFeed timezone={context.org.timezone} />}
        {tab === "unmatched" && <Unmatched />}
        {tab === "machines" && <Machines isAdmin={c.isAdmin} />}
        {tab === "staff" && <StaffPins />}
      </div>
    </>
  );
}

export function ConnDot({ conn }: { conn: Conn }) {
  const label = { connecting: "Connecting…", live: "Live", offline: "Reconnecting…" }[conn];
  return (
    <span className="inline-flex items-center gap-1.5 text-body-sm text-text-secondary" data-conn={conn}>
      <span className={cx("size-2 rounded-full", conn === "live" ? "bg-success" : conn === "offline" ? "bg-error" : "bg-[#9aa1ac]")} />
      {label}
    </span>
  );
}

// ================================================================ Today

function TodayBoard({ isAdmin, timezone }: { isAdmin: boolean; timezone: string }) {
  const [picked, setPicked] = useState<string | null>(null);
  const day = useRpc<AttendanceDayBoard>("list_attendance_day", { p_date: picked });
  const conn = useLive(["device.day", "device.punch"], () => void day.mutate(), 400);
  const [open, setOpen] = useState<string | null>(null);
  const [fixing, setFixing] = useState<DayRow | null>(null);
  const [rules, setRules] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (day.error) return <ErrorState message={day.error.message} onRetry={() => void day.mutate()} />;
  if (!day.data) return <LoadingState />;
  const d = day.data;
  const s = d.settings;
  const counts = countByStatus(d.rows);
  const tz = s.timezone || timezone;

  return (
    <section className="flex flex-col gap-3" aria-label="Today">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-title-md font-semibold">{d.is_today ? "Today" : "Attendance"}</h2>
          <p className="text-body-sm text-text-secondary">One line per person: first IN, last OUT.</p>
        </div>
        <div className="flex items-center gap-2">
          <ConnDot conn={conn} />
          <input
            type="date"
            aria-label="Day"
            value={picked ?? s.today}
            max={s.today}
            onChange={(e) => setPicked(!e.target.value || e.target.value === s.today ? null : e.target.value)}
            className="min-h-10 rounded-input border border-border bg-surface px-2"
          />
          <Button variant="outlined" onClick={() => setRules(true)}>
            Rules
          </Button>
        </div>
      </div>
      <Banner tone="info">
        Repeat scans within {s.duplicate_window_minutes} minutes are ignored.{" "}
        {s.auto_checkout_enabled
          ? "Anyone still checked in at midnight is checked out automatically and marked “Forgot to check out”."
          : "Automatic check-out at midnight is off."}
      </Banner>
      {notice && <Banner tone="success">{notice}</Banner>}
      <div className="flex flex-wrap gap-2">
        {(Object.keys(DAY_STATUS) as (keyof typeof DAY_STATUS)[])
          .filter((k) => counts[k])
          .map((k) => (
            <StatusChip key={k} label={`${DAY_STATUS[k].label}: ${counts[k]}`} tone={DAY_STATUS[k].tone} />
          ))}
      </div>
      {d.rows.length === 0 ? (
        <EmptyState art="groups" title="No one to show" body="Active employees appear here once they have a machine PIN." />
      ) : (
        <ul className="flex flex-col gap-2">
          {d.rows.map((r) => (
            <li key={r.employee.id}>
              <SectionCard>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-title-sm font-semibold">{r.employee.name}</p>
                    <p className="text-body-sm text-text-secondary">
                      {r.employee.code}
                      {r.pins.length > 0 && ` · PIN ${r.pins.join(", ")}`}
                    </p>
                    <p className="mt-1 text-body-md tabular-nums">
                      In {clock(r.first_in_at, tz)} · Out {clock(r.out_at, tz)}
                      {r.out_source === "auto" && " (auto)"}
                      {r.out_source === "hr" && " (by HR)"} · {minutes(r.worked_minutes)}
                    </p>
                    {r.duplicate_count > 0 && (
                      <p className="text-body-sm text-text-secondary">
                        {r.duplicate_count === 1 ? "1 repeat scan ignored" : `${r.duplicate_count} repeat scans ignored`}
                      </p>
                    )}
                  </div>
                  <StatusChip label={DAY_STATUS[r.status]?.label ?? r.status} tone={DAY_STATUS[r.status]?.tone ?? "neutral"} />
                </div>
                <div className="mt-2 flex gap-2">
                  {r.scan_count > 0 && (
                    <Button variant="text" aria-expanded={open === r.employee.id} onClick={() => setOpen(open === r.employee.id ? null : r.employee.id)}>
                      {open === r.employee.id ? "Hide scans" : `Scans (${r.scan_count})`}
                    </Button>
                  )}
                  {r.first_in_at && (
                    <Button variant="text" onClick={() => setFixing(r)}>
                      Fix check-out
                    </Button>
                  )}
                </div>
                {open === r.employee.id && <Scans employeeId={r.employee.id} date={d.date} row={r} tz={tz} />}
              </SectionCard>
            </li>
          ))}
        </ul>
      )}
      {fixing && (
        <FixCheckout
          row={fixing}
          date={d.date}
          onClose={() => setFixing(null)}
          onSaved={(m) => {
            setFixing(null);
            setNotice(m);
            void day.mutate();
          }}
        />
      )}
      {rules && (
        <RulesForm
          settings={s}
          canEdit={isAdmin}
          onClose={() => setRules(false)}
          onSaved={(m) => {
            setRules(false);
            setNotice(m);
            void day.mutate();
          }}
        />
      )}
    </section>
  );
}

function Scans({ employeeId, date, row, tz }: { employeeId: string; date: string; row: DayRow; tz: string }) {
  // Re-read when the day row's scan counts change (a live punch arrived).
  const scans = useSWR(["day-scans", employeeId, date, row.scan_count, row.duplicate_count], () =>
    rpc<DevicePunch[]>("list_device_punches", { p_filters: { employee_id: employeeId, from: date, to: date, limit: 200 } }),
  );
  if (scans.error) return <p className="mt-2 text-body-sm text-error">{scans.error.message}</p>;
  if (!scans.data) return <p className="mt-2 text-body-sm text-text-secondary">Loading scans…</p>;
  const list = [...scans.data].sort((a, b) => (a.device_local_time < b.device_local_time ? -1 : 1));
  return (
    <div className="mt-2 border-t border-border pt-2">
      <ul className="flex flex-col gap-1.5">
        {list.map((s) => (
          <li key={s.id} className="flex items-center gap-2 text-body-md">
            <StatusChip label={SCAN_KIND[s.kind]?.label ?? s.kind} tone={SCAN_KIND[s.kind]?.tone ?? "neutral"} />
            <span className="tabular-nums">{localTime(s.device_local_time)}</span>
            <span className="text-body-sm text-text-secondary">
              {verifyLabel(s.verify_mode)} · {s.device_label ?? s.serial}
            </span>
          </li>
        ))}
      </ul>
      {row.correction && (
        <p className="mt-2 text-body-sm text-text-secondary">
          Check-out set to {clock(row.correction.out_at, tz)} by {row.correction.by ?? "HR"}: “{row.correction.reason}”
          {row.device_out_at && ` (machine check-out was ${clock(row.device_out_at, tz)})`}
        </p>
      )}
    </div>
  );
}

export function FixCheckout({ row, date, onClose, onSaved }: { row: DayRow; date: string; onClose: () => void; onSaved: (m: string) => void }) {
  const [outTime, setOutTime] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (clearing: boolean) => {
    const e = correctionErrors(outTime, reason, clearing);
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setError(null);
    try {
      await rpc("correct_attendance_day", {
        p_employee_id: row.employee.id,
        p_date: date,
        p_out_time: clearing ? null : outTime,
        p_reason: reason.trim(),
      });
      onSaved(clearing ? `Correction removed for ${row.employee.name}.` : `Check-out for ${row.employee.name} set to ${outTime}.`);
    } catch (err) {
      setError(msg(err, "Could not save."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={`Fix check-out · ${row.employee.name}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-body-md text-text-secondary">The machine scans stay as they were. This change is recorded with your name and the reason.</p>
        {error && <Banner>{error}</Banner>}
        <TextField label="Actual check-out time" type="time" value={outTime} onChange={(e) => setOutTime(e.target.value)} error={errors.outTime} />
        <TextField label="Reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} error={errors.reason} />
        <Button busy={busy} onClick={() => save(false)}>
          Save check-out
        </Button>
        {row.correction && (
          <Button variant="outlined" disabled={busy} onClick={() => save(true)}>
            Remove the correction
          </Button>
        )}
      </div>
    </Sheet>
  );
}

export function RulesForm({
  settings,
  canEdit,
  onClose,
  onSaved,
}: {
  settings: AttendanceDayBoard["settings"];
  canEdit: boolean;
  onClose: () => void;
  onSaved: (m: string) => void;
}) {
  const [win, setWin] = useState(String(settings.duplicate_window_minutes));
  const [auto, setAuto] = useState(settings.auto_checkout_enabled);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const winErr = windowError(win);
  const save = async () => {
    if (winErr) return;
    setBusy(true);
    setError(null);
    try {
      await rpc("save_attendance_settings", { p: { duplicate_window_minutes: Number(win), auto_checkout_enabled: auto } });
      onSaved("Attendance rules saved. A new duplicate window applies from today.");
    } catch (e) {
      setError(msg(e, "Could not save."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title="Attendance rules" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <ul className="list-disc pl-5 text-body-md text-text-secondary">
          <li>The first scan of the day is the check-in (IN).</li>
          <li>The last counted scan is the check-out (OUT); scans in between show as extra.</li>
          <li>The list starts fresh at midnight ({settings.timezone}).</li>
        </ul>
        {error && <Banner>{error}</Banner>}
        <TextField
          label="Duplicate window (minutes)"
          inputMode="numeric"
          value={win}
          disabled={!canEdit}
          onChange={(e) => setWin(e.target.value)}
          error={canEdit ? winErr : null}
        />
        <label className="flex min-h-12 items-center gap-3 text-body-md">
          <input type="checkbox" className="size-5" checked={auto} disabled={!canEdit} onChange={(e) => setAuto(e.target.checked)} />
          Check out anyone still in at midnight (marked “Forgot to check out”)
        </label>
        {canEdit ? (
          <Button busy={busy} disabled={!!winErr} onClick={save}>
            Save rules
          </Button>
        ) : (
          <p className="text-body-md text-text-secondary">Only an Admin can change these rules.</p>
        )}
      </div>
    </Sheet>
  );
}

// ================================================================ Live

export function LiveFeed({ timezone }: { timezone: string }) {
  const [todayOnly, setTodayOnly] = useState(true);
  const [unmatchedOnly, setUnmatchedOnly] = useState(false);
  const filters = useCallback(
    (extra: Record<string, unknown> = {}) => ({
      limit: 50,
      ...(todayOnly ? { from: todayIn(timezone) } : {}),
      ...(unmatchedOnly ? { unmatched: true } : {}),
      ...extra,
    }),
    [todayOnly, unmatchedOnly, timezone],
  );
  const feed = useRpc<DevicePunch[]>("list_device_punches", { p_filters: filters() });
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filtersRef = useRef(filters);
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  const conn = useLive(
    ["device.punch"],
    async (events) => {
      const ids = [...new Set(events.map((e) => String(e.payload.id ?? "")).filter(Boolean))];
      if (!ids.length) return;
      setLastEventAt(new Date().toISOString());
      try {
        const rows = await rpc<DevicePunch[]>("list_device_punches", { p_filters: filtersRef.current({ ids, limit: 100 }) });
        await feed.mutate((prev) => mergePunches(prev ?? [], ids, rows), { revalidate: false });
        setFresh((p) => new Set([...p, ...rows.map((r) => r.id)]));
        setTimeout(() => setFresh((p) => new Set([...p].filter((id) => !rows.some((r) => r.id === id)))), 3500);
        setError(null);
      } catch (e) {
        setError(msg(e, "Could not refresh punches."));
      }
    },
    120,
  );

  return (
    <section className="flex flex-col gap-3" aria-label="Live punches">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-title-md font-semibold">Live punches</h2>
          <p className="text-body-sm text-text-secondary">Machine scans as they arrive{lastEventAt ? ` · last ${relative(lastEventAt)}` : ""}.</p>
        </div>
        <ConnDot conn={conn} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Toggle on={todayOnly} onChange={setTodayOnly} label="Today only" />
        <Toggle on={unmatchedOnly} onChange={setUnmatchedOnly} label="Unmatched only" />
        <span className="text-body-sm text-text-secondary">{feed.data?.length ?? 0} shown</span>
      </div>
      {(error || feed.error) && <Banner>{error ?? feed.error!.message}</Banner>}
      {!feed.data && !feed.error && <LoadingState />}
      {feed.data?.length === 0 && (
        <EmptyState art="fingerprint" title="Waiting for punches…" body="Scans from registered machines appear here without refreshing." />
      )}
      <ul className="flex flex-col gap-2">
        {feed.data?.map((p) => (
          <li key={p.id} data-punch-id={p.id}>
            <SectionCard className={cx(fresh.has(p.id) && "ring-2 ring-primary")}>
              <div className="flex items-start gap-3">
                <span title={SCAN_KIND[p.kind]?.title}>
                  <StatusChip label={SCAN_KIND[p.kind]?.label ?? p.kind} tone={SCAN_KIND[p.kind]?.tone ?? "neutral"} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-title-sm font-semibold">
                    {p.employee ? `${p.employee.name} · ${p.employee.code}` : `Unmatched PIN ${p.pin}`}
                  </p>
                  <p className="text-body-sm text-text-secondary">
                    {p.device_label ?? p.serial} · {verifyLabel(p.verify_mode)} · PIN {p.pin}
                    {p.kind === "duplicate" && " · repeat scan (ignored)"}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-body-md tabular-nums" title="Machine clock">
                    {formatLocal(p.device_local_time)}
                  </p>
                  <p className="text-body-sm text-text-secondary" title="When the server received it">
                    received {relative(p.received_at)}
                  </p>
                </div>
              </div>
            </SectionCard>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      className={cx("min-h-10 rounded-[20px] px-3 text-body-md font-medium", on ? "bg-text text-white" : "border border-border bg-surface text-text")}
    >
      {label}
    </button>
  );
}

// ================================================================ Unmatched

export function Unmatched() {
  const groups = useRpc<UnmatchedPin[]>("list_unmatched_device_pins");
  const links = useRpc<DeviceLink[]>("list_device_user_links");
  const people = useRpc<EmployeeRef[]>("list_device_link_candidates");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<DeviceLink | null>(null);
  const reload = () => Promise.all([groups.mutate(), links.mutate()]);
  useLive(["device.punch"], () => void groups.mutate(), 300);

  const err = groups.error ?? links.error ?? people.error;
  if (err) return <ErrorState message={err.message} onRetry={() => void reload()} />;
  if (!groups.data || !links.data || !people.data) return <LoadingState />;

  const link = async (g: UnmatchedPin, employeeId: string, thisDeviceOnly: boolean) => {
    try {
      const res = await rpc<{ attached: number }>("link_device_user", {
        p_pin: g.pin,
        p_employee_id: employeeId,
        p_serial: thisDeviceOnly ? g.serial : null,
      });
      const who = people.data!.find((p) => p.id === employeeId)?.name ?? "the employee";
      setNotice({ ok: true, text: `PIN ${g.pin} linked to ${who}. ${res.attached} punch(es) attached.` });
      await reload();
    } catch (e) {
      setNotice({ ok: false, text: msg(e, "Could not link.") });
    }
  };
  const unlink = async (l: DeviceLink) => {
    setConfirm(null);
    try {
      await rpc("unlink_device_user", { p_link_id: l.id });
      setNotice({ ok: true, text: `PIN ${l.pin} unlinked. New punches from it will be unmatched.` });
      await reload();
    } catch (e) {
      setNotice({ ok: false, text: msg(e, "Could not unlink.") });
    }
  };

  return (
    <section className="flex flex-col gap-3" aria-label="Unmatched">
      <div>
        <MachinePeople onAdded={() => void reload()} />
        <h2 className="mt-4 text-title-md font-semibold">Unmatched punches</h2>
        <p className="text-body-sm text-text-secondary">Machine user numbers (PINs) not linked to anyone. Link one and its waiting punches attach to that person.</p>
      </div>
      {notice && <Banner tone={notice.ok ? "success" : "error"}>{notice.text}</Banner>}
      {groups.data.length === 0 && <EmptyState art="check_circle" title="Nothing waiting" body="Every punch is matched to an employee." />}
      {groups.data.map((g) => (
        <UnmatchedCard key={`${g.serial}|${g.pin}`} group={g} people={people.data!} onLink={link} />
      ))}
      <h2 className="mt-2 text-title-sm font-semibold">Linked PINs</h2>
      {links.data.length === 0 ? (
        <p className="text-body-md text-text-secondary">No PINs linked yet.</p>
      ) : (
        <SectionCard>
          <ul className="divide-y divide-border">
            {links.data.map((l) => (
              <li key={l.id} className="flex items-center gap-3 py-2">
                <span className="w-14 font-semibold tabular-nums">{l.pin}</span>
                <span className="min-w-0 flex-1">
                  {l.employee.name} <span className="text-text-secondary">· {l.employee.code}</span>
                  <span className="block text-body-sm text-text-secondary">{l.serial ? (l.device_label ?? l.serial) : "Any machine"}</span>
                </span>
                <Button variant="text" onClick={() => setConfirm(l)}>
                  Unlink
                </Button>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
      {confirm && (
        <Sheet title="Unlink PIN?" onClose={() => setConfirm(null)}>
          <p className="text-body-md">
            Unlink PIN {confirm.pin} from {confirm.employee.name}? Past punches stay with them.
          </p>
          <div className="mt-4 flex flex-col gap-2">
            <Button variant="danger" onClick={() => unlink(confirm)}>
              Unlink
            </Button>
            <Button variant="outlined" onClick={() => setConfirm(null)}>
              Keep
            </Button>
          </div>
        </Sheet>
      )}
    </section>
  );
}

function UnmatchedCard({
  group,
  people,
  onLink,
}: {
  group: UnmatchedPin;
  people: EmployeeRef[];
  onLink: (g: UnmatchedPin, employeeId: string, thisDeviceOnly: boolean) => Promise<void>;
}) {
  const suggested = suggestMatch(group.machine_name, people);
  // The suggestion is a live default until HR picks someone (it can appear
  // after the card does, when the machine reports its user names).
  const [picked, setPicked] = useState<string | null>(null);
  const employeeId = picked ?? suggested?.id ?? "";
  const setEmployeeId = setPicked;
  const [thisDeviceOnly, setThisDeviceOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const id = `emp-${group.serial}-${group.pin}`;
  return (
    <SectionCard>
      <p className="text-title-sm font-semibold">
        PIN {group.pin}
        {group.machine_name && <span className="font-normal"> · “{group.machine_name}” on the machine</span>}
      </p>
      <p className="text-body-sm text-text-secondary">
        {group.device_label ?? group.serial} · {group.punches} punch{group.punches === 1 ? "" : "es"} · {formatLocal(group.first_local)} →{" "}
        {formatLocal(group.last_local)}
      </p>
      {suggested && <p className="mt-1 text-body-sm text-primary">Suggested: {suggested.name} (check before linking)</p>}
      <form
        className="mt-3 flex flex-col gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!employeeId) return;
          setBusy(true);
          await onLink(group, employeeId, thisDeviceOnly);
          setBusy(false);
        }}
      >
        <label htmlFor={id} className="text-body-sm font-medium">
          Employee for PIN {group.pin}
        </label>
        <select id={id} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="min-h-12 rounded-input border border-border bg-surface px-3">
          <option value="">Choose employee…</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.code})
            </option>
          ))}
        </select>
        <label className="flex min-h-10 items-center gap-2 text-body-md">
          <input type="checkbox" className="size-5" checked={thisDeviceOnly} onChange={(e) => setThisDeviceOnly(e.target.checked)} />
          This machine only
        </label>
        <Button type="submit" busy={busy} disabled={!employeeId}>
          Link
        </Button>
      </form>
    </SectionCard>
  );
}

// ================================================================ Machines

export function Machines({ isAdmin }: { isAdmin: boolean }) {
  const devices = useRpc<AttendanceDevice[]>("list_attendance_devices", undefined, { refreshInterval: 15000 });
  const rejections = useRpc<IngestRejection[]>("list_device_ingest_rejections", { p_limit: 50 });
  const users = useRpc<MachineUser[]>("list_device_users");
  const commands = useRpc<DeviceCommand[]>("list_device_commands", { p_employee_id: null, p_limit: 30 });
  const offices = useRpc<{ id: string; name: string; active?: boolean }[]>(isAdmin ? "list_offices" : null);
  const [editing, setEditing] = useState<AttendanceDevice | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useLive(["device.command"], () => {
    void commands.mutate();
    void devices.mutate();
  });

  if (devices.error) return <ErrorState message={devices.error.message} onRetry={() => void devices.mutate()} />;
  if (!devices.data) return <LoadingState />;

  const cancel = async (id: number) => {
    try {
      await rpc("cancel_device_command", { p_command_id: id });
      await commands.mutate();
    } catch (e) {
      setError(msg(e, "Could not cancel."));
    }
  };

  return (
    <section className="flex flex-col gap-3" aria-label="Machines">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-title-md font-semibold">Machines</h2>
          <p className="text-body-sm text-text-secondary">Registered machines (only these serials are accepted).</p>
        </div>
        {isAdmin && <Button onClick={() => setEditing("new")}>Register a machine</Button>}
      </div>
      {!isAdmin && <Banner tone="info">Only an Admin can register or change machines.</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}
      {error && <Banner>{error}</Banner>}
      {devices.data.length === 0 && (
        <EmptyState art="fingerprint" title="No machines yet" body="Register the machine's serial number, then point it at this server (see the set-up guide)." />
      )}
      {devices.data.map((d) => {
        const online = isOnline(d);
        return (
          <SectionCard key={d.id}>
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-title-sm font-semibold">{d.label}</p>
                <p className="text-body-sm text-text-secondary">
                  {d.serial}
                  {d.office && ` · ${d.office}`} · {d.mode.toUpperCase()}
                  {d.has_token && " · token"}
                </p>
              </div>
              <StatusChip label={!d.active ? "Turned off" : online ? "Online" : "Not seen recently"} tone={!d.active ? "neutral" : online ? "success" : "warning"} />
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-body-md sm:grid-cols-3">
              <Item label="Last seen" value={relative(d.last_seen_at)} />
              <Item label="Last punch" value={relative(d.last_punch_received_at)} />
              <Item label="Punches today" value={String(d.punches_today)} />
              <Item label="Clock" value={drift(d.clock_drift_seconds)} />
              <Item label="Refused (24 h)" value={String(d.rejections_24h)} warn={d.rejections_24h > 0} />
              <Item label="Users on machine" value={String(d.machine_users)} />
              <Item label="Firmware" value={d.firmware ?? "—"} />
              <Item label="Commands from app" value={d.commands_enabled ? `On${d.open_commands ? ` · ${d.open_commands} waiting` : ""}` : "Off"} />
            </dl>
            {isAdmin && (
              <Button variant="text" className="mt-1" onClick={() => setEditing(d)}>
                Edit
              </Button>
            )}
          </SectionCard>
        );
      })}

      <h2 className="mt-2 text-title-sm font-semibold">Machine commands</h2>
      {!commands.data?.length ? (
        <p className="text-body-md text-text-secondary">No commands sent yet.</p>
      ) : (
        <SectionCard>
          <ul className="divide-y divide-border">
            {commands.data.map((c) => (
              <li key={c.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-body-md font-medium">
                    {COMMAND_KIND[c.kind] ?? c.kind} · PIN {c.pin}
                    {c.employee && ` · ${c.employee.name}`}
                  </p>
                  <p className="text-body-sm text-text-secondary">
                    {c.device_label ?? c.serial} · {relative(c.created_at)}
                    {c.return_code != null && c.return_code !== 0 && ` · machine said ${c.return_code}`}
                  </p>
                </div>
                <StatusChip label={COMMAND_STATUS[c.status]?.label ?? c.status} tone={COMMAND_STATUS[c.status]?.tone ?? "neutral"} />
                {commandOpen(c.status) && (
                  <Button variant="text" onClick={() => cancel(c.id)}>
                    Cancel
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <h2 className="mt-2 text-title-sm font-semibold">Users on the machines</h2>
      {!users.data?.length ? (
        <p className="text-body-md text-text-secondary">The machines have not reported their users yet.</p>
      ) : (
        <SectionCard>
          <ul className="divide-y divide-border">
            {users.data.map((u) => (
              <li key={`${u.serial}|${u.pin}`} className="flex items-center gap-3 py-2 text-body-md">
                <span className="w-14 font-semibold tabular-nums">{u.pin}</span>
                <span className="min-w-0 flex-1">
                  {u.name ?? "No name"}
                  {u.is_device_admin && <span className="text-warning"> · machine admin</span>}
                  <span className="block text-body-sm text-text-secondary">
                    {u.device_label} · {u.linked_to ? `linked to ${u.linked_to.name}` : "not linked"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <h2 className="mt-2 text-title-sm font-semibold">Refused traffic</h2>
      {!rejections.data?.length ? (
        <p className="text-body-md text-text-secondary">Nothing refused.</p>
      ) : (
        <SectionCard>
          <ul className="divide-y divide-border">
            {rejections.data.map((r) => (
              <li key={r.id} className="py-2 text-body-md">
                <span className="font-medium">{rejectionLabel(r.code)}</span>
                <span className="block text-body-sm text-text-secondary">
                  {r.serial ?? "unknown serial"} · {relative(r.created_at)}
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {editing && (
        <MachineForm
          device={editing === "new" ? null : editing}
          offices={(offices.data ?? []).filter((o) => o.active !== false)}
          onClose={() => setEditing(null)}
          onSaved={(m) => {
            setEditing(null);
            setNotice(m);
            void devices.mutate();
          }}
        />
      )}
    </section>
  );
}

function Item({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <dt className="text-body-sm text-text-secondary">{label}</dt>
      <dd className={cx("font-medium", warn && "text-warning")}>{value}</dd>
    </div>
  );
}

export function MachineForm({
  device,
  offices,
  onClose,
  onSaved,
}: {
  device: AttendanceDevice | null;
  offices: { id: string; name: string }[];
  onClose: () => void;
  onSaved: (m: string) => void;
}) {
  const editing = !!device;
  const [f, setF] = useState<DeviceForm>({
    serial: device?.serial ?? "",
    label: device?.label ?? "",
    officeId: device?.office_id ?? "",
    mode: device?.mode ?? "http",
    active: device?.active ?? true,
    token: "",
    tokenAction: editing ? "keep" : "set",
  });
  const [commands, setCommands] = useState(device?.commands_enabled ?? false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<DeviceForm>) => setF((x) => ({ ...x, ...p }));
  const save = async () => {
    const form = !editing && !f.token ? { ...f, tokenAction: "keep" as const } : f;
    const e = deviceFormErrors(form, editing);
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await rpc<{ id: string; serial: string }>("save_attendance_device", { p_device: devicePayload(form, device?.id) });
      if (commands !== (device?.commands_enabled ?? false)) {
        await rpc("set_device_commands", { p_device_id: saved.id, p_enabled: commands });
      }
      onSaved(editing ? `${form.label.trim()} saved.` : `${saved.serial} registered. Point the machine at this server.`);
    } catch (err) {
      setError(msg(err, "Could not save."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={editing ? "Edit machine" : "Register a machine"} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {error && <Banner>{error}</Banner>}
        <TextField label="Serial number" value={f.serial} disabled={editing} onChange={(e) => set({ serial: e.target.value })} error={errors.serial} hint={editing ? "A serial cannot be changed." : "Menu → System info on the machine."} />
        <TextField label="Name" value={f.label} maxLength={80} onChange={(e) => set({ label: e.target.value })} error={errors.label} />
        <label className="flex flex-col gap-1 text-body-sm font-medium">
          Office
          <select value={f.officeId} onChange={(e) => set({ officeId: e.target.value })} className="min-h-12 rounded-input border border-border bg-surface px-3 text-body-md font-normal">
            <option value="">No office</option>
            {offices.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-body-sm font-medium">
          Connection
          <select value={f.mode} onChange={(e) => set({ mode: e.target.value as "http" | "https" })} className="min-h-12 rounded-input border border-border bg-surface px-3 text-body-md font-normal">
            <option value="http">HTTP (through the relay)</option>
            <option value="https">HTTPS (direct)</option>
          </select>
        </label>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-body-sm font-medium">Device token (optional)</legend>
          {editing && (
            <select value={f.tokenAction} onChange={(e) => set({ tokenAction: e.target.value as DeviceForm["tokenAction"] })} className="min-h-12 rounded-input border border-border bg-surface px-3">
              <option value="keep">{device?.has_token ? "Keep the current token" : "No token"}</option>
              <option value="set">Set a new token</option>
              {device?.has_token && <option value="remove">Remove the token</option>}
            </select>
          )}
          {f.tokenAction === "set" && (
            <TextField label="Token" value={f.token} onChange={(e) => set({ token: e.target.value })} error={errors.token} hint="At least 16 characters; the machine sends it as ?token=" />
          )}
        </fieldset>
        <label className="flex min-h-12 items-center gap-3 text-body-md">
          <input type="checkbox" className="size-5" checked={f.active} onChange={(e) => set({ active: e.target.checked })} />
          Accept punches from this machine
        </label>
        <label className="flex min-h-12 items-center gap-3 text-body-md">
          <input type="checkbox" className="size-5" checked={commands} onChange={(e) => setCommands(e.target.checked)} />
          Allow commands from the app (add/remove people, start enrolment)
        </label>
        <Button busy={busy} onClick={save}>
          {editing ? "Save" : "Register"}
        </Button>
      </div>
    </Sheet>
  );
}

// ================================================================ Staff PINs

export function StaffPins() {
  const status = useRpc<EmployeeDeviceStatus[]>("list_employee_device_status");
  const people = useRpc<EmployeeRef[]>("list_device_link_candidates");
  const devices = useRpc<AttendanceDevice[]>("list_attendance_devices");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [enrol, setEnrol] = useState<EmployeeRef | null>(null);
  useLive(["device.command"], () => void status.mutate(), 400);

  const err = status.error ?? people.error ?? devices.error;
  if (err) return <ErrorState message={err.message} onRetry={() => void status.mutate()} />;
  if (!status.data || !people.data || !devices.data) return <LoadingState />;
  const byId = new Map(status.data.map((s) => [s.employee_id, s]));

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      setNotice({ ok: true, text: ok });
      await status.mutate();
    } catch (e) {
      setNotice({ ok: false, text: msg(e, "Could not do that.") });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="flex flex-col gap-3" aria-label="Staff PINs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-title-md font-semibold">Staff PINs</h2>
          <p className="text-body-sm text-text-secondary">Give each person a machine user number and send them to the machines.</p>
        </div>
        <Button
          variant="outlined"
          busy={busy === "all"}
          onClick={() => act("all", () => rpc("sync_all_employee_devices"), "Everyone is being sent to the machines that accept commands.")}
        >
          Send everyone
        </Button>
      </div>
      {notice && <Banner tone={notice.ok ? "success" : "error"}>{notice.text}</Banner>}
      {people.data.length === 0 && <EmptyState art="groups" title="No active employees" />}
      {people.data.map((p) => {
        const s = byId.get(p.id);
        const pins = [...new Set(s?.machines.map((m) => m.pin) ?? [])];
        return (
          <SectionCard key={p.id}>
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-title-sm font-semibold">{p.name}</p>
                <p className="text-body-sm text-text-secondary">
                  {p.code}
                  {pins.length ? ` · PIN ${pins.join(", ")}` : " · no PIN yet"}
                  {s?.machines.length ? ` · on ${s.machines.map((m) => m.label).join(", ")}` : ""}
                </p>
                {s?.last_command && (
                  <p className="text-body-sm text-text-secondary">
                    Last: {COMMAND_KIND[s.last_command.kind] ?? s.last_command.kind} on {s.last_command.device_label} ·{" "}
                    {COMMAND_STATUS[s.last_command.status]?.label ?? s.last_command.status} · {relative(s.last_command.at)}
                  </p>
                )}
              </div>
              {s && s.pending_commands > 0 && <StatusChip label={`${s.pending_commands} waiting`} tone="info" />}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {!pins.length && (
                <Button variant="outlined" busy={busy === `pin-${p.id}`} onClick={() => act(`pin-${p.id}`, () => rpc("assign_device_pin", { p_employee_id: p.id }), `${p.name} has a PIN and is being sent to the machines.`)}>
                  Give a PIN
                </Button>
              )}
              {pins.length > 0 && (
                <Button variant="text" busy={busy === `sync-${p.id}`} onClick={() => act(`sync-${p.id}`, () => rpc("sync_employee_devices", { p_employee_id: p.id }), `${p.name} is being sent to the machines again.`)}>
                  Send again
                </Button>
              )}
              {pins.length > 0 && devices.data!.some((d) => d.commands_enabled && d.active) && (
                <Button variant="text" onClick={() => setEnrol(p)}>
                  Enrol fingerprint / face
                </Button>
              )}
            </div>
          </SectionCard>
        );
      })}
      {enrol && (
        <EnrolForm
          person={enrol}
          devices={devices.data.filter((d) => d.commands_enabled && d.active)}
          onClose={() => setEnrol(null)}
          onDone={(t) => {
            setEnrol(null);
            setNotice({ ok: true, text: t });
            void status.mutate();
          }}
        />
      )}
    </section>
  );
}

export const FINGERS = ["Left little", "Left ring", "Left middle", "Left index", "Left thumb", "Right thumb", "Right index", "Right middle", "Right ring", "Right little"];

export function EnrolForm({
  person,
  devices,
  onClose,
  onDone,
}: {
  person: EmployeeRef;
  devices: AttendanceDevice[];
  onClose: () => void;
  onDone: (m: string) => void;
}) {
  const [serial, setSerial] = useState(devices[0]?.serial ?? "");
  const [what, setWhat] = useState<"finger" | "face">("finger");
  const [finger, setFinger] = useState(6);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [commandId, setCommandId] = useState<number | null>(null);
  // Follow this person's commands every 2 s while an enrolment is open, so the
  // screen says the moment the machine opens the scan screen or finishes.
  const cmds = useRpc<DeviceCommand[]>("list_device_commands", { p_employee_id: person.id, p_limit: 10 }, { refreshInterval: (rows) => (openEnrolment(rows, person.id) ? 2000 : 0) });
  const open = openEnrolment(cmds.data, person.id);
  // Pin an enrolment that was already running when the sheet opened, so its
  // result still shows after it leaves the queued/sent states.
  if (commandId == null && open) setCommandId(open.id);
  const tracked = commandId != null ? (cmds.data?.find((c) => c.id === commandId) ?? open) : open;
  // Just started but not in the list yet: it is waiting for the machine.
  const step: EnrolStep | null = tracked ? enrolStep(tracked) : commandId != null ? "waiting" : null;
  const label = devices.find((d) => d.serial === serial)?.label ?? serial;
  const thing = (k: string | undefined) => (k === "enroll_face" ? "face" : "fingerprint");
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r =
        what === "finger"
          ? await rpc<{ command_id: number }>("enroll_device_fingerprint", { p_employee_id: person.id, p_serial: serial, p_finger: finger })
          : await rpc<{ command_id: number }>("enroll_device_face", { p_employee_id: person.id, p_serial: serial });
      setCommandId(r?.command_id ?? -1);
      await cmds.mutate();
    } catch (e) {
      setError(msg(e, "Could not start enrolment."));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!tracked) return;
    try {
      await rpc("cancel_device_command", { p_command_id: tracked.id });
    } catch (e) {
      setError(msg(e, "Could not cancel."));
    }
    await cmds.mutate();
  };
  return (
    <Sheet title={`Enrol · ${person.name}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {step ? (
          <EnrolProgress
            step={step}
            name={person.name}
            thing={tracked ? thing(tracked.kind) : what === "face" ? "face" : "fingerprint"}
            machine={tracked?.device_label ?? label}
            failure={step === "failed" ? enrolFailure(tracked?.return_code) : null}
            onCancel={step === "waiting" || step === "on_machine" ? cancel : undefined}
            onAgain={() => {
              setCommandId(null);
              void cmds.mutate();
            }}
            onFinish={() => onDone(`${person.name}'s ${thing(tracked?.kind)} is saved on ${tracked?.device_label ?? label}.`)}
          />
        ) : (
          <>
            <p className="text-body-md text-text-secondary">The fingerprint or face stays on the machine. HRMS never receives or stores it.</p>
            {error && <Banner>{error}</Banner>}
            <label className="flex flex-col gap-1 text-body-sm font-medium">
              Machine
              <select value={serial} onChange={(e) => setSerial(e.target.value)} className="min-h-12 rounded-input border border-border bg-surface px-3 text-body-md font-normal">
                {devices.map((d) => (
                  <option key={d.serial} value={d.serial}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            <div role="radiogroup" aria-label="What to enrol" className="flex gap-2">
              <Toggle on={what === "finger"} onChange={() => setWhat("finger")} label="Fingerprint" />
              <Toggle on={what === "face"} onChange={() => setWhat("face")} label="Face" />
            </div>
            {what === "finger" && (
              <label className="flex flex-col gap-1 text-body-sm font-medium">
                Finger
                <select value={finger} onChange={(e) => setFinger(Number(e.target.value))} className="min-h-12 rounded-input border border-border bg-surface px-3 text-body-md font-normal">
                  {FINGERS.map((f, i) => (
                    <option key={f} value={i}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p className="text-body-sm text-text-secondary">Start this when {person.name} is standing at the machine. The scan screen waits about a minute.</p>
            <Button busy={busy} disabled={!serial || (!cmds.data && !cmds.error)} onClick={start}>
              Start on the machine
            </Button>
            <Link href="/devices?tab=machines" className="text-center text-body-md font-semibold text-primary">
              Machine not listed? Turn on commands for it
            </Link>
          </>
        )}
      </div>
    </Sheet>
  );
}

const ENROL_STEPS: { id: EnrolStep; label: string }[] = [
  { id: "waiting", label: "Sent to the machine" },
  { id: "on_machine", label: "Scan screen open" },
  { id: "done", label: "Saved on the machine" },
];

function EnrolProgress({
  step,
  name,
  thing,
  machine,
  failure,
  onCancel,
  onAgain,
  onFinish,
}: {
  step: EnrolStep;
  name: string;
  thing: string;
  machine: string;
  failure: string | null;
  onCancel?: () => void;
  onAgain: () => void;
  onFinish: () => void;
}) {
  const at = step === "waiting" ? 0 : step === "on_machine" ? 1 : 2;
  const ended = step === "failed" || step === "expired";
  return (
    <div className="flex flex-col gap-4" aria-live="polite">
      <ol className="flex flex-col gap-3">
        {ENROL_STEPS.map((s, i) => {
          const doneStep = !ended && (i < at || step === "done");
          const current = !ended && i === at && step !== "done";
          return (
            <li key={s.id} className="flex items-center gap-3">
              <span
                className={cx(
                  "grid size-7 shrink-0 place-items-center rounded-full text-[13px] font-bold",
                  doneStep ? "bg-success text-white" : current ? "bg-primary text-white" : "bg-[#eff1f4] text-text-secondary",
                )}
              >
                {doneStep ? "✓" : i + 1}
              </span>
              <span className={cx("text-body-md", current ? "font-semibold" : doneStep ? "" : "text-text-secondary")}>{s.label}</span>
              {current && <span className="ml-auto size-4 animate-spin rounded-full border-2 border-primary border-t-transparent motion-reduce:animate-none" aria-hidden />}
            </li>
          );
        })}
      </ol>
      {step === "waiting" && <p className="text-body-md">Waiting for {machine} to pick it up. It checks for new work every few seconds.</p>}
      {step === "on_machine" && (
        <Banner tone="info">
          {machine} is showing the scan screen now. Ask {name} to scan their {thing}.
        </Banner>
      )}
      {step === "done" && <Banner tone="success">{`${name}'s ${thing} is saved on ${machine}.`}</Banner>}
      {step === "failed" && failure && <Banner>{failure}</Banner>}
      {step === "expired" && <Banner tone="warning">This enrolment was cancelled or expired before it ran.</Banner>}
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel && (
          <Button variant="text" onClick={onCancel}>
            Cancel enrolment
          </Button>
        )}
        {ended && <Button onClick={onAgain}>Try again</Button>}
        {step === "done" && <Button onClick={onFinish}>Done</Button>}
      </div>
    </div>
  );
}

// ======================================================= New from machine

type Hired = { name: string; pin: string; code: string; password: string | null; error?: string };

export function MachinePeople({ onAdded, now = new Date() }: { onAdded?: () => void; now?: Date }) {
  const { context } = useSession();
  const people = useRpc<MachinePerson[]>("list_machine_people");
  const structure = useRpc<OrgStructure>("list_org_structure", {});
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [d, setD] = useState<HireDefaults>({ team_id: "", office_id: "", shift_id: "", join_date: todayIn(context?.org.timezone ?? "Asia/Kolkata", now) });
  const [errors, setErrors] = useState<Partial<Record<keyof HireDefaults, string>>>({});
  const [busy, setBusy] = useState<"fetch" | "add" | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [hired, setHired] = useState<Hired[]>([]);
  const s = structure.data;
  const one = (items?: { id: string; active: boolean }[]) => {
    const a = (items ?? []).filter((x) => x.active);
    return a.length === 1 ? a[0].id : "";
  };
  const defaults: HireDefaults = s ? { ...d, team_id: d.team_id || one(s.teams), office_id: d.office_id || one(s.offices), shift_id: d.shift_id || one(s.shifts) } : d;

  const fetchUsers = async () => {
    setBusy("fetch");
    setNotice(null);
    try {
      const r = await rpc<{ machines: number; queued: number }>("fetch_device_users", {});
      setNotice({
        ok: true,
        text: r.machines === 0 ? "No active machines to ask." : `Asked ${r.machines} machine${r.machines === 1 ? "" : "s"} for their user list. New people appear here within a minute or two.`,
      });
      setTimeout(() => void people.mutate(), 15000);
    } catch (e) {
      setNotice({ ok: false, text: msg(e, "Could not ask the machines.") });
    } finally {
      setBusy(null);
    }
  };

  const add = async (list: MachinePerson[]) => {
    const errs = hireDefaultsErrors(defaults);
    setErrors(errs);
    if (Object.keys(errs).length || list.length === 0) return;
    setBusy("add");
    setNotice(null);
    const out: Hired[] = [];
    for (const p of list) {
      try {
        const r = await post<{ data: { employee_code?: string; temporary_password: string | null } }>("/admin/users", machineHireBody(p, defaults, newOperationId()));
        out.push({ name: machineHireName(p), pin: p.pin, code: r.data.employee_code ?? "", password: r.data.temporary_password });
      } catch (e) {
        out.push({ name: machineHireName(p), pin: p.pin, code: "", password: null, error: msg(e, "Could not add.") });
        if (e instanceof ApiError && e.code === "ACTIVE_EMPLOYEE_CAP_REACHED") break;
      }
    }
    setHired((h) => [...out, ...h]);
    setPicked(new Set());
    const ok = out.filter((x) => !x.error).length;
    setNotice({ ok: ok === out.length, text: `${ok} of ${list.length} added.${ok < out.length ? " See the list below for the ones that failed." : ""}` });
    setBusy(null);
    await people.mutate();
    onAdded?.();
  };

  if (people.error || structure.error) return <ErrorState message={msg(people.error ?? structure.error, "Could not load the machine list.")} onRetry={() => void people.mutate()} />;
  if (!people.data || !s) return <LoadingState />;
  const list = people.data;
  const toggle = (k: string) => setPicked((x) => { const n = new Set(x); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const chosen = list.filter((p) => picked.has(machinePersonKey(p)));

  return (
    <section aria-label="New from machine" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-title-md font-semibold">New from machine</h2>
          <p className="text-body-sm text-text-secondary">People registered on a machine who are not in the app yet. Adding them creates their account with an automatic Employee ID and keeps their machine PIN.</p>
        </div>
        <Button variant="outlined" busy={busy === "fetch"} onClick={fetchUsers}>
          Fetch from machines
        </Button>
      </div>
      {notice && <Banner tone={notice.ok ? "success" : "error"}>{notice.text}</Banner>}
      {list.length === 0 ? (
        <EmptyState art="check_circle" title="Everyone is in the app" body="Tap “Fetch from machines” to check for people added on a machine." />
      ) : (
        <SectionCard>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Select label="Team" value={defaults.team_id} onChange={(v) => setD({ ...defaults, team_id: v })} options={activeOpts(s.teams)} placeholder="Choose a team" error={errors.team_id} />
            <Select label="Office" value={defaults.office_id} onChange={(v) => setD({ ...defaults, office_id: v })} options={activeOpts(s.offices)} placeholder="Choose an office" error={errors.office_id} />
            <Select label="Shift" value={defaults.shift_id} onChange={(v) => setD({ ...defaults, shift_id: v })} options={activeOpts(s.shifts)} placeholder="Choose a shift" error={errors.shift_id} />
            <TextField label="Join date" type="date" value={defaults.join_date} onChange={(e) => setD({ ...defaults, join_date: e.target.value })} error={errors.join_date} />
          </div>
          <ul className="mt-3 divide-y divide-border" aria-label="People on machines">
            {list.map((p) => {
              const k = machinePersonKey(p);
              return (
                <li key={k}>
                  <label className="flex min-h-12 items-center gap-3 py-2">
                    <input type="checkbox" className="size-5" checked={picked.has(k)} onChange={() => toggle(k)} aria-label={`Select ${machineHireName(p)}`} />
                    <span className="w-14 font-semibold tabular-nums">{p.pin}</span>
                    <span className="min-w-0 flex-1">
                      {machineHireName(p)}
                      {p.is_device_admin && <span className="text-text-secondary"> · machine admin</span>}
                      <span className="block text-body-sm text-text-secondary">
                        {p.device_label ?? p.serial} · {p.punches} punch{p.punches === 1 ? "" : "es"}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button busy={busy === "add"} disabled={busy !== null || chosen.length === 0} onClick={() => add(chosen)}>
              Add selected ({chosen.length})
            </Button>
            <Button variant="outlined" disabled={busy !== null} onClick={() => add(list)}>
              Add all ({list.length})
            </Button>
          </div>
        </SectionCard>
      )}
      {hired.length > 0 && (
        <SectionCard>
          <h3 className="text-title-sm font-semibold">Added</h3>
          <p className="text-body-sm text-text-secondary">Share each person&apos;s sign-in details privately before leaving this page.</p>
          <ul className="mt-2 divide-y divide-border" aria-label="Added people">
            {hired.map((h, i) => (
              <li key={`${h.pin}-${i}`} className="flex flex-col gap-2 py-2">
                <div className="flex flex-wrap items-center gap-x-3">
                  <span className="min-w-0 flex-1">{h.name} <span className="text-text-secondary">· PIN {h.pin}</span></span>
                  {h.error ? <span className="text-body-sm text-error">{h.error}</span> : <span className="font-mono">{h.code} · {h.password ?? "already existed"}</span>}
                </div>
                {h.code && <SignInShare code={h.code} name={h.name} password={h.password ?? undefined} />}
              </li>
            ))}
          </ul>
          <Button
            variant="outlined"
            className="mt-2"
            onClick={() => {
              const rows = hired.filter((h) => !h.error).map((h) => [
                h.name, h.pin, h.code, h.password, h.code ? employeeSignInUrl(window.location.origin, h.code) : "",
              ]);
              const csv = toCsv([["Name", "Machine PIN", "Employee ID", "Temporary password", "Sign-in link"], ...rows]);
              const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
              const a = document.createElement("a");
              a.href = url;
              a.download = "new-employees.csv";
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            Download list
          </Button>
        </SectionCard>
      )}
    </section>
  );
}
