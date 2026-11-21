"use client";

// organization_screen.dart, offices_screen.dart, shifts_screen.dart,
// teams_screen.dart and roles_screen.dart.

import { useMemo, useState } from "react";
import { rpc } from "@/lib/api";
import {
  type OfficeForm,
  type OrgForm,
  type OrgSettings,
  type ShiftForm,
  MONTHS,
  SATURDAY_INDEX,
  WEEKDAYS,
  bytesLabel,
  hm,
  hoursLabel,
  lines,
  maskDays,
  officeArgs,
  officeErrors,
  orgErrors,
  orgForm,
  orgPatch,
  sameSet,
  shiftArgs,
  shiftDaysLabel,
  shiftErrors,
  spanMinutes,
  storagePercent,
} from "@/lib/admin";
import { dayLabel, todayIn } from "@/lib/attendance";
import type { EmployeeRow, OrgStructure } from "@/lib/people";
import { caps, roleLabel } from "@/lib/roles";
import { useSession } from "@/lib/session";
import { useRpc } from "@/lib/use-rpc";
import { type Saved, Select, SheetForm, Toggle, activeOpts, useAction } from "../forms";
import { withReauth } from "../reauth";
import { Banner, Button, EmptyState, ErrorState, KeyValue, LoadingState, PageTitle, PillTabs, SectionCard, StatusChip, TextArea, TextField, cx } from "../ui";
import { EmployeePicker } from "./payroll";

const msg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

function Page({ title, back = "/explore", children, action }: { title: string; back?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <>
      <PageTitle title={title} back={back} action={action} />
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-page">{children}</div>
    </>
  );
}

function Loadable<T>({ q, title, children }: { q: { data?: T; error?: unknown; mutate: () => unknown }; title: string; children: (d: T) => React.ReactNode }) {
  if (q.error) return <Page title={title}><ErrorState message={msg(q.error, "Could not load this page.")} onRetry={() => q.mutate()} /></Page>;
  if (q.data === undefined) return <Page title={title}><LoadingState /></Page>;
  return <>{children(q.data)}</>;
}

/* ───────────────────────── Organization ───────────────────────── */

interface AttendanceSettings {
  auto_checkout_enabled: boolean;
  duplicate_window_minutes: number;
  timezone: string;
  updated_at: string | null;
}

export function Organization() {
  const q = useRpc<OrgSettings>("get_org_settings", {});
  return (
    <Loadable q={q} title="Organisation">
      {(o) => <OrganizationForm key={o.version} org={o} reload={() => q.mutate()} />}
    </Loadable>
  );
}

function OrganizationForm({ org, reload }: { org: OrgSettings; reload: () => unknown }) {
  const [f, setF] = useState<OrgForm>(orgForm(org));
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const a = useAction();
  const cycle = useRpc<{ current_period_end: string; next_periods: { label: string; kind: string }[] }>(Number(f.annual_start_month) !== org.annual_start_month ? "preview_annual_cycle" : null, { p_start_month: Number(f.annual_start_month) });
  const att = useRpc<AttendanceSettings>("get_attendance_settings", {});
  const pct = storagePercent(org.storage_used_bytes, org.storage_reserved_bytes, org.storage_budget_bytes);
  const set = (k: keyof OrgForm) => (v: string | boolean) => setF({ ...f, [k]: v });
  const save = () => {
    const e = orgErrors(f, org.active_employees);
    setErrors(e);
    setNotice(null);
    if (Object.keys(e).length) return;
    const patch = orgPatch(org, f);
    if (!Object.keys(patch).length) return a.setError("Nothing changed.");
    if (reason.trim()) patch.reason = reason.trim();
    a.run(async () => {
      await rpc("update_org_settings", { p_patch: patch, p_expected_version: org.version });
      setNotice("Saved.");
      setReason("");
      await reload();
    }, "Could not save.");
  };
  const months = MONTHS.map((m, i) => ({ value: String(i + 1), label: m }));
  return (
    <Page title="Organisation">
      {notice && <Banner tone="success">{notice}</Banner>}
      <SectionCard>
        <h2 className="mb-2 text-title-sm font-semibold">Storage</h2>
        <div className="h-2 overflow-hidden rounded-full bg-background" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Storage used">
          <div className={cx("h-full", pct >= 95 ? "bg-error" : pct >= 85 ? "bg-warning" : "bg-primary")} style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-2 text-body-sm text-text-secondary">
          {bytesLabel(org.storage_used_bytes + org.storage_reserved_bytes)} of {bytesLabel(org.storage_budget_bytes)} used ({pct}%). Old files move to the yearly archive.
        </p>
        <KeyValue k="Active accounts" v={`${org.active_employees} of ${org.active_employee_cap}`} />
        <KeyValue k="Org code" v={org.code} />
      </SectionCard>
      <SectionCard>
        <form
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          {a.error && <Banner>{a.error}</Banner>}
          <TextField label="Organisation name" value={f.name} onChange={(e) => set("name")(e.target.value)} error={errors.name ?? a.fields.name} />
          <TextField label="Time zone" value={f.timezone} onChange={(e) => set("timezone")(e.target.value)} error={a.fields.timezone} hint="Changing it affects every attendance day. Use Asia/Kolkata for India." />
          <TextField label="Support contact" value={f.support_contact} onChange={(e) => set("support_contact")(e.target.value)} error={errors.support_contact} hint="Shown on the sign-in screen for people who are locked out." />
          <TextField label="Active account limit" inputMode="numeric" value={f.active_employee_cap} onChange={(e) => set("active_employee_cap")(e.target.value)} error={errors.active_employee_cap ?? a.fields.active_employee_cap} />
          <TextField label="Holidays per year (target)" inputMode="numeric" value={f.holiday_target} onChange={(e) => set("holiday_target")(e.target.value)} error={errors.holiday_target} />
          <Select label="Leave year starts in" value={f.leave_year_start_month} onChange={set("leave_year_start_month")} options={months} />
          <Select label="Archive year starts in" value={f.annual_start_month} onChange={set("annual_start_month")} options={months} error={a.fields.annual_start_month} />
          {cycle.data && (
            <Banner tone="info">
              The current archive year ends {dayLabel(cycle.data.current_period_end)}. Next: {cycle.data.next_periods.map((p) => p.label).join(", then ")}.
            </Banner>
          )}
          <Toggle label="Require fingerprint or face to punch" checked={f.require_biometric_punch} onChange={set("require_biometric_punch")} hint="Phones confirm the person with the device lock before a punch." />
          <Toggle label="Strict office location" checked={f.strict_geofence} onChange={set("strict_geofence")} hint="Refuse punches when the location is uncertain instead of flagging them." />
          <TextField label="Reason (for the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} error={a.fields.reason} />
          <Button type="submit" busy={a.busy}>
            Save
          </Button>
        </form>
      </SectionCard>
      {att.data && <AttendanceRules s={att.data} reload={() => att.mutate()} />}
    </Page>
  );
}

