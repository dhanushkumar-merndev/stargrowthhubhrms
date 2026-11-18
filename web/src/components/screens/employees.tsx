"use client";

// employees_screen.dart, employee_new_screen.dart, employee_detail_screen.dart
// and employee_import_screen.dart. Every write is checked again by SQL.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ApiError, newOperationId, post, rpc } from "@/lib/api";
import { dayLabel, todayIn } from "@/lib/attendance";
import type { LeaveType } from "@/lib/leave";
import {
  type EmployeeRow,
  type ImportPlan,
  type ImportRow,
  type NewEmployeeForm,
  type OrgStructure,
  type Paged,
  type PrivateDetails,
  type PrivateKey,
  type Ref,
  type Salary,
  PRIVATE_FIELDS,
  countKind,
  daysToUnits,
  EMAIL,
  employeeStatus,
  newEmployeeErrors,
  parseAmount,
  planImport,
  privateErrors,
  privatePatch,
  provisionPayload,
  readSheet,
  templateCsv,
  toCsv,
} from "@/lib/people";
import { caps, roleLabel } from "@/lib/roles";
import { employeeSignInUrl } from "@/lib/routing";
import { useSession } from "@/lib/session";
import { useRpc } from "@/lib/use-rpc";
import { Avatar, FileViewer } from "../files";
import { Banner, Button, EmptyState, ErrorState, KeyValue, LoadingState, PageTitle, PillTabs, SectionCard, Sheet, StatusChip, TextArea, TextField, cx } from "../ui";
import { withReauth } from "../reauth";
import { SignInShare } from "../sign-in-share";
import { type Saved, Select, SheetForm, activeOpts, useAction } from "../forms";
import { EmployeeMonth } from "./employee-month";
import { type DocItem, DocumentList, RemoveSheet, RenameSheet, SalaryCard, UploadDocumentSheet } from "./payroll";

const msg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const PAGE = 25;




/* ───────────────────────── List ───────────────────────── */

type StatusTab = "active" | "inactive";

