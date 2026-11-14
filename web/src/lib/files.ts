"use client";

// Private files through the Rust API (file_service.dart). Uploads are one
// request with the raw bytes; reads come back as a Blob kept in memory only
// (object URLs are revoked by the caller). Nothing is cached by the browser:
// the server answers with Cache-Control: no-store.

import { API_BASE, ApiError, OFFLINE_MESSAGE, rpc, toApiError } from "./api";

export const MAX_FILE_BYTES = 5_000_000;
export type FileClass = "employee_document" | "payslip" | "avatar" | "company_policy" | "leave_attachment" | "medical_attachment" | "correction_attachment";

const MIME_BY_EXT: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
const ALLOWED: Record<string, string[]> = {
  payslip: ["application/pdf"],
  employee_document: ["application/pdf"],
  company_policy: ["application/pdf"],
  avatar: ["image/jpeg", "image/png", "image/webp"],
};

/** The type we will declare, from the browser's type or the extension. */
export function mimeFor(file: { name: string; type?: string }): string | null {
  const t = (file.type || "").toLowerCase();
  if (Object.values(MIME_BY_EXT).includes(t)) return t;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? null;
}

export function allowedFor(cls: FileClass): string[] {
  return ALLOWED[cls] ?? ["application/pdf", "image/jpeg", "image/png"];
}

export function acceptAttr(cls: FileClass): string {
  return allowedFor(cls)
    .map((m) => (m === "application/pdf" ? ".pdf,application/pdf" : m === "image/jpeg" ? ".jpg,.jpeg,image/jpeg" : m === "image/png" ? ".png,image/png" : ".webp,image/webp"))
    .join(",");
}

/** Client checks before sending (the server checks the bytes again). */
export function fileError(file: { name: string; type?: string; size: number }, cls: FileClass): string | null {
  if (file.size === 0) return "The file is empty.";
  if (file.size > MAX_FILE_BYTES) return "Files must be at most 5 MB.";
  const mime = mimeFor(file);
  const allowed = allowedFor(cls);
  if (!mime || !allowed.includes(mime)) return allowed.length === 1 ? "Use a PDF file." : allowed.includes("image/webp") ? "Use a JPG, PNG or WebP image." : "Use a PDF, JPG or PNG file.";
  return null;
}

export function sizeLabel(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export interface UploadOptions {
  cls: FileClass;
  ownerEmployeeId?: string | null;
  salaryMonth?: string | null;
  documentDate?: string | null;
  title?: string | null;
}

export function uploadQuery(name: string, o: UploadOptions): string {
  const q = new URLSearchParams({ class: o.cls, filename: name.slice(0, 200) });
  if (o.ownerEmployeeId) q.set("owner_employee_id", o.ownerEmployeeId);
  if (o.salaryMonth) q.set("salary_month", o.salaryMonth);
  if (o.documentDate) q.set("document_date", o.documentDate);
  if (o.title) q.set("title", o.title.slice(0, 200));
  return q.toString();
}

/** Uploads and validates a file; returns its file version id. */
export async function uploadFile(file: File | Blob & { name: string }, o: UploadOptions): Promise<string> {
  const problem = fileError(file, o.cls);
  if (problem) throw new ApiError(file.size > MAX_FILE_BYTES ? "FILE_TOO_LARGE" : "INVALID_FILE_TYPE", problem, 0, { file: problem });
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/files?${uploadQuery(file.name, o)}`, {
      method: "POST",
      headers: { "content-type": mimeFor(file)!, "x-requested-with": "hrms-web" },
      body: file,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApiError("NETWORK", OFFLINE_MESSAGE, 0, {}, true);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw toApiError(res.status, json);
  const id = (json as { data?: { file_version_id?: string } } | null)?.data?.file_version_id;
  if (!id) throw new ApiError("INTERNAL", "The upload did not complete. Try again.", res.status, {}, true);
  return id;
}

export interface OpenedFile {
  blob: Blob;
  filename: string;
  mime: string;
}

/** Reads a file through the audited flow and reports that it was opened. */
export async function fetchFile(versionId: string, purpose: "view" | "download" | "review" = "view", path = `files/${versionId}`): Promise<OpenedFile> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/${path}${path.startsWith("files/") ? `?purpose=${purpose}` : ""}`, {
      headers: { "x-requested-with": "hrms-web" },
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApiError("NETWORK", OFFLINE_MESSAGE, 0, {}, true);
  }
  if (!res.ok) throw toApiError(res.status, await res.json().catch(() => null));
  const blob = await res.blob();
  const grant = res.headers.get("x-file-grant");
  // Opening is reported separately from link issuance (AUDIT-003); best effort.
  if (grant) rpc("report_file_opened", { p_grant_id: grant }).catch(() => undefined);
  return { blob, filename: filenameFrom(res.headers.get("content-disposition")) ?? "document", mime: res.headers.get("content-type") ?? blob.type };
}

/** Prefers the RFC 5987 UTF-8 name, then the quoted ASCII one. */
export function filenameFrom(cd: string | null): string | null {
  if (!cd) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="([^"]*)"/i.exec(cd);
  return plain ? plain[1] : null;
}

/** Saves a fetched file through a temporary link. */
export function saveBlob(f: OpenedFile) {
  const url = URL.createObjectURL(f.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = f.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