function AttendanceRules({ s, reload }: { s: AttendanceSettings; reload: () => unknown }) {
  const [auto, setAuto] = useState(s.auto_checkout_enabled);
  const [win, setWin] = useState(String(s.duplicate_window_minutes));
  const [done, setDone] = useState(false);
  const a = useAction();
  return (
    <SectionCard>
      <h2 className="mb-2 text-title-sm font-semibold">Attendance machine rules</h2>
      <div className="flex flex-col gap-3">
        {a.error && <Banner>{a.error}</Banner>}
        {done && <Banner tone="success">Saved.</Banner>}
        <Toggle label="Close open days automatically" checked={auto} onChange={setAuto} hint="A day with only a check-in is closed at the shift end plus any extension." />
        <TextField label="Ignore repeat punches within (minutes)" inputMode="numeric" value={win} onChange={(e) => setWin(e.target.value)} />
        <Button
          variant="outlined"
          busy={a.busy}
          onClick={() => {
            const n = Number(win);
            if (!/^\d{1,3}$/.test(win) || n < 1 || n > 120) return a.setError("Use 1–120 minutes.");
            a.run(async () => {
              await rpc("save_attendance_settings", { p: { auto_checkout_enabled: auto, duplicate_window_minutes: n } });
              setDone(true);
              await reload();
            }, "Could not save.");
          }}
        >
          Save rules
        </Button>
      </div>
    </SectionCard>
  );
}

/* ───────────────────────── Offices ───────────────────────── */

export interface Office {
  id: string;
  name: string;
  timezone: string;
  latitude: number;
  longitude: number;
  radius_m: number;
  max_accuracy_m: number;
  max_sample_age_s: number;
  strict_mode: boolean;
  active: boolean;
  calibration_status: "untested" | "piloting" | "verified";
  calibration_notes: string | null;
  config_version: number;
  version: number;
  wifi_ssids?: string[];
  network_cidrs?: string[];
  assigned_count: number;
}

const CALIBRATION = { untested: { label: "Not tested", tone: "warning" }, piloting: { label: "Piloting", tone: "info" }, verified: { label: "Verified", tone: "success" } } as const;