export function EmployeesList() {
  const { context } = useSession();
  const c = caps(context);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusTab>("active");
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(search.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);
  const list = useRpc<Paged<EmployeeRow>>(context ? "list_employees" : null, { p_search: q || null, p_status: status, p_team_id: null, p_department_id: null, p_limit: PAGE, p_offset: offset });
  const total = list.data?.total ?? 0;
  return (
    <>
      <PageTitle
        title="Employees"
        back="/workspace"
        action={
          c.canProvision ? (
            <Link href="/employees/new" className="font-semibold text-primary">
              Add
            </Link>
          ) : undefined
        }
      />
      <div className="mx-auto flex max-w-xl md:max-w-3xl lg:max-w-5xl flex-col gap-3 p-page">
        <TextField label="Search" type="search" placeholder="Name, ID or email" value={search} onChange={(e) => setSearch(e.target.value)} />
        <PillTabs
          label="Status"
          tabs={[
            { id: "active", label: "Active" },
            { id: "inactive", label: "Inactive" },
          ]}
          value={status}
          onChange={(s) => {
            setStatus(s);
            setOffset(0);
          }}
        />
        {list.data?.active_cap != null && (
          <p className="text-body-sm text-text-secondary">
            {list.data.active_count} of {list.data.active_cap} active accounts used.
          </p>
        )}
        {(c.canProvision || c.canManagePayroll) && (
          <Link href="/employees/import" className="font-semibold text-primary">
            Import from Excel
          </Link>
        )}
        {list.error ? (
          <ErrorState message={msg(list.error, "Could not load employees.")} onRetry={() => list.mutate()} />
        ) : !list.data ? (
          <LoadingState />
        ) : list.data.rows.length === 0 ? (
          <EmptyState art="groups" title={q ? `Nobody matches “${q}”` : status === "active" ? "No active employees" : "No inactive employees"} />
        ) : (
          <>
            <ul className="flex flex-col gap-2">
              {list.data.rows.map((r) => {
                const st = employeeStatus(r.status);
                return (
                  <li key={r.id}>
                    <Link href={`/employees/${r.id}`} className="flex items-center gap-3 rounded-card border border-border bg-surface p-card hover:bg-background">
                      <Avatar name={r.name} versionId={r.avatar_file_version_id} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold">{r.name}</p>
                        <p className="truncate text-body-md text-text-secondary">{[r.code, r.designation, r.team?.name].filter(Boolean).join(" · ")}</p>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        {r.role !== "employee" && <StatusChip label={roleLabel(r.role)} tone="info" />}
                        {r.setup_pending ? <StatusChip label="Setup pending" tone="warning" /> : r.status !== "active" && <StatusChip label={st.label} tone={st.tone} />}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
            {total > PAGE && (
              <div className="flex items-center justify-between">
                <Button variant="outlined" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                  Previous
                </Button>
                <span className="text-body-sm text-text-secondary">
                  {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
                </span>
                <Button variant="outlined" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
                  Next
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

/* ───────────────────────── Temporary password ───────────────────────── */

export function TempPassword({ code, name, password }: { code: string; name?: string; password: string }) {
  return (
    <div className="rounded-card border border-warning bg-warning-soft p-card">
      <p className="text-body-md">
        Share these details privately with <b>{name ? `${name} (${code})` : code}</b>. This temporary password is shown once and must be changed at first sign-in.
      </p>
      <p className="my-2 select-all break-all font-mono text-title-lg" aria-label="Temporary password">
        {password}
      </p>
      <SignInShare code={code} name={name} password={password} />
    </div>
  );
}

interface ProvisionResult {
  data: { employee_id: string; employee_code?: string; temporary_password: string | null; already?: boolean };
}

/* ───────────────────────── New employee ───────────────────────── */

export function EmployeeNew({ now = new Date() }: { now?: Date }) {
  const { context } = useSession();
  const c = caps(context);
  const today = todayIn(context?.org.timezone ?? "Asia/Kolkata", now);
  const structure = useRpc<OrgStructure>("list_org_structure", {});
  const [roleForPreview, setRoleForPreview] = useState("member");
  const preview = useRpc<{ employee_code: string }>("preview_employee_code", { p_role: roleForPreview === "hr" || roleForPreview === "admin" ? roleForPreview : null });
  const [f, setF] = useState<NewEmployeeForm>({ employee_code: "", full_name: "", join_date: today, team_id: "", office_id: "", shift_id: "", department_id: "", role: "member", designation: "", business_email: "", business_phone: "", device_pin: "" });
  const [errors, setErrors] = useState<Partial<Record<keyof NewEmployeeForm, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ id: string; code: string; password: string | null } | null>(null);
  const op = useRef<string | null>(null);
  const s = structure.data;
  // One choice → pick it (as the import does).
  const pick = (k: "team_id" | "office_id" | "shift_id", items?: (Ref & { active: boolean })[]) => {
    const a = (items ?? []).filter((x) => x.active);
    return f[k] || (a.length === 1 ? a[0].id : "");
  };
  const form = s ? { ...f, team_id: pick("team_id", s.teams), office_id: pick("office_id", s.offices), shift_id: pick("shift_id", s.shifts) } : f;
  const set = (k: keyof NewEmployeeForm) => (v: string) => {
    if (k === "role") setRoleForPreview(v);
    setF({ ...form, [k]: v });
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs = newEmployeeErrors(form, c.isAdmin);
    setErrors(errs);
    setError(null);
    if (Object.keys(errs).length) return;
    const { fields, after, device_pin } = provisionPayload(form);
    setBusy(true);
    op.current ??= newOperationId();
    try {
      const res = await post<ProvisionResult>("/admin/users", { operation_id: op.current, fields, device_pin, device_serial: null });
      op.current = null;
      const id = res.data.employee_id;
      if (Object.keys(after).length) {
        try {
          const emp = await rpc<{ version: number }>("get_employee", { p_employee_id: id });
          await rpc("update_employee", { p_employee_id: id, p_patch: after, p_expected_version: emp.version });
        } catch (x) {
          setWarn(`The account was created, but the work details were not saved: ${msg(x, "try again on the employee page")}.`);
        }
      }
      setDone({ id, code: res.data.employee_code ?? fields.employee_code ?? "", password: res.data.temporary_password });
      void preview.mutate();
    } catch (x) {
      if (!(x instanceof ApiError && x.isNetwork)) op.current = null;
      if (x instanceof ApiError) setErrors(x.fieldErrors as Partial<Record<keyof NewEmployeeForm, string>>);
      setError(msg(x, "Could not create the employee."));
    } finally {
      setBusy(false);
    }
  };
  if (!c.canProvision && context) return <><PageTitle title="Add employee" back="/employees" /><ErrorState message="Only HR and Admin can add employees." /></>;
  if (structure.error) return <><PageTitle title="Add employee" back="/employees" /><ErrorState message={msg(structure.error, "Could not load teams and offices.")} onRetry={() => structure.mutate()} /></>;
  if (!s) return <><PageTitle title="Add employee" back="/employees" /><LoadingState /></>;
  if (done)
    return (
      <>
        <PageTitle title="Employee added" back="/employees" />
        <div className="mx-auto flex max-w-xl md:max-w-3xl lg:max-w-5xl flex-col gap-4 p-page">
          <Banner tone="success">{done.code} can now sign in.</Banner>
          {warn && <Banner tone="warning">{warn}</Banner>}
          {done.password ? <TempPassword code={done.code} name={f.full_name.trim()} password={done.password} /> : <Banner tone="info">This account already existed. Reset the password from the employee page if needed.</Banner>}
          <Link href={`/employees/${done.id}`} className="inline-flex min-h-12 items-center justify-center rounded-button bg-primary font-semibold text-white">
            Open employee
          </Link>
        </div>
      </>
    );
  const roles = [
    { value: "member", label: "Employee" },
    { value: "manager", label: "Manager (label only)" },
    ...(c.isAdmin
      ? [
          { value: "hr", label: "HR" },
          { value: "admin", label: "Admin" },
        ]
      : []),
  ];
  return (
    <>
      <PageTitle title="Add employee" back="/employees" />
      <form noValidate onSubmit={submit} className="mx-auto flex max-w-xl md:max-w-2xl flex-col gap-3 p-page">
        {error && <Banner>{error}</Banner>}
        <p className="rounded-row bg-background px-4 py-3 text-body-md" aria-live="polite">
          Employee ID: <span className="font-semibold">{preview.data?.employee_code ?? "…"}</span>
          <span className="block text-body-sm text-text-secondary">Given automatically when you save.</span>
        </p>
        {errors.employee_code && <Banner>{errors.employee_code}</Banner>}
        <TextField label="Full name" value={form.full_name} onChange={(e) => set("full_name")(e.target.value)} error={errors.full_name} autoComplete="off" />
        <TextField label="Join date" type="date" value={form.join_date} onChange={(e) => set("join_date")(e.target.value)} error={errors.join_date} />
        <Select label="Role" value={form.role} onChange={set("role")} options={roles} error={errors.role} />
        <Select label="Team" value={form.team_id} onChange={set("team_id")} options={activeOpts(s.teams)} placeholder="Choose a team" error={errors.team_id} />
        <Select label="Office" value={form.office_id} onChange={set("office_id")} options={activeOpts(s.offices)} placeholder="Choose an office" error={errors.office_id} />
        <Select label="Shift" value={form.shift_id} onChange={set("shift_id")} options={activeOpts(s.shifts)} placeholder="Choose a shift" error={errors.shift_id} />
        <Select label="Department (optional)" value={form.department_id} onChange={set("department_id")} options={activeOpts(s.departments)} placeholder="None" />
        <TextField label="Designation (optional)" value={form.designation} onChange={(e) => set("designation")(e.target.value)} />
        <TextField label="Work email (optional)" type="email" value={form.business_email} onChange={(e) => set("business_email")(e.target.value)} error={errors.business_email} />
        <TextField label="Work phone (optional)" type="tel" value={form.business_phone} onChange={(e) => set("business_phone")(e.target.value)} error={errors.business_phone} />
        <TextField label="Machine PIN (optional)" inputMode="numeric" value={form.device_pin} onChange={(e) => set("device_pin")(e.target.value)} error={errors.device_pin} hint="Leave empty and a new PIN is given and sent to the machines automatically. Fill it only if the person is already on a machine." />
        <Button type="submit" busy={busy}>
          Create account
        </Button>
      </form>
    </>
  );
}

/* ───────────────────────── Detail ───────────────────────── */

interface History {
  from: string;
  to: string | null;
  reason?: string;
}
interface Device {
  id: string;
  platform: string | null;
  label: string | null;
  registered_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
}
export interface EmployeeDetailData {
  id: string;
  code: string;
  name: string;
  designation: string | null;
  position_label: string | null;
  role: string;
  roles: string[];
  status: string;
  join_date: string | null;
  end_date: string | null;
  business_email: string | null;
  business_phone: string | null;
  avatar_file_version_id: string | null;
  department: Ref | null;
  team: Ref | null;
  can_edit: boolean;
  can_manage_payroll: boolean;
  must_change_password: boolean;
  credential_hold: boolean;
  provisioning_state: string;
  devices: Device[];
  private: PrivateDetails | null;
  offices: (History & { office: string; office_id: string })[];
  shifts: (History & { shift: string; shift_id: string })[];
  teams: (History & { team: string; team_id: string })[];
  version: number;
}
interface EmployeeFiles {
  documents: DocItem[];
  payslips: { salary_month: string; file_version_id: string | null; state: string | null; published_at: string | null; version: number }[] | null;
  can_upload: boolean;
  can_manage_payroll: boolean;
  document_count: number;
  document_limit: number;
  title_max: number;
}

type Tab = "details" | "attendance" | "pay" | "files" | "more";
type SheetKind = "work" | "private" | "status" | "access" | "reset" | "team" | "office" | "shift" | "salary" | "leave" | "exception" | "doc" | null;

const current = <T extends History>(rows: T[]) => rows.find((r) => r.to == null) ?? rows[0];

export function EmployeeDetail({ id, now = new Date() }: { id: string; now?: Date }) {
  const { context } = useSession();
  const c = caps(context);
  const today = todayIn(context?.org.timezone ?? "Asia/Kolkata", now);
  const q = useRpc<EmployeeDetailData>("get_employee", { p_employee_id: id });
  const [tab, setTab] = useState<Tab>("details");
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Device | null>(null);
  const files = useRpc<EmployeeFiles>(tab === "pay" || tab === "files" ? "list_employee_files" : null, { p_employee_id: id });
  const salary = useRpc<Salary & { version?: number }>(tab === "pay" && q.data?.can_manage_payroll ? "get_employee_salary" : null, { p_employee_id: id });
  const [open, setOpen] = useState<{ id: string; title: string } | null>(null);
  const [renaming, setRenaming] = useState<DocItem | null>(null);
  const [removing, setRemoving] = useState<DocItem | null>(null);

  if (q.error) return <><PageTitle title="Employee" back="/employees" /><ErrorState message={msg(q.error, "Could not load this employee.")} onRetry={() => q.mutate()} /></>;
  if (!q.data) return <><PageTitle title="Employee" back="/employees" /><LoadingState /></>;
  const e = q.data;
  const st = employeeStatus(e.status);
  const self = e.id === context?.employee.id;
  const done = (text: string) => async () => {
    setSheet(null);
    setRevoking(null);
    setRenaming(null);
    setRemoving(null);
    setNotice(text);
    await Promise.all([q.mutate(), files.mutate(), salary.mutate()]);
  };
  const team = current(e.teams);
  const office = current(e.offices);
  const shift = current(e.shifts);
  const tabs: { id: Tab; label: string }[] = [
    { id: "details", label: "Details" },
    ...(c.canOrgReports ? [{ id: "attendance" as Tab, label: "Attendance" }] : []),
    ...(e.can_manage_payroll ? [{ id: "pay" as Tab, label: "Pay" }] : []),
    { id: "files", label: "Files" },
    { id: "more", label: "More" },
  ];
  const edit = (k: SheetKind, label = "Change") =>
    e.can_edit ? (
      <Button variant="text" onClick={() => setSheet(k)}>
        {label}
      </Button>
    ) : null;

  return (
    <>
      <PageTitle title={e.name} back="/employees" />
      <div className="mx-auto flex max-w-xl md:max-w-3xl lg:max-w-5xl flex-col gap-4 p-page">
        {notice && <Banner tone="success">{notice}</Banner>}
        <SectionCard>
          <div className="flex items-center gap-4">
            <Avatar name={e.name} versionId={e.avatar_file_version_id} size={64} />
            <div className="min-w-0 flex-1">
              <p className="text-title-lg font-semibold">{e.name}</p>
              <p className="text-body-md text-text-secondary">{[e.code, e.designation].filter(Boolean).join(" · ")}</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <StatusChip label={st.label} tone={st.tone} />
                <StatusChip label={roleLabel(e.role)} tone="info" />
                {e.position_label === "manager" && <StatusChip label="Manager" tone="neutral" />}
                {e.must_change_password && <StatusChip label="Must change password" tone="warning" />}
                {e.credential_hold && <StatusChip label="Sign-in on hold" tone="error" />}
              </div>
            </div>
          </div>
        </SectionCard>
        <PillTabs label="Sections" tabs={tabs} value={tab} onChange={setTab} />

        {tab === "attendance" && <EmployeeMonth employeeId={e.id} today={today} canSeePay={e.can_manage_payroll} />}

        {tab === "details" && (
          <>
            <SectionCard>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-title-sm font-semibold">Work</h2>
                {edit("work", "Edit")}
              </div>
              <KeyValue k="Department" v={e.department?.name ?? "—"} />
              <KeyValue k="Work email" v={e.business_email ?? "—"} />
              <KeyValue k="Work phone" v={e.business_phone ?? "—"} />
              <KeyValue k="Joined" v={e.join_date ? dayLabel(e.join_date) : "—"} />
              {e.end_date && <KeyValue k="Left" v={dayLabel(e.end_date)} />}
            </SectionCard>
            <SectionCard>
              <h2 className="mb-2 text-title-sm font-semibold">Assignment</h2>
              {(
                [
                  ["Team", team?.team, "team"],
                  ["Office", office?.office, "office"],
                  ["Shift", shift?.shift, "shift"],
                ] as const
              ).map(([k, v, s]) => (
                <div key={k} className="flex items-center justify-between">
                  <KeyValue k={k} v={v ?? "—"} />
                  {edit(s)}
                </div>
              ))}
            </SectionCard>
            <SectionCard>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-title-sm font-semibold">Access</h2>
                {c.canManageAccess && !self && (
                  <Button variant="text" onClick={() => setSheet("access")}>
                    Change
                  </Button>
                )}
              </div>
              <KeyValue k="Role" v={roleLabel(e.role)} />
              <KeyValue k="Label" v={e.position_label === "manager" ? "Manager" : "Member"} />
              {c.canViewEmployees && e.status === "active" && e.provisioning_state === "complete" && (
                <div className="mt-2">
                  <SignInShare key={e.code} code={e.code} name={e.name} />
                </div>
              )}
            </SectionCard>
            <SectionCard>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-title-sm font-semibold">Personal</h2>
                {edit("private", "Edit")}
              </div>
              {PRIVATE_FIELDS.map((f) => {
                const v = e.private?.[f.key];
                return <KeyValue key={f.key} k={f.label} v={v ? (f.key === "date_of_birth" ? dayLabel(String(v)) : String(v)) : "—"} />;
              })}
            </SectionCard>
            {e.can_edit && !self && (
              <div className="flex flex-col gap-2">
                <TwoStepAdmin id={e.id} />
                <Button variant="outlined" onClick={() => setSheet("reset")} disabled={e.status !== "active"}>
                  Reset password
                </Button>
                <Button variant={e.status === "active" ? "danger" : "outlined"} onClick={() => setSheet("status")}>
                  {e.status === "active" ? "Deactivate" : "Reactivate"}
                </Button>
              </div>
            )}
          </>
        )}

        {tab === "pay" && (
          <>
            {salary.error ? (
              <ErrorState message={msg(salary.error, "Could not load salary.")} onRetry={() => salary.mutate()} />
            ) : !salary.data ? (
              <LoadingState />
            ) : (
              <SalaryCard s={salary.data} editable={salary.data.can_edit !== false && (!self || c.isAdmin)} onEdit={() => setSheet("salary")} />
            )}
            <SectionCard>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-title-sm font-semibold">Payslips</h2>
                <Link href="/payroll/uploads" className="font-semibold text-primary">
                  Upload
                </Link>
              </div>
              {!files.data ? (
                <LoadingState />
              ) : !files.data.payslips?.length ? (
                <p className="text-body-md text-text-secondary">No payslips uploaded.</p>
              ) : (
                files.data.payslips.map((p) => (
                  <div key={p.salary_month} className="flex items-center justify-between">
                    <KeyValue k={new Date(`${p.salary_month}T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" })} v={p.published_at ? "Published" : "Not published"} />
                    {p.file_version_id && (
                      <Button variant="text" onClick={() => setOpen({ id: p.file_version_id!, title: `Payslip · ${p.salary_month.slice(0, 7)}` })}>
                        Open
                      </Button>
                    )}
                  </div>
                ))
              )}
            </SectionCard>
          </>
        )}

        {tab === "files" &&
          (files.error ? (
            <ErrorState message={msg(files.error, "Could not load files.")} onRetry={() => files.mutate()} />
          ) : !files.data ? (
            <LoadingState />
          ) : (
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <p className="text-body-sm text-text-secondary">
                  {files.data.document_count} of {files.data.document_limit} documents
                </p>
                {files.data.can_upload && (
                  <Button variant="text" disabled={files.data.document_count >= files.data.document_limit} onClick={() => setSheet("doc")}>
                    Add document
                  </Button>
                )}
              </div>
              <DocumentList
                items={files.data.documents}
                emptyTitle="No documents"
                onOpen={(d) => d.file_version_id && setOpen({ id: d.file_version_id, title: d.title || "Document" })}
                onRename={files.data.can_upload ? setRenaming : undefined}
                onRemove={files.data.can_upload ? setRemoving : undefined}
              />
            </section>
          ))}

        {tab === "more" && (
          <>
            {e.can_edit && (
              <SectionCard>
                <h2 className="mb-2 text-title-sm font-semibold">Leave and schedule</h2>
                <div className="flex flex-col gap-2">
                  <Button variant="outlined" onClick={() => setSheet("leave")}>
                    Adjust leave balance
                  </Button>
                  <Button variant="outlined" onClick={() => setSheet("exception")}>
                    Extra workday or day off
                  </Button>
                </div>
              </SectionCard>
            )}
            <SectionCard>
              <h2 className="mb-2 text-title-sm font-semibold">Phones</h2>
              {e.devices.length === 0 ? (
                <p className="text-body-md text-text-secondary">No phone registered yet.</p>
              ) : (
                e.devices.map((d) => (
                  <div key={d.id} className="flex items-center justify-between border-b border-border py-2 last:border-0">
                    <div>
                      <p className="font-semibold">{d.label || d.platform || "Phone"}</p>
                      <p className="text-body-sm text-text-secondary">
                        {d.revoked_at ? `Removed ${dayLabel(d.revoked_at.slice(0, 10))}${d.revoke_reason ? ` · ${d.revoke_reason}` : ""}` : `Added ${dayLabel(d.registered_at.slice(0, 10))}${d.last_used_at ? ` · last used ${dayLabel(d.last_used_at.slice(0, 10))}` : ""}`}
                      </p>
                    </div>
                    {!d.revoked_at && e.can_edit && (
                      <Button variant="text" className="text-error" onClick={() => setRevoking(d)}>
                        Remove
                      </Button>
                    )}
                  </div>
                ))
              )}
            </SectionCard>
            <SectionCard>
              <h2 className="mb-2 text-title-sm font-semibold">History</h2>
              {[...e.teams.map((t) => ({ ...t, what: `Team: ${t.team}` })), ...e.offices.map((o) => ({ ...o, what: `Office: ${o.office}` })), ...e.shifts.map((s) => ({ ...s, what: `Shift: ${s.shift}` }))]
                .sort((a, b) => b.from.localeCompare(a.from))
                .map((h, i) => (
                  <KeyValue key={i} k={`${dayLabel(h.from)}${h.to ? ` – ${dayLabel(h.to)}` : " onwards"}`} v={h.what} />
                ))}
            </SectionCard>
          </>
        )}
      </div>

      {sheet === "work" && <WorkSheet e={e} onClose={() => setSheet(null)} onSaved={done("Saved.")} />}
      {sheet === "private" && <PrivateSheet e={e} today={today} onClose={() => setSheet(null)} onSaved={done("Personal details saved.")} />}
      {sheet === "status" && <StatusSheet e={e} today={today} onClose={() => setSheet(null)} onSaved={done(e.status === "active" ? "Deactivated." : "Reactivated.")} />}
      {sheet === "access" && <AccessSheet e={e} isAdmin={c.isAdmin} onClose={() => setSheet(null)} onSaved={done("Access changed.")} />}
      {sheet === "reset" && <ResetSheet e={e} onClose={() => setSheet(null)} />}
      {(sheet === "team" || sheet === "office" || sheet === "shift") && <AssignSheet kind={sheet} e={e} today={today} onClose={() => setSheet(null)} onSaved={done("Change saved.")} />}
      {sheet === "salary" && salary.data && <SalarySheet employeeId={e.id} s={salary.data} today={today} onClose={() => setSheet(null)} onSaved={done("Salary saved.")} />}
      {sheet === "leave" && <LeaveAdjustSheet employeeId={e.id} year={Number(today.slice(0, 4))} onClose={() => setSheet(null)} onSaved={done("Leave balance adjusted.")} />}
      {sheet === "exception" && <ExceptionSheet employeeId={e.id} today={today} onClose={() => setSheet(null)} onSaved={done("Schedule change saved.")} />}
      {sheet === "doc" && files.data && <UploadDocumentSheet cls="employee_document" ownerEmployeeId={e.id} askDate titleMax={files.data.title_max} today={today} onClose={() => setSheet(null)} onSaved={done("Document uploaded.")} />}
      {revoking && <RevokeSheet device={revoking} onClose={() => setRevoking(null)} onSaved={done("Phone removed. They must register again to punch.")} />}
      {renaming && <RenameSheet doc={renaming} titleMax={files.data?.title_max} onClose={() => setRenaming(null)} onSaved={done("Renamed.")} />}
      {removing && <RemoveSheet doc={removing} onClose={() => setRemoving(null)} onSaved={done("Removed.")} />}
      {open && <FileViewer versionId={open.id} title={open.title} onClose={() => setOpen(null)} />}
    </>
  );
}



function WorkSheet({ e, onClose, onSaved }: { e: EmployeeDetailData } & Saved) {
  const structure = useRpc<OrgStructure>("list_org_structure", {});
  const a = useAction();
  const [v, setV] = useState({ full_name: e.name, designation: e.designation ?? "", department_id: e.department?.id ?? "", business_email: e.business_email ?? "", business_phone: e.business_phone ?? "", join_date: e.join_date ?? "" });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const save = () => {
    const x: Record<string, string> = {};
    if (v.full_name.trim().length < 2) x.full_name = "Enter the full name.";
    if (v.business_email.trim() && !EMAIL.test(v.business_email.trim())) x.business_email = "Enter a valid email.";
    if (!v.join_date) x.join_date = "Choose the join date.";
    setErrs(x);
    if (Object.keys(x).length) return;
    const before: Record<string, string> = { full_name: e.name, designation: e.designation ?? "", department_id: e.department?.id ?? "", business_email: e.business_email ?? "", business_phone: e.business_phone ?? "", join_date: e.join_date ?? "" };
    const patch: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) if (val.trim() !== before[k]) patch[k] = val.trim();
    if (!Object.keys(patch).length) return a.setError("Nothing changed.");
    a.run(async () => {
      await rpc("update_employee", { p_employee_id: e.id, p_patch: patch, p_expected_version: e.version });
      await onSaved();
    }, "Could not save.");
  };
  const err = (k: string) => errs[k] ?? a.fields[k];
  return (
    <SheetForm title="Work details" submit="Save" busy={a.busy} error={a.error} onClose={onClose} onSubmit={save}>
      <TextField label="Full name" value={v.full_name} onChange={(x) => setV({ ...v, full_name: x.target.value })} error={err("full_name")} />
      <TextField label="Designation" value={v.designation} onChange={(x) => setV({ ...v, designation: x.target.value })} />
      <Select label="Department" value={v.department_id} onChange={(x) => setV({ ...v, department_id: x })} options={activeOpts(structure.data?.departments, e.department?.id)} placeholder="None" />
      <TextField label="Work email" type="email" value={v.business_email} onChange={(x) => setV({ ...v, business_email: x.target.value })} error={err("business_email")} />
      <TextField label="Work phone" type="tel" value={v.business_phone} onChange={(x) => setV({ ...v, business_phone: x.target.value })} />
      <TextField label="Join date" type="date" value={v.join_date} onChange={(x) => setV({ ...v, join_date: x.target.value })} error={err("join_date")} />
    </SheetForm>
  );
}

function PrivateSheet({ e, today, onClose, onSaved }: { e: EmployeeDetailData; today: string } & Saved) {
  const a = useAction();
  const [v, setV] = useState(Object.fromEntries(PRIVATE_FIELDS.map((f) => [f.key, String(e.private?.[f.key] ?? "")])) as Record<PrivateKey, string>);
  const [errs, setErrs] = useState<Partial<Record<PrivateKey, string>>>({});
  const save = () => {
    const x = privateErrors(v, today);
    setErrs(x);
    if (Object.keys(x).length) return;
    const patch = privatePatch(e.private, v);
    if (!Object.keys(patch).length) return a.setError("Nothing changed.");
    a.run(async () => {
      await rpc("update_private_details", { p_employee_id: e.id, p_patch: patch, p_expected_version: e.private?.version ?? 0 });
      await onSaved();
    }, "Could not save.");
  };
  return (
    <SheetForm title="Personal details" submit="Save" busy={a.busy} error={a.error} onClose={onClose} onSubmit={save}>
      {PRIVATE_FIELDS.map((f) => (
        <TextField key={f.key} label={f.label} type={f.type} value={v[f.key]} max={f.key === "date_of_birth" ? today : undefined} onChange={(x) => setV({ ...v, [f.key]: x.target.value })} error={errs[f.key] ?? a.fields[f.key]} />
      ))}
    </SheetForm>
  );
}

function StatusSheet({ e, today, onClose, onSaved }: { e: EmployeeDetailData; today: string } & Saved) {
  const a = useAction();
  const off = e.status === "active";
  const [end, setEnd] = useState(today);
  const [reason, setReason] = useState("");
  const save = () => {
    if (reason.trim().length < 3) return a.setError("Give a reason.");
    if (off && (!end || (e.join_date && end < e.join_date))) return a.setError("The last day cannot be before the join date.");
    a.run(async () => {
      await rpc("set_employee_status", { p_employee_id: e.id, p_status: off ? "inactive" : "active", p_end_date: off ? end : null, p_reason: reason.trim(), p_expected_version: e.version });
      await onSaved();
    }, "Could not change the status.");
  };
  return (
    <SheetForm title={off ? `Deactivate ${e.name}?` : `Reactivate ${e.name}?`} submit={off ? "Deactivate" : "Reactivate"} busy={a.busy} error={a.error} onClose={onClose} onSubmit={save}>
      <p className="text-body-md">{off ? "They are signed out everywhere and can no longer punch or apply. Records are kept." : "They can sign in again and count towards the active account limit."}</p>
      {off && <TextField label="Last working day" type="date" value={end} onChange={(x) => setEnd(x.target.value)} />}
      <TextArea label="Reason" value={reason} onChange={setReason} maxLength={500} />
    </SheetForm>
  );
}

function AccessSheet({ e, isAdmin, onClose, onSaved }: { e: EmployeeDetailData; isAdmin: boolean } & Saved) {
  const a = useAction();
  const [role, setRole] = useState(e.role === "admin" || e.role === "hr" ? e.role : "employee");
  const [label, setLabel] = useState(e.position_label === "manager" ? "manager" : "member");
  const [reason, setReason] = useState("");
  const save = () => {
    if (reason.trim().length < 3) return a.setError("Give a reason.");
    a.run(async () => {
      await withReauth("role.elevate", e.id, () => rpc("set_employee_access", { p_employee_id: e.id, p_role: role, p_label: label, p_reason: reason.trim() }));
      await onSaved();
    }, "Could not change access.");
  };
  const roles = [{ value: "employee", label: "Employee" }, ...(isAdmin ? [{ value: "hr", label: "HR" }, { value: "admin", label: "Admin" }] : [])];
  return (
    <SheetForm title="Access" submit="Save" busy={a.busy} error={a.error} onClose={onClose} onSubmit={save}>
      <Select label="Role" value={role} onChange={setRole} options={roles} />
      <Select label="Label" value={label} onChange={setLabel} options={[{ value: "member", label: "Member" }, { value: "manager", label: "Manager" }]} />
      <p className="text-body-sm text-text-secondary">HR and Admin can review requests and manage records. The Manager label is shown on profiles only.</p>
      <TextArea label="Reason" value={reason} onChange={setReason} maxLength={500} />
    </SheetForm>
  );
}

/** Admin only: see and turn off someone's two-step sign-in (lost phone). */
export function TwoStepAdmin({ id }: { id: string }) {
  const { caps: c } = useSession();
  const q = useRpc<{ enabled: boolean }>(c.isAdmin ? "get_employee_two_step" : null, { p_employee_id: id });
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState(false);
  const a = useAction();
  if (!c.isAdmin || !q.data) return null;
  return (
    <SectionCard>
      <div className="flex flex-col gap-2">
        <KeyValue k="Two-step sign-in" v={q.data.enabled ? "On" : "Off"} />
        {done && <Banner tone="success">Two-step sign-in is off. They can sign in with their password and set it up again.</Banner>}
        {a.error && <Banner>{a.error}</Banner>}
        {q.data.enabled &&
          (confirm ? (
            <div className="flex flex-col gap-2">
              <p className="text-body-md">Only do this if they lost their phone and recovery codes and you have checked who they are.</p>
              <div className="flex gap-3">
                <Button
                  variant="danger"
                  busy={a.busy}
                  onClick={() =>
                    a.run(async () => {
                      await withReauth("mfa.reset", id, () => rpc("reset_two_step", { p_employee_id: id }));
                      setDone(true);
                      setConfirm(false);
                      await q.mutate();
                    }, "Could not turn it off.")
                  }
                >
                  Turn off
                </Button>
                <Button variant="text" onClick={() => setConfirm(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="outlined" onClick={() => setConfirm(true)}>
              Turn off two-step sign-in
            </Button>
          ))}
      </div>
    </SectionCard>
  );
}

function ResetSheet({ e, onClose }: { e: EmployeeDetailData; onClose: () => void }) {
  const a = useAction();
  const [pw, setPw] = useState<string | null>(null);
  const op = useRef(newOperationId());
  if (pw)
    return (
      <Sheet title="Password reset" onClose={onClose}>
        <TempPassword code={e.code} name={e.name} password={pw} />
      </Sheet>
    );
  return (
    <SheetForm
      title={`Reset ${e.name}'s password?`}
      submit="Reset password"
      busy={a.busy}
      error={a.error}
      onClose={onClose}
      onSubmit={() =>
        a.run(async () => {
          const r = await withReauth("credentials.reset_admin", e.id, () => post<ProvisionResult>(`/admin/users/${e.id}/reset-password`, { operation_id: op.current }));
          if (!r.data.temporary_password) throw new Error("No password was returned. Try again.");
          setPw(r.data.temporary_password);
        }, "Could not reset the password.")
      }
    >
      <p className="text-body-md">They are signed out everywhere and must set a new password with the temporary one.</p>
    </SheetForm>
  );
}

function AssignSheet({ kind, e, today, onClose, onSaved }: { kind: "team" | "office" | "shift"; e: EmployeeDetailData; today: string } & Saved) {
  const structure = useRpc<OrgStructure>("list_org_structure", {});
  const a = useAction();
  const cur = kind === "team" ? current(e.teams)?.team_id : kind === "office" ? current(e.offices)?.office_id : current(e.shifts)?.shift_id;
  const [value, setValue] = useState(cur ?? "");
  const [from, setFrom] = useState(today);
  const [reason, setReason] = useState("");
  const items = kind === "team" ? structure.data?.teams : kind === "office" ? structure.data?.offices : structure.data?.shifts;
  const save = () => {
    if (!value || value === cur) return a.setError(`Choose a different ${kind}.`);
    if (!from) return a.setError("Choose the start date.");
    if (reason.trim().length < 3) return a.setError("Give a reason.");
    a.run(async () => {
      await rpc(`set_employee_${kind}`, { p_employee_id: e.id, [`p_${kind}_id`]: value, p_effective_from: from, p_reason: reason.trim() });
      await onSaved();
    }, `Could not change the ${kind}.`);
  };
  const name = kind[0].toUpperCase() + kind.slice(1);
  return (
    <SheetForm title={`Change ${kind}`} submit="Save" busy={a.busy} error={a.error} onClose={onClose} onSubmit={save}>
      <Select label={name} value={value} onChange={setValue} options={activeOpts(items, cur)} placeholder={`Choose a ${kind}`} />
      <TextField label="From" type="date" value={from} onChange={(x) => setFrom(x.target.value)} />
      <TextArea label="Reason" value={reason} onChange={setReason} maxLength={500} />
    </SheetForm>
  );
}

function SalarySheet({ employeeId, s, today, onClose, onSaved }: { employeeId: string; s: Salary & { version?: number }; today: string } & Saved) {
  const a = useAction();
  const [amount, setAmount] = useState(s.profile?.monthly_salary != null ? String(s.profile.monthly_salary) : "");
  const [from, setFrom] = useState(today.slice(0, 8) + "01");
  const [reason, setReason] = useState("");
  const save = () => {
    const n = parseAmount(amount);
    if (n == null) return a.setError("Enter the monthly salary, like 45000.");
    if (!from) return a.setError("Choose when it starts.");
    if (reason.trim().length < 3) return a.setError("Give a reason.");
    a.run(async () => {
      await rpc("set_employee_salary", { p_employee_id: employeeId, p_fields: { monthly_salary: n, effective_from: from }, p_reason: reason.trim(), p_expected_version: s.profile?.version ?? s.version ?? 0 });
      await onSaved();
    }, "Could not save the salary.");
  };
  return (
    <SheetForm title="Monthly salary" submit="Save" busy={a.busy} error={a.error} onClose={onClose} onSubmit={save}>
      <TextField label="Monthly salary (₹)" inputMode="decimal" value={amount} onChange={(x) => setAmount(x.target.value)} error={a.fields.monthly_salary} />
      <TextField label="Effective from" type="date" value={from} onChange={(x) => setFrom(x.target.value)} error={a.fields.effective_from} />
      <TextArea label="Reason" value={reason} onChange={setReason} maxLength={500} />
    </SheetForm>
  );
}

function LeaveAdjustSheet({ employeeId, year, onClose, onSaved }: { employeeId: string; year: number } & Saved) {
  const types = useRpc<LeaveType[]>("list_leave_types", { p_include_inactive: false });
  const a = useAction();
  const [type, setType] = useState("");
  const [y, setY] = useState(String(year));
  const [days, setDays] = useState("");
  const [reason, setReason] = useState("");
  const save = () => {
    const units = daysToUnits(days);
    if (!type) return a.setError("Choose a leave type.");
    if (units == null) return a.setError("Enter days in halves, like 1, 0.5 or -2. Not zero.");
    if (reason.trim().length < 3) return a.setError("Give a reason.");
    a.run(async () => {
      await rpc("adjust_leave_balance", { p_employee_id: employeeId, p_leave_type_id: type, p_leave_year: Number(y), p_units: units, p_reason: reason.trim() });
      await onSaved();
    }, "Could not adjust the balance.");
  };
  return (
    <SheetForm title="Adjust leave balance" submit="Save" busy={a.busy} error={a.error} onClose={onClose} onSubmit={save}>
      <Select label="Leave type" value={type} onChange={setType} options={(types.data ?? []).map((t) => ({ value: t.id, label: t.name }))} placeholder="Choose" />
      <Select label="Year" value={y} onChange={setY} options={[year - 1, year, year + 1].map((n) => ({ value: String(n), label: String(n) }))} />
      <TextField label="Days (use a minus sign to take away)" inputMode="decimal" value={days} onChange={(x) => setDays(x.target.value)} />
      <TextArea label="Reason" value={reason} onChange={setReason} maxLength={500} />
    </SheetForm>
  );
}

function ExceptionSheet({ employeeId, today, onClose, onSaved }: { employeeId: string; today: string } & Saved) {
  const structure = useRpc<OrgStructure>("list_org_structure", {});
  const a = useAction();
  const [date, setDate] = useState("");
  const [kind, setKind] = useState("day_off");
  const [shift, setShift] = useState("");
  const [reason, setReason] = useState("");
  const save = () => {
    if (!date || date <= today) return a.setError("Choose a date after today.");
    if (kind === "extra_workday" && !shift) return a.setError("Choose the shift for the extra workday.");
    if (reason.trim().length < 3) return a.setError("Give a reason.");
    a.run(async () => {
      await rpc("save_schedule_exception", { p_employee_id: employeeId, p_work_date: date, p_kind: kind, p_shift_id: kind === "extra_workday" ? shift : null, p_reason: reason.trim() });
      await onSaved();
    }, "Could not save.");
  };
  return (
    <SheetForm title="Schedule change" submit="Save" busy={a.busy} error={a.error} onClose={onClose} onSubmit={save}>
      <TextField label="Date" type="date" value={date} min={today} onChange={(x) => setDate(x.target.value)} />
      <Select label="Change" value={kind} onChange={setKind} options={[{ value: "day_off", label: "Day off" }, { value: "extra_workday", label: "Extra workday" }]} />
      {kind === "extra_workday" && <Select label="Shift" value={shift} onChange={setShift} options={activeOpts(structure.data?.shifts)} placeholder="Choose a shift" />}
      <TextArea label="Reason" value={reason} onChange={setReason} maxLength={500} />
    </SheetForm>
  );
}

function RevokeSheet({ device, onClose, onSaved }: { device: Device } & Saved) {
  const a = useAction();
  const [reason, setReason] = useState("");
  return (
    <SheetForm
      title="Remove this phone?"
      submit="Remove"
      busy={a.busy}
      error={a.error}
      onClose={onClose}
      onSubmit={() => {
        if (reason.trim().length < 3) return a.setError("Give a reason.");
        a.run(async () => {
          await rpc("revoke_device", { p_device_id: device.id, p_reason: reason.trim() });
          await onSaved();
        }, "Could not remove the phone.");
      }}
    >
      <p className="text-body-md">{device.label || device.platform || "This phone"} can no longer be used to punch.</p>
      <TextArea label="Reason" value={reason} onChange={setReason} maxLength={500} />
    </SheetForm>
  );
}

/* ───────────────────────── Import ───────────────────────── */

const KIND_CHIP: Record<string, { label: string; tone: "success" | "info" | "neutral" | "error" }> = {
  create: { label: "New", tone: "success" },
  update: { label: "Update", tone: "info" },
  unchanged: { label: "No change", tone: "neutral" },
  error: { label: "Fix", tone: "error" },
};

interface ApplyResult {
  row: number;
  code: string;
  name: string;
  ok: boolean;
  message: string;
  password?: string | null;
}

async function allEmployees(): Promise<Map<string, EmployeeRow>> {
  const map = new Map<string, EmployeeRow>();
  for (let offset = 0; offset < 10000; offset += 100) {
    const page = await rpc<Paged<EmployeeRow>>("list_employees", { p_search: null, p_status: "all", p_team_id: null, p_department_id: null, p_limit: 100, p_offset: offset });
    for (const r of page.rows) map.set(r.code.toUpperCase(), r);
    if (page.rows.length < 100) break;
  }
  return map;
}

function download(name: string, text: string, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function applyRow(r: ImportRow): Promise<ApplyResult> {
  const base = { row: r.rowNumber, code: r.values.code, name: r.values.name };
  let password: string | null | undefined;
  try {
    let id = r.existing?.id ?? null;
    if (r.kind === "create") {
      const fields: Record<string, string> = { employee_code: base.code, full_name: base.name, join_date: r.values.join_date, team_id: r.teamId!, office_id: r.officeId!, shift_id: r.shiftId!, role: r.role ?? "member" };
      if (r.departmentId) fields.department_id = r.departmentId;
      const res = await post<ProvisionResult>("/admin/users", { operation_id: newOperationId(), fields, device_pin: null, device_serial: null });
      id = res.data.employee_id;
      base.code = res.data.employee_code ?? base.code;
      password = res.data.temporary_password;
      const after: Record<string, string> = {};
      if (r.values.designation) after.designation = r.values.designation;
      if (r.values.email) after.business_email = r.values.email;
      if (r.values.phone) after.business_phone = r.values.phone;
      if (Object.keys(after).length) {
        const emp = await rpc<{ version: number }>("get_employee", { p_employee_id: id });
        await rpc("update_employee", { p_employee_id: id, p_patch: after, p_expected_version: emp.version });
      }
    } else if (Object.keys(r.patch).length && r.existing) {
      await rpc("update_employee", { p_employee_id: r.existing.id, p_patch: r.patch, p_expected_version: r.existing.version });
    }
    if (id && Object.keys(r.salary).length) {
      const s = await rpc<Salary & { version?: number }>("get_employee_salary", { p_employee_id: id });
      await rpc("set_employee_salary", { p_employee_id: id, p_fields: r.salary, p_reason: "Excel import", p_expected_version: s.profile?.version ?? s.version ?? 0 });
    }
    return { ...base, ok: true, message: r.kind === "create" ? "Created" : "Updated", password };
  } catch (x) {
    return { ...base, ok: false, message: msg(x, "Failed"), password };
  }
}

export function EmployeeImport() {
  const { context } = useSession();
  const c = caps(context);
  const router = useRouter();
  const structure = useRpc<OrgStructure>("list_org_structure", {});
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<ApplyResult[] | null>(null);
  const read = async (file: File | null) => {
    setPlan(null);
    setResults(null);
    setError(null);
    if (!file || !structure.data || !context) return;
    if (file.size > 5_000_000) return setError("The file is larger than 5 MB.");
    setReading(true);
    try {
      const [sheet, existing] = await Promise.all([readSheet(file), allEmployees()]);
      if (sheet.length < 2) throw new Error("The sheet has no rows under the header.");
      setPlan(planImport(sheet, { existing, structure: structure.data, isAdmin: c.isAdmin, canProvision: c.canProvision, canManagePayroll: c.canManagePayroll, myEmployeeId: context.employee.id }));
    } catch (x) {
      setError(msg(x, "Could not read the file. Use the template (.xlsx or .csv)."));
    } finally {
      setReading(false);
    }
  };
  const apply = async () => {
    if (!plan) return;
    const rows = plan.rows.filter((r) => r.kind === "create" || r.kind === "update");
    const out: ApplyResult[] = [];
    setProgress({ done: 0, total: rows.length });
    for (const r of rows) {
      out.push(await applyRow(r));
      setProgress({ done: out.length, total: rows.length });
    }
    setProgress(null);
    setResults(out);
  };
  const passwords = results?.filter((r) => r.password) ?? [];
  return (
    <>
      <PageTitle title="Import from Excel" back="/employees" />
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-page">
        <SectionCard>
          <p className="text-body-md">One row per employee. Rows with a new Employee ID create an account; existing IDs update the details. Nothing is saved until you confirm.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outlined" disabled={!structure.data} onClick={() => structure.data && download("employee-template.csv", templateCsv(structure.data))}>
              Download template
            </Button>
            <label className="inline-flex min-h-12 cursor-pointer items-center rounded-button bg-primary px-4 font-semibold text-white">
              {reading ? "Reading…" : "Choose file"}
              <input type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" aria-label="Spreadsheet" disabled={reading || !!progress} onChange={(e) => read(e.target.files?.[0] ?? null)} />
            </label>
          </div>
        </SectionCard>
        {error && <Banner>{error}</Banner>}
        {plan && !results && (
          <>
            {plan.missingColumns.length > 0 && <Banner>Missing columns: {plan.missingColumns.join(", ")}.</Banner>}
            {plan.unknownHeaders.length > 0 && <Banner tone="warning">Ignored columns: {plan.unknownHeaders.join(", ")}.</Banner>}
            <p className="text-body-md" aria-live="polite">
              {countKind(plan, "create")} new · {countKind(plan, "update")} updates · {countKind(plan, "unchanged")} unchanged · {countKind(plan, "error")} to fix
            </p>
            <ul className="flex flex-col gap-2">
              {plan.rows.map((r) => {
                const k = KIND_CHIP[r.kind];
                return (
                  <li key={r.rowNumber} className={cx("rounded-card border bg-surface p-card", r.kind === "error" ? "border-error" : "border-border")}>
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold">
                        Row {r.rowNumber} · {r.values.code || "—"} {r.values.name || r.existing?.name || ""}
                      </p>
                      <StatusChip label={k.label} tone={k.tone} />
                    </div>
                    {[...r.errors.map((t) => ["text-error", t]), ...r.changes.map((t) => ["", t]), ...r.notes.map((t) => ["text-text-secondary", t])].map(([cls, t], i) => (
                      <p key={i} className={cx("text-body-sm", cls)}>
                        {t}
                      </p>
                    ))}
                  </li>
                );
              })}
            </ul>
            {progress ? (
              <Banner tone="info">
                Saving {progress.done} of {progress.total}… keep this page open.
              </Banner>
            ) : (
              <Button disabled={plan.missingColumns.length > 0 || countKind(plan, "create") + countKind(plan, "update") === 0} onClick={apply}>
                Save {countKind(plan, "create") + countKind(plan, "update")} rows
              </Button>
            )}
          </>
        )}
        {results && (
          <>
            <Banner tone={results.every((r) => r.ok) ? "success" : "warning"}>
              {results.filter((r) => r.ok).length} saved, {results.filter((r) => !r.ok).length} failed.
            </Banner>
            {passwords.length > 0 && (
              <SectionCard>
                <p className="text-body-md">{passwords.length} new accounts have temporary passwords. Share each person&apos;s sign-in details privately before leaving this page.</p>
                <Button
                  className="mt-2"
                  onClick={() => {
                    const rows = passwords.map((p) => [p.code, p.password, employeeSignInUrl(window.location.origin, p.code)]);
                    download("temporary-passwords.csv", toCsv([["Employee ID", "Temporary password", "Sign-in link"], ...rows]));
                  }}
                >
                  Download passwords
                </Button>
              </SectionCard>
            )}
            <ul className="flex flex-col gap-1">
              {results.map((r) => (
                <li key={r.row} className="flex flex-col gap-1 py-1">
                  <p className={cx("text-body-md", !r.ok && "text-error")}>Row {r.row} · {r.code}: {r.message}</p>
                  {r.password && <SignInShare code={r.code} name={r.name} password={r.password} />}
                </li>
              ))}
            </ul>
            <Button variant="outlined" onClick={() => router.push("/employees")}>
              Done
            </Button>
          </>
        )}
      </div>
    </>
  );
}
