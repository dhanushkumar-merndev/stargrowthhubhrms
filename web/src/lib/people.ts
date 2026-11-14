// People, salary, payslips and documents helpers (profile_screen.dart,
// salary_widgets.dart, payslips_screen.dart, documents_screen.dart,
// employee_import.dart). Pure functions: every rule is enforced again by SQL.

import type { Tone } from "@/components/ui";

export interface Ref {
  id: string;
  name: string;
}

export interface PrivateDetails {
  personal_email: string | null;
  personal_phone: string | null;
  address: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  date_of_birth: string | null;
  version: number;
}

export interface Profile {
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
  office: Ref | null;
  manager: Ref | null;
  shift: { id: string; name: string; start_local: string; end_local: string; weekly_mask: number } | null;
  private: PrivateDetails | null;
  profile_request: { id: string; state: string; version: number } | null;
  version: number;
}

export interface DirectoryRow {
  id: string;
  code: string;
  name: string;
  designation: string | null;
  position_label: string | null;
  role: string;
  business_email: string | null;
  business_phone: string | null;
  avatar_file_version_id: string | null;
  department: Ref | null;
  team: Ref | null;
}

export interface EmployeeRow extends DirectoryRow {
  status: string;
  roles: string[];
  join_date: string | null;
  end_date: string | null;
  setup_pending: boolean;
  version: number;
}

export interface Paged<T> {
  rows: T[];
  total?: number;
  limit: number;
  offset: number;
  active_cap?: number;
  active_count?: number;
}

export interface OrgStructure {
  departments: (Ref & { active: boolean })[];
  teams: (Ref & { active: boolean; department_id?: string | null })[];
  offices: (Ref & { active: boolean })[];
  shifts: (Ref & { active: boolean })[];
}

export interface SalaryProfile {
  monthly_salary: number | null;
  currency: string;
  effective_from: string | null;
  bank_name: string | null;
  account_holder: string | null;
  account_last4: string | null;
  ifsc: string | null;
  bank_status: string;
  bank_approved_at: string | null;
  updated_at: string | null;
  version: number;
}

export interface Salary {
  profile: SalaryProfile | null;
  bank_request: { id: string; state: string; version: number } | null;
  lifetime_paid: number;
  paid_months: number;
  recent: { salary_month: string; net_amount: number | null; status?: string }[];
  revisions?: { created_at: string; created_by: string; monthly_salary: number; effective_from: string; reason: string | null; currency: string }[];
  can_edit?: boolean;
}

export interface PayslipSlot {
  salary_month: string;
  status: "missing" | "available" | "archived" | string;
  file_version_id: string | null;
  published_at: string | null;
  replaced: boolean;
  revision_no: number | null;
}

export interface DocumentRow {
  record_id: string;
  title: string | null;
  class: string;
  state: string;
  file_version_id: string | null;
  mime: string | null;
  size_bytes: number | null;
  document_date: string | null;
  created_at: string;
  published_at: string | null;
}

/* ───────────── formatting ───────────── */

const INR = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2, minimumFractionDigits: 0 });

/** "₹45,000" (Indian grouping), "—" when unknown. */
export function money(n: number | string | null | undefined, currency = "INR"): string {
  const v = typeof n === "string" ? Number(n) : n;
  if (v == null || !Number.isFinite(v)) return "—";
  if (currency !== "INR") return `${currency} ${v.toLocaleString("en-IN")}`;
  return INR.format(v);
}

