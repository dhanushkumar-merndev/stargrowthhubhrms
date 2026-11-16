"use client";

// salary_screen.dart, bank_details_request_screen.dart, payslips_screen.dart,
// payroll_uploads_screen.dart and documents_screen.dart.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ApiError, newOperationId, rpc } from "@/lib/api";
import { dayLabel, todayIn } from "@/lib/attendance";
import { type FileClass, sizeLabel, uploadFile } from "@/lib/files";
import {
  type BankForm,
  type DocumentRow,
  type EmployeeRow,
  type Paged,
  type PayslipSlot,
  type Salary,
  bankErrors,
  bankStatus,
  documentTitleError,
  maskAccount,
  money,
  monthLabel,
  monthStart,
  payslipStatus,
} from "@/lib/people";
import { stateOf } from "@/lib/requests";
import { useSession } from "@/lib/session";
import { useRpc } from "@/lib/use-rpc";
import { FilePicker, FileViewer } from "../files";
import { Banner, Button, EmptyState, ErrorState, KeyValue, LoadingState, PageTitle, SectionCard, Sheet, StatusChip, TextArea, TextField } from "../ui";

const msg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const PENDING = ["draft", "submitted", "under_review", "returned"];

/* ───────────────────────── Salary ───────────────────────── */

export function SalaryCard({ s, editable, onEdit }: { s: Salary; editable?: boolean; onEdit?: () => void }) {
  const p = s.profile;
  const bs = bankStatus(p?.bank_status);
  return (
    <>
      <SectionCard>
        <div className="flex items-start justify-between">
          <div>
            <p className="text-body-md text-text-secondary">Monthly salary</p>
            <p className="text-headline-sm font-semibold">{money(p?.monthly_salary, p?.currency)}</p>
            {p?.effective_from && <p className="text-body-sm text-text-secondary">From {dayLabel(p.effective_from)}</p>}
          </div>
          {editable && onEdit && (
            <Button variant="text" onClick={onEdit}>
              {p?.monthly_salary != null ? "Change" : "Set salary"}
            </Button>
          )}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3">
          <div>
            <p className="text-body-sm text-text-secondary">Paid so far</p>
            <p className="font-semibold">{money(s.lifetime_paid)}</p>
          </div>
          <div>
            <p className="text-body-sm text-text-secondary">Months paid</p>
            <p className="font-semibold">{s.paid_months}</p>
          </div>
        </div>
      </SectionCard>
      <SectionCard>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-title-sm font-semibold">Bank account</h2>
          <StatusChip label={bs.label} tone={bs.tone} />
        </div>
        <KeyValue k="Bank" v={p?.bank_name ?? "—"} />
        <KeyValue k="Account holder" v={p?.account_holder ?? "—"} />
        <KeyValue k="Account" v={maskAccount(p?.account_last4)} />
        <KeyValue k="IFSC" v={p?.ifsc ?? "—"} />
      </SectionCard>
      {s.recent.length > 0 && (
        <SectionCard>
          <h2 className="mb-2 text-title-sm font-semibold">Recent pay</h2>
          {s.recent.map((r) => (
            <KeyValue key={r.salary_month} k={monthLabel(r.salary_month)} v={money(r.net_amount)} />
          ))}
        </SectionCard>
      )}
    </>
  );
}

export function MySalary() {
  const q = useRpc<Salary>("get_my_salary", {});
  if (q.error) return <><PageTitle title="Salary" back="/explore" /><ErrorState message={msg(q.error, "Could not load your salary.")} onRetry={() => q.mutate()} /></>;
  if (!q.data) return <><PageTitle title="Salary" back="/explore" /><LoadingState /></>;
  const req = q.data.bank_request && PENDING.includes(q.data.bank_request.state) ? q.data.bank_request : null;
  return (
    <>
      <PageTitle title="Salary" back="/explore" />
      <div className="mx-auto flex max-w-xl md:max-w-3xl lg:max-w-5xl flex-col gap-4 p-page">
        {req && (
          <Banner tone="info">
            Bank change request: {stateOf(req.state).label.toLowerCase()}.{" "}
            <Link href={`/requests/${req.id}`} className="font-semibold underline">
              View
            </Link>
          </Banner>
        )}
        <SalaryCard s={q.data} />
        <Link href="/salary/bank-details" className="inline-flex min-h-12 items-center justify-center rounded-button border border-border font-semibold text-primary">
          {req ? "Edit bank change request" : q.data.profile?.account_last4 ? "Change bank account" : "Add bank account"}
        </Link>
        <Link href="/payslips" className="text-center font-semibold text-primary">
          View payslips
        </Link>
      </div>
    </>
  );
}

