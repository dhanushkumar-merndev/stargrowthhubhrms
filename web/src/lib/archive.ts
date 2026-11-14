// Annual archive, built in the browser (port of archive_builder.dart).
// The server inventories every file and row and fixes a manifest hash; the
// browser proves it received exactly that inventory, downloads each cloud
// file through an audited grant, checks size + SHA-256, merges earlier
// originals from the previous archive when the cloud copies are gone,
// writes CSV + JSON, zips, then reads the ZIP back and re-verifies it.

import { ApiError, API_BASE, OFFLINE_MESSAGE, rpc, toApiError } from "./api";
import { dayStatus, leaveSlotLabel, sourceLabel } from "./attendance";
import { buildZip, readZipDirectory, readZipEntry, ZIP_MAX_BYTES, type ZipInput } from "./zip";

export interface ManifestItem {
  file_version_id: string;
  employee_id: string;
  class: string;
  business_date: string | null;
  path: string;
  size_bytes: number;
  sha256: string;
  source: "cloud" | "local_base" | string;
  version_state?: string;
}
export interface ManifestEmployee {
  employee_id: string;
  code: string;
  name: string;
  folder: string;
  status: string;
  attendance_count: number;
  leave_count: number;
  totals: Record<string, number | null> | null;
}
export interface Manifest {
  id: string;
  period_id: string;
  period_start: string;
  period_end: string;
  label: string;
  revision: number;
  state: "building" | "ready" | "acknowledged" | "partial" | "cancelled" | "expired" | "failed" | string;
  stale: boolean;
  stale_reason: string | null;
  provisional: boolean;
  live_until: string | null;
  as_of: string;
  timezone: string;
  file_count: number;
  total_bytes: number;
  local_base_count: number;
  requires_local_base: boolean;
  base_export_id: string | null;
  base: { id: string; revision: number; manifest_hash: string } | null;
  manifest_hash: string;
  row_counts: Record<string, number> | null;
  exclusions: unknown;
  missing_file_ids: string[] | null;
  ready_expires_at: string | null;
  acknowledged_at: string | null;
  acknowledged_by: { id: string; name: string } | null;
  cleanup_consumed: boolean;
  cleanup: CleanupJob | null;
  org: { name: string; code: string } | null;
  items: ManifestItem[];
  employees: ManifestEmployee[];
}
export interface CleanupJob {
  id: string;
  export_job_id: string;
  state: "running" | "paused" | "stalled" | "completed" | "abandoned" | string;
  label: string;
  total_items: number;
  total_bytes: number;
  deleted_items: number;
  deleted_bytes: number;
  pending_items: number;
  in_flight_items: number;
  failed_items: number;
  driver: { id: string; name: string } | null;
  lease_active: boolean;
  finished_at: string | null;
  abandoned_at: string | null;
}