/** "November 2026" from "2026-11-01". */
export function monthLabel(ymd: string | null | undefined): string {
  if (!ymd || !/^\d{4}-\d{2}/.test(ymd)) return "—";
  const [y, m] = ymd.split("-").map(Number);
  if (m < 1 || m > 12) return "—";
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/** First day of the month, "2026-11-01". */
export function monthStart(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return ((parts[0][0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export const PAYSLIP_STATUS: Record<string, { label: string; tone: Tone }> = {
  available: { label: "Available", tone: "success" },
  missing: { label: "Not uploaded yet", tone: "neutral" },
  archived: { label: "Archived", tone: "neutral" },
};
export const payslipStatus = (s: string) => PAYSLIP_STATUS[s] ?? { label: s.replace(/_/g, " "), tone: "neutral" as Tone };

export const BANK_STATUS: Record<string, { label: string; tone: Tone }> = {
  not_set: { label: "Not set up", tone: "warning" },
  pending: { label: "Waiting for approval", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  verified: { label: "Approved", tone: "success" },
  rejected: { label: "Not approved", tone: "error" },
};
export const bankStatus = (s: string | null | undefined) => BANK_STATUS[s ?? "not_set"] ?? { label: (s ?? "").replace(/_/g, " "), tone: "neutral" as Tone };

export const EMPLOYEE_STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "success" },
  inactive: { label: "Inactive", tone: "neutral" },
  suspended: { label: "Suspended", tone: "warning" },
  exited: { label: "Exited", tone: "neutral" },
  terminated: { label: "Exited", tone: "neutral" },
};
export const employeeStatus = (s: string) => EMPLOYEE_STATUS[s] ?? { label: s.replace(/_/g, " "), tone: "neutral" as Tone };

/* ───────────── private details (profile change request) ───────────── */

export const PRIVATE_FIELDS = [
  { key: "personal_email", label: "Personal email", type: "email" },
  { key: "personal_phone", label: "Personal phone", type: "tel" },
  { key: "address", label: "Address", type: "text" },
  { key: "emergency_contact_name", label: "Emergency contact name", type: "text" },
  { key: "emergency_contact_phone", label: "Emergency contact phone", type: "tel" },
  { key: "date_of_birth", label: "Date of birth", type: "date" },
] as const;
export type PrivateKey = (typeof PRIVATE_FIELDS)[number]["key"];

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^\+?[0-9][0-9 -]{5,18}[0-9]$/;

export function privateErrors(v: Record<PrivateKey, string>, today: string): Partial<Record<PrivateKey, string>> {
  const e: Partial<Record<PrivateKey, string>> = {};
  const t = (k: PrivateKey) => (v[k] ?? "").trim();
  if (t("personal_email") && !EMAIL.test(t("personal_email"))) e.personal_email = "Enter a valid email address.";
  for (const k of ["personal_phone", "emergency_contact_phone"] as const) {
    if (t(k) && !PHONE.test(t(k))) e[k] = "Enter a valid phone number.";
  }
  if (t("address").length > 500) e.address = "Keep it under 500 characters.";
  if (t("emergency_contact_name").length > 120) e.emergency_contact_name = "Keep it under 120 characters.";
  const dob = t("date_of_birth");
  if (dob) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(dob))) e.date_of_birth = "Enter a valid date.";
    else if (dob >= today) e.date_of_birth = "The date of birth must be in the past.";
    else if (Number(today.slice(0, 4)) - Number(dob.slice(0, 4)) > 100) e.date_of_birth = "Check the year.";
  }
  return e;
}

/** Only changed fields; "" becomes null (clears the value). */
export function privatePatch(before: PrivateDetails | null, v: Record<PrivateKey, string>): Partial<Record<PrivateKey, string | null>> {
  const out: Partial<Record<PrivateKey, string | null>> = {};
  for (const { key } of PRIVATE_FIELDS) {
    const next = (v[key] ?? "").trim();
    const prev = (before?.[key] ?? "").toString().trim();
    if (next !== prev) out[key] = next === "" ? null : next;
  }
  return out;
}

/* ───────────── bank details ───────────── */

export interface BankForm {
  bank_name: string;
  account_holder: string;
  account_number: string;
  confirm_number: string;
  ifsc: string;
  reason: string;
}

export const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export function bankErrors(f: BankForm, change: boolean): Partial<Record<keyof BankForm, string>> {
  const e: Partial<Record<keyof BankForm, string>> = {};
  if (f.bank_name.trim().length < 2) e.bank_name = "Enter the bank name.";
  if (f.account_holder.trim().length < 2) e.account_holder = "Enter the name on the account.";
  const n = f.account_number.replace(/\s/g, "");
  if (!/^\d{6,18}$/.test(n)) e.account_number = "Account numbers have 6 to 18 digits.";
  else if (n !== f.confirm_number.replace(/\s/g, "")) e.confirm_number = "The account numbers do not match.";
  if (!IFSC.test(f.ifsc.replace(/\s/g, "").toUpperCase())) e.ifsc = "IFSC is 11 characters, like HDFC0001234.";
  if (change && f.reason.trim().length < 3) e.reason = "Say why the account is changing.";
  return e;
}

/** "•••• 1234" */
export function maskAccount(last4: string | null | undefined): string {
  return last4 ? `•••• ${last4}` : "—";
}

/* ───────────── documents ───────────── */

export function documentTitleError(title: string, max = 50): string | null {
  const t = title.trim();
  if (!t) return "Give the document a name.";
  if (t.length > max) return `Keep it under ${max} characters.`;
  return null;
}

/* ───────────── employee import ───────────── */

export const IMPORT_COLUMNS: Record<string, string[]> = {
  code: ["employee id", "employee code", "emp id", "code", "id"],
  name: ["full name", "name", "employee name"],
  role: ["role"],
  designation: ["designation", "title", "job title"],
  department: ["department", "dept"],
  team: ["team"],
  office: ["office", "location"],
  shift: ["shift"],
  join_date: ["join date", "joining date", "date of joining", "doj", "joined"],
  email: ["work email", "email", "business email"],
  phone: ["work phone", "phone", "mobile", "business phone"],
  salary: ["monthly salary", "salary", "monthly salary inr", "net salary"],
  salary_from: ["salary effective from", "effective from", "salary from"],
  bank: ["bank name", "bank"],
  holder: ["account holder", "account holder name"],
  account: ["account number", "account no", "bank account", "account"],
  ifsc: ["ifsc", "ifsc code"],
};

export const TEMPLATE_HEADERS = [
  "Employee ID", "Full name", "Role", "Designation", "Department", "Team", "Office", "Shift",
  "Join date", "Work email", "Work phone", "Monthly salary", "Salary effective from",
];

export type ImportKind = "create" | "update" | "unchanged" | "error";

export interface ImportRow {
  rowNumber: number;
  values: Record<string, string>;
  kind: ImportKind;
  errors: string[];
  notes: string[];
  changes: string[];
  existing: EmployeeRow | null;
  role: string | null;
  departmentId?: string | null;
  teamId?: string | null;
  officeId?: string | null;
  shiftId?: string | null;
  patch: Record<string, unknown>;
  salary: Record<string, unknown>;
}

export interface ImportPlan {
  rows: ImportRow[];
  missingColumns: string[];
  unknownHeaders: string[];
}

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function importRole(raw: string | undefined): string | null {
  switch (norm(raw ?? "")) {
    case "":
    case "member":
    case "employee":
    case "staff":
      return "member";
    case "manager":
    case "team manager":
      return "manager";
    case "hr":
    case "human resources":
      return "hr";
    case "admin":
    case "administrator":
      return "admin";
    default:
      return null;
  }
}

/** 2026-10-01, 01/10/2026 (day first), 1-10-2026, or an Excel serial day. */
export function sheetDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const ok = (y: number, m: number, d: number) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 1900 && y <= 2200
      ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
      : null;
  };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/.exec(s);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return ok(+m[3], +m[2], +m[1]);
  if (/^\d{4,5}(\.\d+)?$/.test(s)) {
    const serial = Math.floor(Number(s));
    if (serial < 20000 || serial > 80000) return null;
    const dt = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
    return ok(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  return null;
}

const title = (role: string) => (role === "hr" ? "HR" : role.charAt(0).toUpperCase() + role.slice(1));
const salaryLabel = (k: string) => (k === "monthly_salary" ? "amount" : k === "effective_from" ? "effective date" : k.toUpperCase());

export interface PlanContext {
  existing: Map<string, EmployeeRow>;
  structure: OrgStructure;
  isAdmin: boolean;
  canProvision: boolean;
  canManagePayroll: boolean;
  myEmployeeId: string;
}

/** Builds the import plan from sheet rows. Nothing is written here. */
export function planImport(sheet: string[][], ctx: PlanContext): ImportPlan {
  let headerIndex = -1;
  const columns = new Map<string, number>();
  const unknown: string[] = [];
  for (let i = 0; i < sheet.length && i < 10 && headerIndex < 0; i++) {
    const found = new Map<string, number>();
    sheet[i].forEach((cell, c) => {
      const h = norm(cell);
      for (const [key, names] of Object.entries(IMPORT_COLUMNS)) if (!found.has(key) && names.includes(h)) found.set(key, c);
    });
    if (found.has("code")) {
      headerIndex = i;
      found.forEach((v, k) => columns.set(k, v));
      const used = new Set(found.values());
      sheet[i].forEach((cell, c) => cell.trim() && !used.has(c) && unknown.push(cell.trim()));
    }
  }
  if (headerIndex < 0) return { rows: [], missingColumns: ["Employee ID"], unknownHeaders: [] };

  const active = <T extends { active?: boolean }>(xs: T[]) => xs.filter((x) => x.active !== false);
  const departments = ctx.structure.departments ?? [];
  const teams = active(ctx.structure.teams ?? []);
  const offices = active(ctx.structure.offices ?? []);
  const shifts = active(ctx.structure.shifts ?? []);
  const lookup = (items: Ref[], raw: string) => items.find((i) => norm(i.name) === norm(raw))?.id ?? null;

  const rows: ImportRow[] = [];
  const seen = new Set<string>();
  for (let i = headerIndex + 1; i < sheet.length; i++) {
    const cells = sheet[i];
    const values: Record<string, string> = {};
    columns.forEach((c, k) => (values[k] = (cells[c] ?? "").trim()));
    if (Object.values(values).every((v) => !v)) continue;
    const r: ImportRow = { rowNumber: i + 1, values, kind: "unchanged", errors: [], notes: [], changes: [], existing: null, role: importRole(values.role), patch: {}, salary: {} };
    rows.push(r);
    const code = (values.code ?? "").toUpperCase().replace(/\s/g, "");
    values.code = code;
    if (!/^[A-Z0-9-]{3,32}$/.test(code)) r.errors.push('Employee ID must be 3–32 letters, digits or "-"');
    else if (seen.has(code)) r.errors.push(`Employee ID ${code} appears more than once in the file`);
    else seen.add(code);
    if (r.role == null) r.errors.push("Role must be Member, Manager, HR or Admin");

    const salaryText = (values.salary ?? "").replace(/[₹,\s]|INR|Rs\.?/gi, "");
    if (salaryText) {
      const amount = Number(salaryText);
      if (!Number.isFinite(amount) || amount < 0 || !/^\d+(\.\d+)?$/.test(salaryText)) r.errors.push(`Monthly salary "${values.salary}" is not a number`);
      else r.salary.monthly_salary = amount;
    }
    if (values.salary_from) {
      const d = sheetDate(values.salary_from);
      if (!d) r.errors.push(`Salary effective from "${values.salary_from}" is not a date`);
      else r.salary.effective_from = d;
    }
    if (["bank", "holder", "account", "ifsc"].some((k) => values[k])) r.notes.push("Bank columns skipped: employees submit bank details with proof in My salary");
    if (Object.keys(r.salary).length && !ctx.canManagePayroll) {
      r.notes.push("Salary columns skipped: you do not have payroll access");
      r.salary = {};
    }

    const current = ctx.existing.get(code) ?? null;
    r.existing = current;
    if (!current) {
      if (!ctx.canProvision) r.errors.push("You cannot create employees");
      if (!values.name) r.errors.push("Full name is required for a new employee");
      const join = sheetDate(values.join_date ?? "");
      if (!join) r.errors.push(values.join_date ? `Join date "${values.join_date}" is not a date (use 2026-10-01)` : "Join date is required for a new employee");
      else values.join_date = join;
      if ((r.role === "hr" || r.role === "admin") && !ctx.isAdmin) r.errors.push("Only an Admin can create HR or Admin accounts");
      const resolve = (key: string, label: string, items: Ref[], required: boolean) => {
        const raw = values[key] ?? "";
        if (!raw) {
          if (items.length === 1) return items[0].id;
          if (required) r.errors.push(`${label} is required (${items.map((x) => x.name).join(", ")})`);
          return null;
        }
        const id = lookup(items, raw);
        if (!id) r.errors.push(`Unknown ${label} "${raw}"${items.length ? ` — use one of: ${items.map((x) => x.name).join(", ")}` : ""}`);
        return id;
      };
      r.teamId = resolve("team", "team", teams, true);
      r.officeId = resolve("office", "office", offices, true);
      r.shiftId = resolve("shift", "shift", shifts, true);
      if (values.department) r.departmentId = resolve("department", "department", departments, false);
      if (!r.errors.length) {
        r.kind = "create";
        r.changes.push(`New ${r.role} account — a temporary password is created`);
        if (Object.keys(r.salary).length) r.changes.push("Salary details added");
      }
    } else {
      const diff = (key: string, field: string, label: string, now: unknown) => {
        const raw = values[key] ?? "";
        if (!raw) return;
        if (String(now ?? "").trim() !== raw) {
          r.patch[field] = raw;
          r.changes.push(`${label}: ${now == null || now === "" ? "—" : String(now)} → ${raw}`);
        }
      };
      diff("name", "full_name", "Name", current.name);
      diff("designation", "designation", "Designation", current.designation);
      diff("email", "business_email", "Work email", current.business_email);
      diff("phone", "business_phone", "Work phone", current.business_phone);
      if (values.department) {
        const id = lookup(departments, values.department);
        if (!id) r.errors.push(`Unknown department "${values.department}"`);
        else if (id !== current.department?.id) {
          r.patch.department_id = id;
          r.changes.push(`Department: ${current.department?.name ?? "—"} → ${values.department}`);
        }
      }
      const roles = current.roles ?? [];
      const currentRole = roles.includes("admin") ? "admin" : roles.includes("hr") ? "hr" : roles.includes("manager") ? "manager" : "member";
      if (values.role && r.role && r.role !== currentRole) r.notes.push(`Role not changed (${title(currentRole)} → ${title(r.role)}): change roles on the employee page`);
      if (values.team && norm(values.team) !== norm(current.team?.name ?? "")) r.notes.push("Team not changed: move people between teams on the employee page (it needs a start date)");
      if (values.office || values.shift) r.notes.push("Office and shift are changed on the employee page");
      if (Object.keys(r.salary).length) {
        if (current.id === ctx.myEmployeeId && !ctx.isAdmin) {
          r.notes.push("Your own salary is changed by an Admin — skipped");
          r.salary = {};
        } else r.changes.push(`Salary details updated (${Object.keys(r.salary).map(salaryLabel).join(", ")})`);
      }
      if (!r.errors.length) r.kind = Object.keys(r.patch).length || Object.keys(r.salary).length ? "update" : "unchanged";
    }
    if (r.errors.length) r.kind = "error";
  }
  const missing = [...(columns.has("name") ? [] : ["Full name"]), ...(columns.has("join_date") ? [] : ["Join date"])];
  return { rows, missingColumns: missing, unknownHeaders: unknown };
}

export const countKind = (p: ImportPlan, k: ImportKind) => p.rows.filter((r) => r.kind === k).length;

/** RFC 4180 CSV: quotes, doubled quotes, CR/LF, BOM. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** CSV with formula-injection protection (cells starting = + - @ are quoted with '). */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}