const EMPTY_BANK: BankForm = { bank_name: "", account_holder: "", account_number: "", confirm_number: "", ifsc: "", reason: "" };

export function BankDetails({ onDone }: { onDone?: () => void }) {
  const q = useRpc<Salary>("get_my_salary", {});
  const [f, setF] = useState<BankForm>(EMPTY_BANK);
  const [file, setFile] = useState<File | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof BankForm, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const op = useRef<string | null>(null);
  if (q.error) return <><PageTitle title="Bank account" back="/salary" /><ErrorState message={msg(q.error, "Could not load your bank details.")} onRetry={() => q.mutate()} /></>;
  if (!q.data) return <><PageTitle title="Bank account" back="/salary" /><LoadingState /></>;
  const change = !!q.data.profile?.account_last4;
  const req = q.data.bank_request && PENDING.includes(q.data.bank_request.state) ? q.data.bank_request : null;
  const set = (k: keyof BankForm) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs = bankErrors(f, change);
    setErrors(errs);
    setError(null);
    if (Object.keys(errs).length || fileProblem) return;
    if (!file) return setFileProblem("Attach a cancelled cheque or the bank passbook page.");
    setBusy(true);
    op.current ??= newOperationId();
    try {
      const proof = await uploadFile(file, { cls: "correction_attachment" });
      await rpc("save_bank_details_request", {
        p_request_id: req?.id ?? null,
        p_bank_name: f.bank_name.trim(),
        p_account_holder: f.account_holder.trim(),
        p_account_number: f.account_number.replace(/\s/g, ""),
        p_ifsc: f.ifsc.replace(/\s/g, "").toUpperCase(),
        p_reason: f.reason.trim() || null,
        p_attachment_file_version_id: proof,
        p_expected_version: req?.version ?? null,
        p_operation_key: op.current,
      });
      op.current = null;
      setDone("Sent to HR. Your salary keeps going to the current account until HR approves the change.");
      onDone?.();
      await q.mutate();
    } catch (x) {
      if (!(x instanceof ApiError && x.isNetwork)) op.current = null;
      if (x instanceof ApiError) {
        setErrors(x.fieldErrors as Partial<Record<keyof BankForm, string>>);
        if (x.fieldErrors.attachment) setFileProblem(x.fieldErrors.attachment);
      }
      setError(msg(x, "Could not send the request."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageTitle title="Bank account" back="/salary" />
      <form noValidate onSubmit={save} className="mx-auto flex max-w-xl md:max-w-2xl flex-col gap-4 p-page">
        {done ? (
          <>
            <Banner tone="success">{done}</Banner>
            <Link href="/salary" className="text-center font-semibold text-primary">
              Back to salary
            </Link>
          </>
        ) : (
          <>
            {error && <Banner>{error}</Banner>}
            {change && <Banner tone="info">Current account {maskAccount(q.data.profile?.account_last4)}. HR checks the proof before switching.</Banner>}
            <TextField label="Bank name" value={f.bank_name} onChange={set("bank_name")} error={errors.bank_name} autoComplete="off" />
            <TextField label="Account holder name" value={f.account_holder} onChange={set("account_holder")} error={errors.account_holder} autoComplete="off" />
            <TextField label="Account number" inputMode="numeric" value={f.account_number} onChange={set("account_number")} error={errors.account_number} autoComplete="off" />
            <TextField label="Confirm account number" inputMode="numeric" value={f.confirm_number} onChange={set("confirm_number")} error={errors.confirm_number} autoComplete="off" onPaste={(e) => e.preventDefault()} />
            <TextField label="IFSC" value={f.ifsc} onChange={(e) => setF({ ...f, ifsc: e.target.value.toUpperCase() })} error={errors.ifsc} autoComplete="off" maxLength={11} />
            {change && <TextArea label="Why is it changing?" value={f.reason} onChange={(v) => setF({ ...f, reason: v })} error={errors.reason} maxLength={500} />}
            <FilePicker
              label="Proof (cancelled cheque or passbook)"
              cls="correction_attachment"
              file={file}
              error={fileProblem}
              hint="PDF, JPG or PNG up to 5 MB."
              onChange={(x, p) => {
                setFile(x);
                setFileProblem(p);
              }}
            />
            <Button type="submit" busy={busy}>
              Send to HR
            </Button>
          </>
        )}
      </form>
    </>
  );
}

/* ───────────────────────── Payslips ───────────────────────── */

export function Payslips() {
  const q = useRpc<{ slots: PayslipSlot[] }>("list_my_payslips", {});
  const [open, setOpen] = useState<PayslipSlot | null>(null);
  return (
    <>
      <PageTitle title="Payslips" back="/explore" />
      <div className="mx-auto flex max-w-xl md:max-w-3xl lg:max-w-5xl flex-col gap-2 p-page">
        {q.error ? (
          <ErrorState message={msg(q.error, "Could not load payslips.")} onRetry={() => q.mutate()} />
        ) : !q.data ? (
          <LoadingState />
        ) : q.data.slots.length === 0 ? (
          <EmptyState art="payslip" title="No payslips yet" />
        ) : (
          <ul className="flex flex-col gap-2">
            {q.data.slots.map((s) => {
              const st = payslipStatus(s.status);
              const can = s.status === "available" && !!s.file_version_id;
              return (
                <li key={s.salary_month}>
                  <button
                    type="button"
                    disabled={!can}
                    onClick={() => setOpen(s)}
                    className="flex w-full items-center gap-3 rounded-card border border-border bg-surface p-card text-left enabled:hover:bg-background disabled:cursor-default"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">{monthLabel(s.salary_month)}</p>
                      <p className="text-body-sm text-text-secondary">
                        {s.published_at ? `Published ${dayLabel(s.published_at.slice(0, 10))}` : s.status === "archived" ? "Archived — ask HR for a copy" : "Not published yet"}
                        {s.replaced ? " · updated" : ""}
                      </p>
                    </div>
                    <StatusChip label={st.label} tone={st.tone} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {open?.file_version_id && <FileViewer versionId={open.file_version_id} title={`Payslip · ${monthLabel(open.salary_month)}`} onClose={() => setOpen(null)} />}
    </>
  );
}

/* ───────────────────────── Payroll uploads ───────────────────────── */

interface UploadRow {
  payslip_id: string;
  salary_month: string;
  version: number;
  employee: { id: string; code: string; name: string };
  published_at: string | null;
  current_file_version_id: string | null;
  versions: { id: string; version_no: number; state: string; size_bytes: number | null; filename: string | null; created_at: string; published_at: string | null; validation_error: string | null; replace_reason: string | null }[];
}

/** Picks one employee by search (used by payroll uploads). */
export function EmployeePicker({ value, onChange }: { value: EmployeeRow | null; onChange: (e: EmployeeRow | null) => void }) {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const list = useRpc<Paged<EmployeeRow>>(value || !q ? null : "list_employees", { p_search: q, p_status: "active", p_team_id: null, p_department_id: null, p_limit: 8, p_offset: 0 });
  if (value)
    return (
      <div>
        <span className="mb-1.5 block text-body-md font-medium text-text-secondary">Employee</span>
        <div className="flex items-center justify-between rounded-input border border-border bg-surface px-4 py-3">
          <span>
            <span className="font-semibold">{value.name}</span> <span className="text-text-secondary">· {value.code}</span>
          </span>
          <Button variant="text" type="button" onClick={() => onChange(null)}>
            Change
          </Button>
        </div>
      </div>
    );
  return (
    <div>
      <TextField label="Employee" type="search" placeholder="Search name or ID" value={search} onChange={(e) => setSearch(e.target.value)} />
      {q && (
        <ul className="mt-1 overflow-hidden rounded-input border border-border bg-surface" aria-label="Matching employees">
          {!list.data ? (
            <li className="p-3 text-body-md text-text-secondary">Searching…</li>
          ) : list.data.rows.length === 0 ? (
            <li className="p-3 text-body-md text-text-secondary">Nobody matches “{q}”</li>
          ) : (
            list.data.rows.map((r) => (
              <li key={r.id}>
                <button type="button" className="w-full p-3 text-left hover:bg-background" onClick={() => onChange(r)}>
                  <span className="font-semibold">{r.name}</span> <span className="text-text-secondary">· {r.code}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

export function PayrollUploads({ now = new Date() }: { now?: Date }) {
  const { context } = useSession();
  const today = todayIn(context?.org.timezone ?? "Asia/Kolkata", now);
  const [emp, setEmp] = useState<EmployeeRow | null>(null);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [uploaded, setUploaded] = useState<{ versionId: string; slip: UploadRow } | null>(null);
  const [preview, setPreview] = useState<{ id: string; title: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const recent = useRpc<Paged<UploadRow>>("list_payslip_uploads", { p_employee_id: null, p_salary_month: null, p_limit: 20, p_offset: 0 });
  const reset = () => {
    setFile(null);
    setProblem(null);
    setUploaded(null);
    setAmount("");
    setReason("");
  };
  const amountError = amount.trim() && !/^\d{1,9}(\.\d{1,2})?$/.test(amount.replace(/,/g, "").trim()) ? "Enter an amount like 45000 or 45000.50." : null;
  const upload = async () => {
    setError(null);
    setNotice(null);
    if (!emp) return setError("Choose an employee.");
    if (!/^\d{4}-\d{2}$/.test(month)) return setError("Choose the salary month.");
    if (!file) return setProblem("Choose the payslip PDF.");
    if (problem) return;
    setBusy(true);
    try {
      const salaryMonth = monthStart(`${month}-01`);
      const versionId = await uploadFile(file, { cls: "payslip", ownerEmployeeId: emp.id, salaryMonth });
      const rows = await rpc<Paged<UploadRow>>("list_payslip_uploads", { p_employee_id: emp.id, p_salary_month: salaryMonth, p_limit: 1, p_offset: 0 });
      const slip = rows.rows[0];
      if (!slip) throw new Error("The upload was saved but its payslip was not found. Reload and try again.");
      setUploaded({ versionId, slip });
    } catch (x) {
      setError(msg(x, "Could not upload the payslip."));
    } finally {
      setBusy(false);
    }
  };
  const publish = async () => {
    if (!uploaded || !emp) return;
    const replacing = !!uploaded.slip.current_file_version_id;
    if (replacing && reason.trim().length < 3) return setError("Give a reason for replacing the published payslip.");
    if (amountError) return;
    setBusy(true);
    setError(null);
    try {
      await rpc("publish_payslip", { p_file_version_id: uploaded.versionId, p_reason: replacing ? reason.trim() : null, p_expected_version: uploaded.slip.version });
      const paid = amount.trim() ? Number(amount.replace(/,/g, "").trim()) : null;
      if (paid != null) await rpc("set_payslip_amount", { p_employee_id: emp.id, p_salary_month: uploaded.slip.salary_month, p_net_amount: paid });
      setNotice(`${monthLabel(uploaded.slip.salary_month)} payslip published for ${emp.name}${paid != null ? " with the amount paid" : ""}.`);
      reset();
      await recent.mutate();
    } catch (x) {
      setError(x instanceof ApiError && x.code === "STALE_VERSION" ? "This payslip changed. Upload it again." : msg(x, "Could not publish."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageTitle title="Payslip uploads" back="/workspace" />
      <div className="mx-auto flex max-w-xl md:max-w-3xl lg:max-w-5xl flex-col gap-4 p-page">
        {notice && <Banner tone="success">{notice}</Banner>}
        <SectionCard>
          <div className="flex flex-col gap-3">
            {error && <Banner>{error}</Banner>}
            <EmployeePicker
              value={emp}
              onChange={(e) => {
                setEmp(e);
                setUploaded(null);
              }}
            />
            <TextField
              label="Salary month"
              type="month"
              value={month}
              max={today.slice(0, 7)}
              onChange={(e) => {
                setMonth(e.target.value);
                setUploaded(null);
              }}
            />
            {!uploaded ? (
              <>
                <FilePicker
                  label="Payslip"
                  cls="payslip"
                  file={file}
                  error={problem}
                  hint="PDF up to 5 MB. It stays private until you publish it."
                  onChange={(x, p) => {
                    setFile(x);
                    setProblem(p);
                  }}
                />
                <Button busy={busy} onClick={upload}>
                  Upload and check
                </Button>
              </>
            ) : (
              <>
                <Banner tone="info">
                  Uploaded and checked. Open the preview, then publish. {emp?.name} is notified when you publish.
                </Banner>
                <Button variant="outlined" onClick={() => setPreview({ id: uploaded.versionId, title: `Preview · ${monthLabel(uploaded.slip.salary_month)}` })}>
                  Preview
                </Button>
                <TextField label="Amount paid (optional)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} error={amountError} />
                {uploaded.slip.current_file_version_id && (
                  <TextArea label="Reason for replacing the published payslip" value={reason} onChange={setReason} maxLength={500} />
                )}
                <div className="flex gap-2">
                  <Button busy={busy} className="flex-1" onClick={publish}>
                    {uploaded.slip.current_file_version_id ? "Publish replacement" : "Publish"}
                  </Button>
                  <Button variant="outlined" onClick={reset}>
                    Discard
                  </Button>
                </div>
              </>
            )}
          </div>
        </SectionCard>

        <h2 className="text-title-sm font-semibold">Recent uploads</h2>
        {recent.error ? (
          <ErrorState message={msg(recent.error, "Could not load uploads.")} onRetry={() => recent.mutate()} />
        ) : !recent.data ? (
          <LoadingState />
        ) : recent.data.rows.length === 0 ? (
          <EmptyState art="payslip" title="No payslips uploaded yet" />
        ) : (
          <ul className="flex flex-col gap-2">
            {recent.data.rows.map((r) => {
              const latest = r.versions[0];
              return (
                <li key={r.payslip_id} className="flex items-center gap-3 rounded-card border border-border bg-surface p-card">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">
                      {r.employee.name} <span className="font-normal text-text-secondary">· {r.employee.code}</span>
                    </p>
                    <p className="text-body-sm text-text-secondary">
                      {monthLabel(r.salary_month)} · {r.published_at ? "Published" : "Not published"}
                      {latest?.state === "rejected" && latest.validation_error ? ` · ${latest.validation_error}` : ""}
                    </p>
                  </div>
                  {r.current_file_version_id && (
                    <Button variant="text" onClick={() => setPreview({ id: r.current_file_version_id!, title: `${r.employee.name} · ${monthLabel(r.salary_month)}` })}>
                      Open
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {preview && <FileViewer versionId={preview.id} title={preview.title} onClose={() => setPreview(null)} />}
    </>
  );
}

/* ───────────────────────── Documents ───────────────────────── */

export interface DocItem extends Partial<DocumentRow> {
  record_id: string;
  title: string | null;
  file_version_id: string | null;
  can_edit?: boolean;
}

export function DocumentList({ items, emptyTitle, onOpen, onRename, onRemove }: { items: DocItem[]; emptyTitle: string; onOpen: (d: DocItem) => void; onRename?: (d: DocItem) => void; onRemove?: (d: DocItem) => void }) {
  if (items.length === 0) return <EmptyState art="documents" title={emptyTitle} />;
  return (
    <ul className="flex flex-col gap-2">
      {items.map((d) => {
        const editable = d.can_edit !== false;
        return (
          <li key={d.record_id} className="rounded-card border border-border bg-surface p-card">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{d.title || "Untitled"}</p>
                <p className="text-body-sm text-text-secondary">
                  {[d.document_date ? dayLabel(d.document_date) : null, d.size_bytes ? sizeLabel(d.size_bytes) : null, d.state && d.state !== "published" ? d.state.replace(/_/g, " ") : null].filter(Boolean).join(" · ")}
                </p>
              </div>
              {d.file_version_id && (
                <Button variant="text" onClick={() => onOpen(d)}>
                  Open
                </Button>
              )}
            </div>
            {editable && (onRename || onRemove) && (
              <div className="mt-1 flex gap-4 border-t border-border pt-1">
                {onRename && (
                  <Button variant="text" onClick={() => onRename(d)}>
                    Rename
                  </Button>
                )}
                {onRemove && (
                  <Button variant="text" className="text-error" onClick={() => onRemove(d)}>
                    Remove
                  </Button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Upload + publish a document (employee document or company policy). */
export function UploadDocumentSheet({ cls, ownerEmployeeId, askDate, titleMax = 50, today, onClose, onSaved }: { cls: FileClass; ownerEmployeeId?: string | null; askDate: boolean; titleMax?: number; today: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(today);
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [titleErr, setTitleErr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const te = documentTitleError(title, titleMax);
    setTitleErr(te);
    if (!file) setProblem("Choose a PDF.");
    if (te || !file || problem) return;
    if (askDate && (!date || date > today)) return setError("Choose a date that is not in the future.");
    setBusy(true);
    setError(null);
    try {
      const id = await uploadFile(file, { cls, ownerEmployeeId, title: title.trim(), documentDate: askDate ? date : cls === "employee_document" ? today : null });
      await rpc("publish_document", { p_file_version_id: id });
      await onSaved();
    } catch (x) {
      setError(msg(x, "Could not upload the document."));
      setBusy(false);
    }
  };
  return (
    <Sheet title={cls === "company_policy" ? "Add company policy" : "Add document"} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {error && <Banner>{error}</Banner>}
        <TextField label="Name" value={title} maxLength={titleMax} onChange={(e) => setTitle(e.target.value)} error={titleErr} hint={`Up to ${titleMax} characters.`} />
        {askDate && <TextField label="Document date" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />}
        <FilePicker
          label="File"
          cls={cls}
          file={file}
          error={problem}
          hint="PDF up to 5 MB."
          onChange={(x, p) => {
            setFile(x);
            setProblem(p);
          }}
        />
        <Button busy={busy} onClick={save}>
          Upload
        </Button>
      </div>
    </Sheet>
  );
}

export function RenameSheet({ doc, titleMax = 50, onClose, onSaved }: { doc: DocItem; titleMax?: number; onClose: () => void; onSaved: () => Promise<void> }) {
  const [title, setTitle] = useState(doc.title ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const te = documentTitleError(title, titleMax);
    if (te) return setError(te);
    setBusy(true);
    try {
      await rpc("rename_employee_document", { p_record_id: doc.record_id, p_title: title.trim() });
      await onSaved();
    } catch (x) {
      setError(msg(x, "Could not rename."));
      setBusy(false);
    }
  };
  return (
    <Sheet title="Rename document" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <TextField label="Name" value={title} maxLength={titleMax} onChange={(e) => setTitle(e.target.value)} error={error} />
        <Button busy={busy} onClick={save}>
          Save
        </Button>
      </div>
    </Sheet>
  );
}

export function RemoveSheet({ doc, onClose, onSaved }: { doc: DocItem; onClose: () => void; onSaved: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Sheet title="Remove document?" onClose={onClose}>
      <div className="flex flex-col gap-3">
        {error && <Banner>{error}</Banner>}
        <p>“{doc.title || "Untitled"}” will be removed. HR keeps a copy in the audit archive.</p>
        <Button
          busy={busy}
          variant="danger"
          onClick={async () => {
            setBusy(true);
            try {
              await rpc("remove_employee_document", { p_record_id: doc.record_id });
              await onSaved();
            } catch (x) {
              setError(msg(x, "Could not remove."));
              setBusy(false);
            }
          }}
        >
          Remove
        </Button>
      </div>
    </Sheet>
  );
}

interface MyDocs {
  can_publish_policy: boolean;
  can_upload: boolean;
  company: DocItem[];
  mine: DocItem[];
  count: number;
  limit: number;
  title_max: number;
}

export function Documents({ now = new Date(), policiesOnly = false }: { now?: Date; policiesOnly?: boolean }) {
  const { context } = useSession();
  const today = todayIn(context?.org.timezone ?? "Asia/Kolkata", now);
  const q = useRpc<MyDocs>("list_my_documents", {});
  const [open, setOpen] = useState<DocItem | null>(null);
  const [adding, setAdding] = useState<FileClass | null>(null);
  const [renaming, setRenaming] = useState<DocItem | null>(null);
  const [removing, setRemoving] = useState<DocItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const title = policiesOnly ? "Company policies" : "Documents";
  if (q.error) return <><PageTitle title={title} back="/explore" /><ErrorState message={msg(q.error, "Could not load documents.")} onRetry={() => q.mutate()} /></>;
  if (!q.data) return <><PageTitle title={title} back="/explore" /><LoadingState /></>;
  const d = q.data;
  const done = (text: string) => async () => {
    setAdding(null);
    setRenaming(null);
    setRemoving(null);
    setNotice(text);
    await q.mutate();
  };
  const full = d.count >= d.limit;
  return (
    <>
      <PageTitle title={title} back="/explore" />
      <div className="mx-auto flex max-w-xl md:max-w-3xl lg:max-w-5xl flex-col gap-4 p-page">
        {notice && <Banner tone="success">{notice}</Banner>}
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 className="text-title-sm font-semibold">Company policies</h2>
            {d.can_publish_policy && (
              <Button variant="text" onClick={() => setAdding("company_policy")}>
                Add policy
              </Button>
            )}
          </div>
          <DocumentList items={d.company} emptyTitle="No policies published yet" onOpen={setOpen} />
        </section>
        {!policiesOnly && (
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h2 className="text-title-sm font-semibold">My documents</h2>
              {d.can_upload && (
                <Button variant="text" disabled={full} onClick={() => setAdding("employee_document")}>
                  Add
                </Button>
              )}
            </div>
            <p className="text-body-sm text-text-secondary">
              {d.count} of {d.limit} used{full ? " — remove one to add another" : ""}.
            </p>
            <DocumentList items={d.mine} emptyTitle="You have not added any documents" onOpen={setOpen} onRename={setRenaming} onRemove={setRemoving} />
          </section>
        )}
      </div>
      {open?.file_version_id && <FileViewer versionId={open.file_version_id} title={open.title || "Document"} onClose={() => setOpen(null)} />}
      {adding && (
        <UploadDocumentSheet
          cls={adding}
          ownerEmployeeId={adding === "employee_document" ? context?.employee.id : null}
          askDate={adding === "company_policy"}
          titleMax={d.title_max}
          today={today}
          onClose={() => setAdding(null)}
          onSaved={done(adding === "company_policy" ? "Policy published." : "Document uploaded.")}
        />
      )}
      {renaming && <RenameSheet doc={renaming} titleMax={d.title_max} onClose={() => setRenaming(null)} onSaved={done("Renamed.")} />}
      {removing && <RemoveSheet doc={removing} onClose={() => setRemoving(null)} onSaved={done("Removed.")} />}
    </>
  );
}