export class ArchiveError extends Error {}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Canonical manifest text; mirrors create_archive_export byte for byte. */
export function canonicalManifest(m: Pick<Manifest, "id" | "period_start" | "period_end" | "revision" | "items" | "employees">): string {
  const items = [...(m.items ?? [])].sort((a, b) => cmp(a.path, b.path));
  const employees = [...(m.employees ?? [])].sort((a, b) => cmp(a.employee_id, b.employee_id));
  return [
    "hrms-archive-v1",
    `job:${m.id}`,
    `period:${m.period_start}..${m.period_end}`,
    `revision:${m.revision}`,
    ...items.map((i) => `file:${i.path}|${i.size_bytes}|${i.sha256}|${i.file_version_id}|${i.source}`),
    ...employees.map((e) => `employee:${e.employee_id}|${e.attendance_count}|${e.leave_count}`),
  ].join("\n");
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Relative, forward-slash path with no traversal, drive letters, control characters or device names. */
export function isSafeZipPath(p: string): boolean {
  if (!p || p.length > 400 || p.startsWith("/") || p.includes("\\") || p.includes(":")) return false;
  for (const part of p.split("/")) {
    if (!part || part === "." || part === ".." || part.endsWith(".") || part.endsWith(" ")) return false;
    if (RESERVED.test(part)) return false;
    for (let i = 0; i < part.length; i++) {
      const c = part.charCodeAt(i);
      if (c < 0x20 || c === 0x7f) return false;
    }
  }
  return true;
}

export const archiveFileName = (m: Pick<Manifest, "period_start" | "period_end" | "revision">, partial: boolean) =>
  `HRMS_${m.period_start}_${m.period_end}_r${m.revision}${partial ? "_PARTIAL" : ""}.zip`;

/* ─────────────── CSV sheets ─────────────── */

export function csvCell(v: unknown): string {
  if (v == null) return "";
  let s = typeof v === "boolean" ? (v ? "Yes" : "No") : String(v);
  // Spreadsheet formula injection: neutralise leading = + - @ (and tab/CR).
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csv = (rows: unknown[][]) => "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

const mins = (s: unknown) => Math.trunc(Number(s ?? 0) / 60);

export function localHm(iso: unknown, tz: string): string {
  if (typeof iso !== "string" || !iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).format(d);
}
export function localDateTime(iso: unknown, tz: string): string {
  if (typeof iso !== "string" || !iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

type Row = Record<string, unknown>;

export function attendanceCsv(rows: Row[], tz: string): string {
  return csv([
    ["Shift date", "Status", "Shift start", "Shift end", "In", "Out", "Source", "Leave", "Required (min)", "Worked (min)", "Short (min)", "Extra (min)", "Late", "Late (min)", "Left early", "Early (min)", "Lunch paid", "Revision"],
    ...rows.map((r) => [
      r.shift_date,
      dayStatus({ status: String(r.status ?? ""), effective_source: (r.effective_source as string) ?? null, is_late: r.is_late === true } as never).label,
      localHm(r.start_at, tz),
      localHm(r.end_at, tz),
      localHm(r.effective_in_at, tz),
      localHm(r.effective_out_at, tz),
      r.effective_in_at ? sourceLabel(r.effective_source as string | null) : "",
      leaveSlotLabel(Number(r.leave_slots ?? 0)),
      mins(r.required_seconds),
      mins(r.credited_seconds),
      mins(r.shortfall_seconds),
      mins(r.extra_seconds),
      r.is_late === true,
      mins(r.late_seconds),
      r.is_early_departure === true,
      mins(r.early_seconds),
      r.lunch_paid === true,
      r.effective_revision,
    ]),
  ]);
}

export function leaveCsv(rows: Row[], tz: string): string {
  const days = (u: unknown) => Number(u ?? 0) / 2;
  return csv([
    ["Request ID", "Code", "Leave type", "Paid", "Start", "End", "Status", "Days total", "Booked in period", "Requested in period", "Submitted", "Decided"],
    ...rows.map((r) => [r.request_id, r.leave_type_code, r.leave_type, r.paid === true, r.start_date, r.end_date, r.status, days(r.units_total), days(r.booked_units_in_period), days(r.requested_units_in_period), localDateTime(r.submitted_at, tz), localDateTime(r.decided_at, tz)]),
  ]);
}

/* ─────────────── Downloads ─────────────── */

/** One audited cloud file of the export. Returns verified bytes. */
export async function downloadExportFile(jobId: string, item: ManifestItem, attempts = 3): Promise<Uint8Array> {
  let last: unknown = null;
  for (let a = 0; a < attempts; a++) {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/archive/${jobId}/files/${item.file_version_id}`, { headers: { "x-requested-with": "hrms-web" }, credentials: "same-origin", cache: "no-store" });
    } catch {
      last = new ApiError("NETWORK", OFFLINE_MESSAGE, 0, {}, true);
      continue;
    }
    if (!res.ok) {
      const err = toApiError(res.status, await res.json().catch(() => null));
      if (err.code === "ARCHIVED") throw new ArchiveError(`A file is no longer in cloud storage: ${item.path}. Create a new export.`);
      if (!err.retryable) throw err;
      last = err;
      continue;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === item.size_bytes && (await sha256Hex(bytes)) === item.sha256) return bytes;
    last = new ArchiveError(`A downloaded file did not match its recorded fingerprint: ${item.path}`);
  }
  throw last instanceof Error ? last : new ArchiveError("Could not download a file.");
}

/** Pulls earlier originals out of the previous acknowledged archive. */
export async function extractOriginals(zip: Blob, base: { id: string; manifest_hash: string }, needed: ManifestItem[]): Promise<{ files: Map<string, Uint8Array>; missing: string[] }> {
  const dir = await readZipDirectory(zip);
  for (const e of dir) {
    if (e.path.endsWith("/")) continue;
    if (!isSafeZipPath(e.path)) throw new ArchiveError("The archive contains unsafe file names and was not used.");
    if (e.size > 60_000_000 || (e.compressedSize > 0 && e.size > 1_000_000 && e.size / e.compressedSize > 200)) throw new ArchiveError("The archive contains an oversized or suspicious entry and was not used.");
  }
  const mEntry = dir.find((e) => e.path === "manifest.json");
  if (!mEntry) throw new ArchiveError("This is not an HRMS archive (manifest.json is missing).");
  let old: { job?: { id?: string; manifest_hash?: string }; items?: { file_version_id: string; path: string; included?: boolean }[] };
  try {
    old = JSON.parse(new TextDecoder().decode(await readZipEntry(zip, mEntry, 60_000_000)));
  } catch {
    throw new ArchiveError("The archive's manifest could not be read.");
  }
  if (old.job?.id !== base.id || old.job?.manifest_hash !== base.manifest_hash) throw new ArchiveError("This is a different archive from the one required. Choose the saved archive of the stated revision.");
  const pathById = new Map((old.items ?? []).filter((i) => i.included !== false).map((i) => [i.file_version_id, i.path]));
  const byPath = new Map(dir.map((e) => [e.path, e]));
  const files = new Map<string, Uint8Array>();
  const missing: string[] = [];
  for (const n of needed) {
    const path = pathById.get(n.file_version_id);
    const entry = path ? byPath.get(path) : undefined;
    if (!entry || entry.size !== n.size_bytes || n.size_bytes > 5_000_000) {
      missing.push(n.file_version_id);
      continue;
    }
    try {
      const bytes = await readZipEntry(zip, entry, n.size_bytes);
      if ((await sha256Hex(bytes)) !== n.sha256) missing.push(n.file_version_id);
      else files.set(n.file_version_id, bytes);
    } catch {
      missing.push(n.file_version_id);
    }
  }
  return { files, missing };
}

/* ─────────────── Build ─────────────── */

export interface Progress {
  label: string;
  done: number;
  total: number;
}
export interface BuiltArchive {
  blob: Blob;
  fileName: string;
  includedFiles: number;
  includedBytes: number;
  partial: boolean;
  missingIds: string[];
  manifestHash: string;
}

export interface BuildOptions {
  baseZip?: Blob | null;
  partial?: boolean;
  onProgress?: (p: Progress) => void;
  signal?: { cancelled: boolean };
  /** Verified downloads survive a stopped build (kept by the caller). */
  cache?: Map<string, Uint8Array>;
  now?: Date;
}

export function manifestJson(m: Manifest, partial: boolean, missing: string[], now: Date) {
  return {
    format: "hrms-archive-v1",
    job: { id: m.id, revision: m.revision, period_start: m.period_start, period_end: m.period_end, label: m.label, timezone: m.timezone, as_of: m.as_of, manifest_hash: m.manifest_hash, provisional: m.provisional, base_export_id: m.base_export_id },
    organization: m.org,
    generated_at: now.toISOString(),
    partial,
    missing_file_ids: missing,
    row_counts: m.row_counts,
    exclusions: m.exclusions,
    employees: m.employees,
    items: m.items.map((i) => ({ ...i, included: !missing.includes(i.file_version_id) })),
    notes: [
      `Dates are shift start dates; times are local office time (${m.timezone}).`,
      "Profile.json files show each profile as of the export time, not historical values.",
      "Pending requests are exported as pending; extra time is not overtime pay.",
      ...(partial ? ["PARTIAL: earlier originals listed in missing_file_ids are not included."] : []),
    ],
  };
}

export async function buildArchive(m: Manifest, o: BuildOptions = {}): Promise<BuiltArchive> {
  const progress = o.onProgress ?? (() => undefined);
  const check = () => {
    if (o.signal?.cancelled) throw new ArchiveError("Stopped. Verified downloads are kept while this page stays open.");
  };
  if ((await sha256Hex(canonicalManifest(m))) !== m.manifest_hash) throw new ArchiveError("The downloaded manifest did not verify. Reload and try again.");
  if (m.items.some((i) => !isSafeZipPath(i.path))) throw new ArchiveError("The manifest contains an unsafe path.");
  if (m.employees.some((e) => !isSafeZipPath(e.folder))) throw new ArchiveError("The manifest contains an unsafe folder.");
  if (m.total_bytes > ZIP_MAX_BYTES) throw new ArchiveError("This archive is larger than 4 GB and cannot be built in the browser.");
  const cache = o.cache ?? new Map<string, Uint8Array>();
  const cloud = m.items.filter((i) => i.source === "cloud");
  const local = m.items.filter((i) => i.source === "local_base");

  // 1. Cloud files, two at a time.
  let done = 0;
  let next = 0;
  progress({ label: "Downloading files", done: 0, total: cloud.length });
  const worker = async () => {
    for (;;) {
      check();
      const i = next++;
      if (i >= cloud.length) return;
      const item = cloud[i];
      if (!cache.has(item.file_version_id)) cache.set(item.file_version_id, await downloadExportFile(m.id, item));
      done++;
      progress({ label: "Downloading files", done, total: cloud.length });
    }
  };
  await Promise.all([worker(), worker()]);

  // 2. Originals already removed from the cloud.
  let missing: string[] = [];
  if (local.length) {
    if (o.partial) missing = local.map((i) => i.file_version_id);
    else {
      if (!o.baseZip || !m.base) throw new ArchiveError("Select the previous archive first.");
      progress({ label: "Checking the previous archive", done: 0, total: local.length });
      const r = await extractOriginals(o.baseZip, m.base, local);
      if (r.missing.length) throw new ArchiveError(`${r.missing.length} earlier file(s) were missing or did not match in that archive. Choose the correct archive, or build a clearly marked partial archive.`);
      r.files.forEach((v, k) => cache.set(k, v));
    }
  }

  // 3. Sheets, profiles, summary and manifest.
  const enc = new TextEncoder();
  const generated: ZipInput[] = [];
  const summary: unknown[][] = [["Employee ID", "Name", "Status", "Folder", "Attendance rows", "Leave rows", "Expected (min)", "Worked (min)", "Short (min)", "Extra (min)", "Unresolved days", "Files"]];
  progress({ label: "Preparing spreadsheets", done: 0, total: m.employees.length });
  for (let k = 0; k < m.employees.length; k++) {
    check();
    const e = m.employees[k];
    const d = await rpc<{ profile: unknown; attendance: Row[] | null; leave: Row[] | null }>("get_export_employee", { p_job_id: m.id, p_employee_id: e.employee_id });
    const attendance = d.attendance ?? [];
    const leave = d.leave ?? [];
    if (attendance.length !== e.attendance_count || leave.length !== e.leave_count) throw new ArchiveError(`Row counts did not match for ${e.code}. Reload the export and try again.`);
    generated.push({ path: `${e.folder}/Attendance.csv`, data: enc.encode(attendanceCsv(attendance, m.timezone)) });
    generated.push({ path: `${e.folder}/Leave.csv`, data: enc.encode(leaveCsv(leave, m.timezone)) });
    generated.push({ path: `${e.folder}/Profile.json`, data: enc.encode(JSON.stringify(d.profile, null, 2)) });
    const t = e.totals ?? {};
    summary.push([e.code, e.name, e.status, e.folder, attendance.length, leave.length, mins(t.required_seconds), mins(t.credited_seconds), mins(t.shortfall_seconds), mins(t.extra_seconds), t.unresolved_days ?? 0, m.items.filter((i) => i.employee_id === e.employee_id).length]);
    progress({ label: "Preparing spreadsheets", done: k + 1, total: m.employees.length });
  }
  const now = o.now ?? new Date();
  generated.push({ path: "Summary.csv", data: enc.encode(csv(summary)) });
  generated.push({ path: "manifest.json", data: enc.encode(JSON.stringify(manifestJson(m, !!o.partial, missing, now), null, 2)) });
  const included = m.items.filter((i) => !missing.includes(i.file_version_id));
  const entries: ZipInput[] = [...generated, ...included.map((i) => ({ path: i.path, data: cache.get(i.file_version_id)! }))];

  // 4. ZIP.
  check();
  progress({ label: "Writing the ZIP file", done: 0, total: 0 });
  const blob = buildZip(entries, now);

  // 5. Read back and verify every entry.
  progress({ label: "Verifying the archive", done: 0, total: entries.length });
  const dir = await readZipDirectory(blob);
  if (dir.length !== entries.length) throw new ArchiveError(`The ZIP has ${dir.length} files but ${entries.length} were expected.`);
  const byPath = new Map(dir.map((e) => [e.path, e]));
  const expected = new Map<string, string>(included.map((i) => [i.path, i.sha256]));
  for (const g of generated) expected.set(g.path, await sha256Hex(g.data));
  let v = 0;
  for (const [path, sha] of expected) {
    const entry = byPath.get(path);
    if (!entry) throw new ArchiveError(`Missing from the ZIP: ${path}`);
    if ((await sha256Hex(await readZipEntry(blob, entry))) !== sha) throw new ArchiveError(`A file did not verify: ${path}`);
    progress({ label: "Verifying the archive", done: ++v, total: entries.length });
  }
  return {
    blob,
    fileName: archiveFileName(m, !!o.partial),
    includedFiles: included.length,
    includedBytes: included.reduce((a, i) => a + i.size_bytes, 0),
    partial: !!o.partial,
    missingIds: missing,
    manifestHash: m.manifest_hash,
  };
}