export function templateCsv(structure: OrgStructure): string {
  const names = (xs: Ref[] | undefined) => (xs ?? []).map((x) => x.name).join(" / ");
  return toCsv([
    TEMPLATE_HEADERS,
    ["EMP100", "Example Person", "Member", "Engineer", structure.departments?.[0]?.name ?? "", structure.teams?.[0]?.name ?? "", structure.offices?.[0]?.name ?? "", structure.shifts?.[0]?.name ?? "", "2026-10-01", "", "", "45000", "2026-10-01"],
    [],
    ["# Delete the example row. Teams: " + names(structure.teams)],
    ["# Offices: " + names(structure.offices) + " · Shifts: " + names(structure.shifts) + " · Departments: " + names(structure.departments)],
  ]);
}

/* ───────────── XLSX (first sheet) without a library ───────────── */

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Reads the entries of a zip (stored or deflated) via the central directory. */
export async function unzip(buf: ArrayBuffer, wanted: (name: string) => boolean): Promise<Map<string, string>> {
  const b = new Uint8Array(buf);
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, string>();
  const dec = new TextDecoder();
  let total = 0;
  for (let n = 0; n < count && p + 46 <= b.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("bad zip");
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (!wanted(name)) continue;
    total += usize;
    if (usize > 20_000_000 || total > 40_000_000) throw new Error("zip too large");
    const lnlen = dv.getUint16(local + 26, true);
    const lelen = dv.getUint16(local + 28, true);
    const start = local + 30 + lnlen + lelen;
    const raw = b.subarray(start, start + csize);
    const bytes = method === 0 ? raw : method === 8 ? await inflateRaw(raw) : null;
    if (bytes) out.set(name, dec.decode(bytes));
  }
  return out;
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** First worksheet as rows of text (shared strings, inline strings, numbers, dates as serials). */
export async function readXlsx(buf: ArrayBuffer): Promise<string[][]> {
  const files = await unzip(buf, (n) => n === "xl/sharedStrings.xml" || n === "xl/workbook.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const parse = (xml: string) => new DOMParser().parseFromString(xml, "application/xml");
  const shared: string[] = [];
  const ss = files.get("xl/sharedStrings.xml");
  if (ss) for (const si of Array.from(parse(ss).getElementsByTagName("si"))) shared.push(Array.from(si.getElementsByTagName("t")).map((t) => t.textContent ?? "").join(""));
  const sheetName = [...files.keys()].filter((k) => k.startsWith("xl/worksheets/")).sort((a, b) => Number(/\d+/.exec(a)?.[0]) - Number(/\d+/.exec(b)?.[0]))[0];
  if (!sheetName) return [];
  const rows: string[][] = [];
  for (const rowEl of Array.from(parse(files.get(sheetName)!).getElementsByTagName("row"))) {
    const r = Number(rowEl.getAttribute("r") ?? rows.length + 1) - 1;
    if (r > 10_000) break;
    const cells: string[] = [];
    for (const c of Array.from(rowEl.getElementsByTagName("c"))) {
      const idx = colIndex(c.getAttribute("r") ?? "A");
      if (idx > 200) continue;
      const t = c.getAttribute("t");
      const v = c.getElementsByTagName("v")[0]?.textContent ?? "";
      const text = t === "s" ? (shared[Number(v)] ?? "") : t === "inlineStr" ? Array.from(c.getElementsByTagName("t")).map((x) => x.textContent ?? "").join("") : t === "b" ? (v === "1" ? "TRUE" : "FALSE") : v;
      while (cells.length < idx) cells.push("");
      cells[idx] = text;
    }
    while (rows.length < r) rows.push([]);
    rows[r] = cells;
  }
  return rows;
}

/** CSV or XLSX by extension/content. */
export async function readSheet(file: File): Promise<string[][]> {
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 4));
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  if (isZip || /\.xlsx$/i.test(file.name)) return readXlsx(buf);
  return parseCsv(new TextDecoder().decode(buf));
}