export function Offices() {
  const { context } = useSession();
  const c = caps(context);
  const q = useRpc<Office[]>("list_offices", {});
  const [edit, setEdit] = useState<Office | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <Loadable q={q} title="Offices">
      {(rows) => (
        <Page
          title="Offices"
          action={
            <Button variant="text" onClick={() => setEdit("new")}>
              Add
            </Button>
          }
        >
          {notice && <Banner tone="success">{notice}</Banner>}
          {rows.length === 0 ? (
            <EmptyState art="office" title="No offices yet" body="Add the office location so phone punches can be checked." />
          ) : (
            rows.map((o) => {
              const cal = CALIBRATION[o.calibration_status] ?? CALIBRATION.untested;
              return (
                <SectionCard key={o.id}>
                  <div className="mb-2 flex items-center gap-2">
                    <h2 className="flex-1 text-title-sm font-semibold">{o.name}</h2>
                    <StatusChip label={o.active ? "Active" : "Inactive"} tone={o.active ? "success" : "neutral"} />
                    <StatusChip label={cal.label} tone={cal.tone} />
                  </div>
                  <KeyValue k="Location" v={`${o.latitude.toFixed(6)}, ${o.longitude.toFixed(6)}`} />
                  <KeyValue k="Geofence" v={`${o.radius_m} m · accuracy ≤ ${o.max_accuracy_m} m · ≤ ${o.max_sample_age_s} s old${o.strict_mode ? " · strict" : ""}`} />
                  <KeyValue k="Office Wi-Fi" v={o.wifi_ssids?.length ? o.wifi_ssids.join(" · ") : "Not set"} />
                  <KeyValue k="Office networks" v={o.network_cidrs?.length ? o.network_cidrs.join(" · ") : "Not set"} />
                  <KeyValue k="Assigned" v={`${o.assigned_count} people · config v${o.config_version}`} />
                  <Button variant="text" onClick={() => setEdit(o)}>
                    Edit
                  </Button>
                </SectionCard>
              );
            })
          )}
          {edit && (
            <OfficeSheet
              office={edit === "new" ? null : edit}
              isAdmin={c.isAdmin}
              onClose={() => setEdit(null)}
              onSaved={async () => {
                setEdit(null);
                setNotice("Office saved. Phones pick up the change at their next punch.");
                await q.mutate();
              }}
            />
          )}
        </Page>
      )}
    </Loadable>
  );
}