/* ───────────── new employee / admin forms ───────────── */

export interface NewEmployeeForm {
  employee_code: string;
  full_name: string;
  join_date: string;
  team_id: string;
  office_id: string;
  shift_id: string;
  department_id: string;
  role: string;
  designation: string;
  business_email: string;
  business_phone: string;
  device_pin: string;
}

export const normalizeCode = (s: string) => s.toUpperCase().replace(/\s/g, "");

export function newEmployeeErrors(f: NewEmployeeForm, isAdmin: boolean): Partial<Record<keyof NewEmployeeForm, string>> {
  const e: Partial<Record<keyof NewEmployeeForm, string>> = {};
  if (!/^[A-Z0-9-]{3,32}$/.test(normalizeCode(f.employee_code))) e.employee_code = 'Use 3–32 letters, digits or "-".';
  if (f.full_name.trim().length < 2) e.full_name = "Enter the full name.";
  else if (f.full_name.trim().length > 200) e.full_name = "Keep the name under 200 characters.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.join_date) || Number.isNaN(Date.parse(f.join_date))) e.join_date = "Choose the join date.";
  if (!f.team_id) e.team_id = "Choose a team.";
  if (!f.office_id) e.office_id = "Choose an office.";
  if (!f.shift_id) e.shift_id = "Choose a shift.";
  if (!["member", "manager", "hr", "admin"].includes(f.role)) e.role = "Choose a role.";
  else if ((f.role === "hr" || f.role === "admin") && !isAdmin) e.role = "Only an Admin can create HR or Admin accounts.";
  if (f.business_email.trim() && !EMAIL.test(f.business_email.trim())) e.business_email = "Enter a valid email.";
  if (f.business_phone.trim() && !/^\+?[\d\s-]{7,20}$/.test(f.business_phone.trim())) e.business_phone = "Enter a valid phone number.";
  if (f.device_pin.trim() && !/^\d{1,9}$/.test(f.device_pin.trim())) e.device_pin = "Machine PINs are 1–9 digits.";
  return e;
}