function OfficeSheet({ office, isAdmin, onClose, onSaved }: { office: Office | null; isAdmin: boolean } & Saved) {
  const o = office;
  const [f, setF] = useState<OfficeForm>({
    name: o?.name ?? "",
    timezone: o?.timezone ?? "Asia/Kolkata",
    latitude: o ? o.latitude.toFixed(7) : "",
    longitude: o ? o.longitude.toFixed(7) : "",
    radius_m: String(o?.radius_m ?? 20),
    max_accuracy_m: String(o?.max_accuracy_m ?? 15),
    max_sample_age_s: String(o?.max_sample_age_s ?? 10),
    strict_mode: o?.strict_mode ?? false,
    active: o?.active ?? true,
    calibration_status: o?.calibration_status ?? "untested",
    calibration_notes: o?.calibration_notes ?? "",
    wifi: (o?.wifi_ssids ?? []).join("\n"),
    networks: (o?.network_cidrs ?? []).join("\n"),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [locating, setLocating] = useState(false);
  const a = useAction();
  const set = (k: keyof OfficeForm) => (v: string | boolean) => setF({ ...f, [k]: v });
  const here = () => {
    if (!navigator.geolocation) return a.setError("This browser cannot read the location.");
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLocating(false);
        setF({ ...f, latitude: p.coords.latitude.toFixed(7), longitude: p.coords.longitude.toFixed(7) });
      },
      () => {
        setLocating(false);
        a.setError("Could not read the location. Allow location access and try again.");
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };
  const save = () => {
    const e = officeErrors(f);
    setErrors(e);
    if (Object.keys(e).length) return;
    a.run(async () => {
      const saved = await rpc<{ id: string }>("save_office", officeArgs(o?.id ?? null, f, o?.version ?? null));
      const id = saved?.id ?? o?.id;
      if (id && isAdmin && !sameSet(lines(f.wifi), o?.wifi_ssids ?? [])) await rpc("set_office_wifi", { p_office_id: id, p_ssids: lines(f.wifi) });
      if (id && !sameSet(lines(f.networks), o?.network_cidrs ?? [])) await rpc("set_office_networks", { p_office_id: id, p_cidrs: lines(f.networks) });
      await onSaved();
    }, "Could not save the office.");
  };
  const err = (k: string) => errors[k] ?? a.fields[k];
  return (
    <SheetForm title={o ? `Edit ${o.name}` : "Add office"} submit="Save" busy={a.busy} error={a.error} onClose={onClose} onSubmit={save}>
      <TextField label="Office name" value={f.name} onChange={(e) => set("name")(e.target.value)} error={err("name")} />
      <TextField label="Time zone" value={f.timezone} onChange={(e) => set("timezone")(e.target.value)} error={err("timezone")} />
      <div className="grid grid-cols-2 gap-3">
        <TextField label="Latitude" inputMode="decimal" value={f.latitude} onChange={(e) => set("latitude")(e.target.value)} error={err("latitude")} />
        <TextField label="Longitude" inputMode="decimal" value={f.longitude} onChange={(e) => set("longitude")(e.target.value)} error={err("longitude")} />
      </div>
      <Button type="button" variant="outlined" busy={locating} onClick={here}>
        Use my current location
      </Button>
      <div className="grid grid-cols-3 gap-3">
        <TextField label="Radius (m)" inputMode="numeric" value={f.radius_m} onChange={(e) => set("radius_m")(e.target.value)} error={err("radius_m")} />
        <TextField label="Accuracy (m)" inputMode="numeric" value={f.max_accuracy_m} onChange={(e) => set("max_accuracy_m")(e.target.value)} error={err("max_accuracy_m")} />
        <TextField label="Max age (s)" inputMode="numeric" value={f.max_sample_age_s} onChange={(e) => set("max_sample_age_s")(e.target.value)} error={err("max_sample_age_s")} />
      </div>
      <Toggle label="Strict mode" checked={f.strict_mode} onChange={set("strict_mode")} hint="Refuse uncertain locations instead of flagging them for review." />
      <Select
        label="Site test"
        value={f.calibration_status}
        onChange={(v) => set("calibration_status")(v)}
        options={[
          { value: "untested", label: "Not tested" },
          { value: "piloting", label: "Piloting" },
          { value: "verified", label: "Verified on site" },
        ]}
      />
      <TextArea label="Site test notes" value={f.calibration_notes} onChange={(v) => set("calibration_notes")(v)} maxLength={500} />
      {isAdmin && <TextArea label="Office Wi-Fi names (one per line)" value={f.wifi} onChange={(v) => set("wifi")(v)} error={err("wifi") ?? err("wifi_ssids")} hint="Phones on these networks show as at the office." />}
      <TextArea label="Office networks (IP ranges, one per line)" value={f.networks} onChange={(v) => set("networks")(v)} error={err("networks") ?? err("network_cidrs")} hint="Web punches from these public IP ranges count as in the office, like 203.0.113.0/24." />
      {o && <Toggle label="Active" checked={f.active} onChange={set("active")} />}
    </SheetForm>
  );
}

/* ───────────────────────── Shifts ───────────────────────── */

interface ShiftVersion {
  id: string;
  version_no: number;
  state: "draft" | "published" | string;
  effective_from: string;
  start_local: string;
  end_local: string;
  weekly_mask: number;
  grace_seconds: number;
  lunch_start_local: string | null;
  lunch_end_local: string | null;
  early_entry_seconds: number;
  early_credit: boolean;
  checkout_extension_enabled: boolean;
  checkout_extension_seconds: number;
  crosses_midnight: boolean;
  expected_seconds: number;
  published_at: string | null;
}
export interface Shift {
  id: string;
  name: string;
  active: boolean;
  assigned_count: number;
  versions: ShiftVersion[];
}

export function currentVersion(s: Shift, today: string): ShiftVersion | undefined {
  return s.versions.filter((v) => v.state === "published" && v.effective_from <= today).sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0] ?? s.versions.find((v) => v.state === "published");
}

export function Shifts({ now = new Date() }: { now?: Date }) {
  const { context } = useSession();
  const today = todayIn(context?.org.timezone ?? "Asia/Kolkata", now);
  const q = useRpc<Shift[]>("list_shifts", {});
  const [edit, setEdit] = useState<{ shift: Shift | null; from?: ShiftVersion } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pub = useAction();
  return (
    <Loadable q={q} title="Shifts">
      {(rows) => (
        <Page
          title="Shifts"
          action={
            <Button variant="text" onClick={() => setEdit({ shift: null })}>
              Add
            </Button>
          }
        >
          {notice && <Banner tone="success">{notice}</Banner>}
          {pub.error && <Banner>{pub.error}</Banner>}
          {rows.length === 0 && <EmptyState art="shift" title="No shifts yet" />}
          {rows.map((s) => {
            const cur = currentVersion(s, today);
            const drafts = s.versions.filter((v) => v.state === "draft");
            const upcoming = s.versions.filter((v) => v.state === "published" && v.effective_from > today);
            return (
              <SectionCard key={s.id}>
                <div className="mb-2 flex items-center gap-2">
                  <h2 className="flex-1 text-title-sm font-semibold">{s.name}</h2>
                  <StatusChip label={`${s.assigned_count} people`} tone="neutral" />
                </div>
                {cur ? (
                  <>
                    <KeyValue k="Hours" v={`${hm(cur.start_local)}–${hm(cur.end_local)} (${hoursLabel(spanMinutes(hm(cur.start_local), hm(cur.end_local)))})${cur.crosses_midnight ? " · overnight" : ""}`} />
                    <KeyValue k="Days" v={shiftDaysLabel(cur.weekly_mask)} />
                    <KeyValue k="Late after" v={`${cur.grace_seconds / 60} min grace`} />
                    {cur.lunch_start_local && <KeyValue k="Lunch" v={`${hm(cur.lunch_start_local)}–${hm(cur.lunch_end_local)}`} />}
                    {cur.checkout_extension_enabled && <KeyValue k="Checkout extension" v={hoursLabel(cur.checkout_extension_seconds / 60)} />}
                    <KeyValue k="Since" v={dayLabel(cur.effective_from)} />
                  </>
                ) : (
                  <p className="text-body-md text-text-secondary">Not published yet.</p>
                )}
                {[...upcoming, ...drafts].map((v) => (
                  <div key={v.id} className="mt-2 flex items-center justify-between rounded-input bg-background px-3 py-2">
                    <span className="text-body-md">
                      v{v.version_no} · {hm(v.start_local)}–{hm(v.end_local)} · {shiftDaysLabel(v.weekly_mask)} · from {dayLabel(v.effective_from)}
                    </span>
                    {v.state === "draft" ? (
                      <Button
                        variant="text"
                        busy={pub.busy}
                        onClick={() =>
                          pub.run(async () => {
                            await rpc("publish_shift_version", { p_version_id: v.id });
                            setNotice(`${s.name} v${v.version_no} published. Attendance from ${dayLabel(v.effective_from)} uses it.`);
                            await q.mutate();
                          }, "Could not publish.")
                        }
                      >
                        Publish
                      </Button>
                    ) : (
                      <StatusChip label="Scheduled" tone="info" />
                    )}
                  </div>
                ))}
                <Button variant="text" onClick={() => setEdit({ shift: s, from: drafts[0] ?? cur })}>
                  {drafts.length ? "Edit draft" : "Change from a date"}
                </Button>
              </SectionCard>
            );
          })}
          {edit && (
            <ShiftSheet
              shift={edit.shift}
              from={edit.from}
              today={today}
              onClose={() => setEdit(null)}
              onSaved={async () => {
                setEdit(null);
                setNotice("Draft saved. Publish it to start using it.");
                await q.mutate();
              }}
            />
          )}
        </Page>
      )}
    </Loadable>
  );
}

function ShiftSheet({ shift, from, today, onClose, onSaved }: { shift: Shift | null; from?: ShiftVersion; today: string } & Saved) {
  const v = from;
  const [f, setF] = useState<ShiftForm>({
    name: shift?.name ?? "",
    effective_from: v?.state === "draft" ? v.effective_from : today,
    start: hm(v?.start_local) || "09:30",
    end: hm(v?.end_local) || "18:30",
    days: maskDays((v?.weekly_mask ?? 31) | (1 << SATURDAY_INDEX)),
    grace_min: String((v?.grace_seconds ?? 900) / 60),
    lunch_start: hm(v?.lunch_start_local),
    lunch_end: hm(v?.lunch_end_local),
    early_entry_min: String((v?.early_entry_seconds ?? 1800) / 60),
    early_credit: v?.early_credit ?? false,
    extension: v?.checkout_extension_enabled ?? true,
    extension_min: String((v?.checkout_extension_seconds ?? 7200) / 60),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const a = useAction();
  const set = (k: keyof ShiftForm) => (x: string | boolean) => setF({ ...f, [k]: x });
  const err = (k: string) => errors[k] ?? a.fields[k];
  return (
    <SheetForm
      title={shift ? `${shift.name}: new version` : "Add shift"}
      submit="Save draft"
      busy={a.busy}
      error={a.error}
      onClose={onClose}
      onSubmit={() => {
        const e = shiftErrors(f, today);
        setErrors(e);
        if (Object.keys(e).length) return;
        a.run(async () => {
          await rpc("save_shift_draft", shiftArgs(shift?.id ?? null, f));
          await onSaved();
        }, "Could not save the shift.");
      }}
    >
      <TextField label="Name" value={f.name} onChange={(e) => set("name")(e.target.value)} error={err("name")} />
      <TextField label="Starts on" type="date" min={today} value={f.effective_from} onChange={(e) => set("effective_from")(e.target.value)} error={err("effective_from")} />
      <div className="grid grid-cols-2 gap-3">
        <TextField label="Start" type="time" value={f.start} onChange={(e) => set("start")(e.target.value)} error={err("start") ?? err("start_local")} />
        <TextField label="End" type="time" value={f.end} onChange={(e) => set("end")(e.target.value)} error={err("end") ?? err("end_local")} />
      </div>
      <fieldset>
        <legend className="mb-1.5 text-body-md font-medium text-text-secondary">Working days</legend>
        <div className="flex flex-wrap gap-2">
          {WEEKDAYS.map((d, i) => i === SATURDAY_INDEX ? null : (
            <label key={d} className={cx("cursor-pointer rounded-[20px] border px-3 py-2 text-body-md font-semibold", f.days[i] ? "border-primary bg-primary text-white" : "border-border bg-surface")}>
              <input
                type="checkbox"
                className="sr-only"
                checked={f.days[i]}
                onChange={(e) => {
                  const days = [...f.days];
                  days[i] = e.target.checked;
                  setF({ ...f, days });
                }}
              />
              {d}
            </label>
          ))}
        </div>
        <p className="mt-1 text-body-sm text-text-secondary">Saturday follows the company’s Saturdays off setting.</p>
        {err("days") && <p className="mt-1 text-body-sm text-error">{err("days")}</p>}
      </fieldset>
      <TextField label="Grace before late (minutes)" inputMode="numeric" value={f.grace_min} onChange={(e) => set("grace_min")(e.target.value)} error={err("grace_min")} />
      <div className="grid grid-cols-2 gap-3">
        <TextField label="Lunch from (optional)" type="time" value={f.lunch_start} onChange={(e) => set("lunch_start")(e.target.value)} />
        <TextField label="Lunch to" type="time" value={f.lunch_end} onChange={(e) => set("lunch_end")(e.target.value)} error={err("lunch_end")} />
      </div>
      <TextField label="Earliest check-in before start (minutes)" inputMode="numeric" value={f.early_entry_min} onChange={(e) => set("early_entry_min")(e.target.value)} error={err("early_entry_min")} />
      <Toggle label="Count early arrival as worked time" checked={f.early_credit} onChange={set("early_credit")} />
      <Toggle label="Allow checking out after the end" checked={f.extension} onChange={set("extension")} />
      {f.extension && <TextField label="Checkout extension (minutes)" inputMode="numeric" value={f.extension_min} onChange={(e) => set("extension_min")(e.target.value)} error={err("extension_min")} />}
    </SheetForm>
  );
}

/* ───────────────────────── Teams & departments ───────────────────────── */

type TeamRow = OrgStructure["teams"][number] & { manager?: { id: string; name: string } | null; member_count?: number; version?: number };
type DeptRow = OrgStructure["departments"][number] & { version?: number };

export function Teams({ initialSection = "teams", now = new Date() }: { initialSection?: "teams" | "departments"; now?: Date }) {
  const { context } = useSession();
  const today = todayIn(context?.org.timezone ?? "Asia/Kolkata", now);
  const q = useRpc<Omit<OrgStructure, "teams" | "departments"> & { teams: TeamRow[]; departments: DeptRow[] }>("list_org_structure", {});
  const [section, setSection] = useState(initialSection);
  const [team, setTeam] = useState<TeamRow | "new" | null>(null);
  const [mgr, setMgr] = useState<TeamRow | null>(null);
  const [dept, setDept] = useState<DeptRow | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const done = (m: string) => async () => {
    setTeam(null);
    setMgr(null);
    setDept(null);
    setNotice(m);
    await q.mutate();
  };
  return (
    <Loadable q={q} title="Teams">
      {(s) => (
        <Page
          title="Teams"
          action={
            <Button variant="text" onClick={() => (section === "teams" ? setTeam("new") : setDept("new"))}>
              Add
            </Button>
          }
        >
          <PillTabs
            label="Section"
            tabs={[
              { id: "teams", label: "Teams" },
              { id: "departments", label: "Departments" },
            ]}
            value={section}
            onChange={setSection}
          />
          {notice && <Banner tone="success">{notice}</Banner>}
          {section === "teams"
            ? s.teams.map((t) => (
                <SectionCard key={t.id}>
                  <div className="mb-1 flex items-center gap-2">
                    <h2 className="flex-1 text-title-sm font-semibold">{t.name}</h2>
                    {!t.active && <StatusChip label="Inactive" tone="neutral" />}
                  </div>
                  <KeyValue k="Department" v={s.departments.find((d) => d.id === t.department_id)?.name ?? "—"} />
                  <KeyValue k="Manager" v={t.manager?.name ?? "—"} />
                  <KeyValue k="Members" v={String(t.member_count ?? 0)} />
                  <div className="flex gap-4">
                    <Button variant="text" onClick={() => setTeam(t)}>
                      Edit
                    </Button>
                    <Button variant="text" onClick={() => setMgr(t)}>
                      {t.manager ? "Change manager" : "Set manager"}
                    </Button>
                  </div>
                </SectionCard>
              ))
            : s.departments.map((d) => (
                <SectionCard key={d.id}>
                  <div className="flex items-center gap-2">
                    <h2 className="flex-1 text-title-sm font-semibold">{d.name}</h2>
                    {!d.active && <StatusChip label="Inactive" tone="neutral" />}
                    <Button variant="text" onClick={() => setDept(d)}>
                      Edit
                    </Button>
                  </div>
                  <p className="text-body-sm text-text-secondary">{s.teams.filter((t) => t.department_id === d.id).length} teams</p>
                </SectionCard>
              ))}
          {team && <TeamSheet team={team === "new" ? null : team} departments={s.departments} onClose={() => setTeam(null)} onSaved={done("Team saved.")} />}
          {mgr && <ManagerSheet team={mgr} today={today} onClose={() => setMgr(null)} onSaved={done("Manager set.")} />}
          {dept && <DeptSheet dept={dept === "new" ? null : dept} onClose={() => setDept(null)} onSaved={done("Department saved.")} />}
        </Page>
      )}
    </Loadable>
  );
}

function TeamSheet({ team, departments, onClose, onSaved }: { team: TeamRow | null; departments: DeptRow[] } & Saved) {
  const [name, setName] = useState(team?.name ?? "");
  const [deptId, setDeptId] = useState(team?.department_id ?? "");
  const [active, setActive] = useState(team?.active ?? true);
  const a = useAction();
  return (
    <SheetForm
      title={team ? `Edit ${team.name}` : "Add team"}
      submit="Save"
      busy={a.busy}
      error={a.error}
      onClose={onClose}
      onSubmit={() => {
        if (name.trim().length < 2) return a.setError("Give the team a name.");
        if (team && !active && (team.member_count ?? 0) > 0) return a.setError(`Move the ${team.member_count} members to another team first.`);
        a.run(async () => {
          await rpc("save_team", { p_id: team?.id ?? null, p_name: name.trim(), p_department_id: deptId || null, p_active: active, p_expected_version: team?.version ?? null });
          await onSaved();
        }, "Could not save the team.");
      }}
    >
      <TextField label="Team name" value={name} onChange={(e) => setName(e.target.value)} error={a.fields.name} />
      <Select label="Department" value={deptId} onChange={setDeptId} options={activeOpts(departments, team?.department_id)} placeholder="None" />
      {team && <Toggle label="Active" checked={active} onChange={setActive} />}
    </SheetForm>
  );
}

function ManagerSheet({ team, today, onClose, onSaved }: { team: TeamRow; today: string } & Saved) {
  const [emp, setEmp] = useState<EmployeeRow | null>(null);
  const [from, setFrom] = useState(today);
  const [reason, setReason] = useState("");
  const a = useAction();
  return (
    <SheetForm
      title={`Manager of ${team.name}`}
      submit="Save"
      busy={a.busy}
      error={a.error}
      onClose={onClose}
      onSubmit={() => {
        if (!emp) return a.setError("Choose the manager.");
        if (reason.trim().length < 3) return a.setError("Give a reason.");
        a.run(async () => {
          await rpc("set_team_manager", { p_team_id: team.id, p_manager_id: emp.id, p_effective_from: from, p_reason: reason.trim() });
          await onSaved();
        }, "Could not set the manager.");
      }}
    >
      <EmployeePicker value={emp} onChange={setEmp} />
      <TextField label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      <TextArea label="Reason" value={reason} onChange={setReason} maxLength={500} />
      <p className="text-body-sm text-text-secondary">The manager label is shown on profiles. Leave approval stays with HR and Admin.</p>
    </SheetForm>
  );
}

function DeptSheet({ dept, onClose, onSaved }: { dept: DeptRow | null } & Saved) {
  const [name, setName] = useState(dept?.name ?? "");
  const [active, setActive] = useState(dept?.active ?? true);
  const a = useAction();
  return (
    <SheetForm
      title={dept ? `Edit ${dept.name}` : "Add department"}
      submit="Save"
      busy={a.busy}
      error={a.error}
      onClose={onClose}
      onSubmit={() => {
        if (name.trim().length < 2) return a.setError("Give the department a name.");
        a.run(async () => {
          await rpc("save_department", { p_id: dept?.id ?? null, p_name: name.trim(), p_active: active, p_expected_version: dept?.version ?? null });
          await onSaved();
        }, "Could not save the department.");
      }}
    >
      <TextField label="Department name" value={name} onChange={(e) => setName(e.target.value)} error={a.fields.name} />
      {dept && <Toggle label="Active" checked={active} onChange={setActive} />}
    </SheetForm>
  );
}

/* ───────────────────────── Roles ───────────────────────── */

export interface AccessGrant {
  employee: { id: string; code: string; name: string; designation: string | null; position_label: string | null; status: string };
  role: string;
  roles: string[];
  permissions: string[];
}

type RoleTab = "all" | "admin" | "hr" | "employee";

const ROLE_HELP = [
  "Employee — own attendance, leave, requests, salary and payslips.",
  "HR — everything an Employee can, plus: add or remove Employees and HR, salaries, payslips, approve leave, work from home, late arrivals and corrections, attendance reports.",
  "Admin — everything HR can, plus: Admins, organisation setup, offices, shifts and archives.",
  "Manager / Member is only a label shown on the profile. It gives no extra access.",
];
const ROLE_TILES = [
  { id: "employee", label: "Employee", sub: "Own attendance, leave and salary" },
  { id: "hr", label: "HR", sub: "People, salaries, payslips and approvals" },
  { id: "admin", label: "Admin", sub: "Everything, including setup" },
] as const;

export function Roles() {
  const { context } = useSession();
  const c = caps(context);
  const q = useRpc<AccessGrant[]>("list_access_grants", {});
  const [tab, setTab] = useState<RoleTab>("all");
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<AccessGrant | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? []).filter((g) => (tab === "all" || g.role === tab) && (!s || g.employee.name.toLowerCase().includes(s) || g.employee.code.toLowerCase().includes(s)));
  }, [q.data, tab, search]);
  const admins = (q.data ?? []).filter((g) => g.role === "admin" && g.employee.status === "active").length;
  return (
    <Loadable q={q} title="Roles and access">
      {() => (
        <Page title="Roles and access">
          {notice && <Banner tone="success">{notice}</Banner>}
          <details className="rounded-card border border-border bg-surface p-card">
            <summary className="cursor-pointer text-title-sm font-semibold">What each role can do</summary>
            <div className="mt-2 flex flex-col gap-2 text-body-md text-text-secondary">
              {ROLE_HELP.map((t) => (
                <p key={t}>{t}</p>
              ))}
            </div>
          </details>
          <PillTabs
            label="Role"
            tabs={[
              { id: "all", label: "All" },
              { id: "admin", label: "Admin" },
              { id: "hr", label: "HR" },
              { id: "employee", label: "Employee" },
            ]}
            value={tab}
            onChange={setTab}
          />
          <TextField label="Search by name or ID" type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
          {rows.length === 0 ? (
            <EmptyState art="groups" title={search.trim() ? "No one matches" : "Nobody here"} />
          ) : (
            <ul className="flex flex-col gap-2">
              {rows.map((g) => (
                <li key={g.employee.id} className="flex items-center gap-3 rounded-card border border-border bg-surface p-card">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{g.employee.name}</p>
                    <p className="truncate text-body-sm text-text-secondary">
                      {[g.employee.code, g.employee.designation, g.employee.position_label === "manager" ? "Manager" : null].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <StatusChip label={roleLabel(g.role)} tone={g.role === "employee" ? "neutral" : "info"} />
                  {c.canManageAccess && g.employee.id !== context?.employee.id && g.employee.status === "active" && (
                    <Button variant="text" onClick={() => setEdit(g)}>
                      Change
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {edit && (
            <RoleSheet
              grant={edit}
              isAdmin={c.isAdmin}
              lastAdmin={edit.role === "admin" && admins <= 1}
              onClose={() => setEdit(null)}
              onSaved={async () => {
                setEdit(null);
                setNotice(`${edit.employee.name}'s access changed. They see it at their next sign-in or refresh.`);
                await q.mutate();
              }}
            />
          )}
        </Page>
      )}
    </Loadable>
  );
}

function RoleSheet({ grant, isAdmin, lastAdmin, onClose, onSaved }: { grant: AccessGrant; isAdmin: boolean; lastAdmin: boolean } & Saved) {
  const [role, setRole] = useState(grant.role === "admin" || grant.role === "hr" ? grant.role : "employee");
  const [label, setLabel] = useState(grant.employee.position_label === "manager" ? "manager" : "member");
  const [reason, setReason] = useState("");
  const a = useAction();
  const canTouch = isAdmin || (grant.role !== "admin" && role !== "admin");
  return (
    <SheetForm
      title={`Access for ${grant.employee.name}`}
      submit="Save"
      busy={a.busy}
      error={a.error}
      onClose={onClose}
      onSubmit={() => {
        if (lastAdmin && role !== "admin") return a.setError("This is the last Admin. Make someone else Admin first.");
        if (!canTouch) return a.setError("Only an Admin can change Admin access.");
        if (role === grant.role && label === (grant.employee.position_label ?? "member")) return a.setError("Nothing changed.");
        if (reason.trim().length < 3) return a.setError("Give a reason.");
        a.run(async () => {
          await withReauth("role.elevate", grant.employee.id, () => rpc("set_employee_access", { p_employee_id: grant.employee.id, p_role: role, p_label: label, p_reason: reason.trim() }));
          await onSaved();
        }, "Could not change access.");
      }}
    >
      {lastAdmin && <Banner tone="warning">This is the only active Admin.</Banner>}
      <p className="text-body-sm text-text-secondary">{grant.role === "admin" && !isAdmin ? "Only an Admin can change an Admin." : "Choose what they can do in the app."}</p>
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Role</legend>
        {ROLE_TILES.map((t) => {
          const locked = t.id === "admin" && !isAdmin;
          return (
            <label
              key={t.id}
              className={cx(
                "flex min-h-14 items-center gap-3 rounded-row border p-3",
                role === t.id ? "border-primary bg-attendance-card" : "border-border bg-surface",
                locked && "opacity-50",
              )}
            >
              <input type="radio" name="role" value={t.id} checked={role === t.id} disabled={locked} onChange={() => setRole(t.id)} className="size-5 accent-primary" />
              <span className="flex-1">
                <span className="block font-semibold">{t.label}</span>
                <span className="block text-body-sm text-text-secondary">{locked ? "Only an Admin can grant this" : t.sub}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
      <Select
        label="Label"
        value={label}
        onChange={setLabel}
        options={[
          { value: "member", label: "Member" },
          { value: "manager", label: "Manager" },
        ]}
      />
      <p className="-mt-2 text-body-sm text-text-secondary">A label only. It gives no extra access.</p>
      <TextArea label="Reason" value={reason} onChange={setReason} maxLength={500} />
    </SheetForm>
  );
}