/** Splits the provision fields from the details set afterwards with update_employee. */
export function provisionPayload(f: NewEmployeeForm) {
  const fields: Record<string, string> = {
    employee_code: normalizeCode(f.employee_code),
    full_name: f.full_name.trim(),
    join_date: f.join_date,
    team_id: f.team_id,
    office_id: f.office_id,
    shift_id: f.shift_id,
    role: f.role,
  };
  if (f.department_id) fields.department_id = f.department_id;
  const after: Record<string, string> = {};
  if (f.designation.trim()) after.designation = f.designation.trim();
  if (f.business_email.trim()) after.business_email = f.business_email.trim();
  if (f.business_phone.trim()) after.business_phone = f.business_phone.trim();
  return { fields, after, device_pin: f.device_pin.trim() || null };
}

/** Half-day units from a days string ("1.5" → 3). Null when not a non-zero multiple of 0.5 within ±365. */
export function daysToUnits(s: string): number | null {
  const t = s.trim();
  if (!/^-?\d{1,3}(\.\d+)?$/.test(t)) return null;
  const units = Number(t) * 2;
  if (!Number.isInteger(units) || units === 0 || Math.abs(units) > 730) return null;
  return units;
}

/** Salary amount from text ("45,000.50"); null when invalid. */
export function parseAmount(s: string): number | null {
  const t = s.replace(/[₹,\s]/g, "");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return null;
  return Number(t);
}
