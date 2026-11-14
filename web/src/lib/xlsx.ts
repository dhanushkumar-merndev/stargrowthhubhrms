// A minimal Excel (.xlsx) writer: one sheet, text and number cells, a bold
// header row. Built on the STORE zip writer, so nothing extra is downloaded.
//
// Text is written as inline strings, never as formulas, so a value such as
// "=HYPERLINK(...)" shows as text instead of running.

import { type DayRow, type Totals, dayStatus, leaveSlotLabel } from "./attendance";
import { localHm } from "./archive";
import { buildZip } from "./zip";

export type Cell = string | number | null | undefined;

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** 0 → A, 25 → Z, 26 → AA. */
export function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Escapes XML and drops characters XML 1.0 cannot hold. */
export function xmlText(v: string): string {
  return v
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Excel's sheet-name rules: 1–31 characters, none of []:*?/\ . */
export function sheetName(s: string): string {
  const clean = s.replace(/[[\]:*?/\\]/g, " ").replace(/^'+|'+$/g, "").trim().slice(0, 31);
  return clean || "Sheet1";
}

function cell(v: Cell, ref: string, header: boolean): string {
  const style = header ? ' s="1"' : "";
  if (typeof v === "number") return Number.isFinite(v) ? `<c r="${ref}"${style}><v>${v}</v></c>` : "";
  if (v === null || v === undefined || v === "") return "";
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlText(String(v).slice(0, 32767))}</t></is></c>`;
}

export function sheetXml(rows: Cell[][]): string {
  const width = Math.max(1, ...rows.map((r) => r.length));
  const cols = Array.from({ length: width }, (_, i) => {
    const longest = Math.max(4, ...rows.map((r) => String(r[i] ?? "").length));
    return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, longest + 2)}" customWidth="1"/>`;
  }).join("");
  const body = rows
    .map((r, y) => `<row r="${y + 1}">${r.map((v, x) => cell(v, `${colName(x)}${y + 1}`, y === 0)).join("")}</row>`)
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    (rows.length > 1 ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : "") +
    `<cols>${cols}</cols><sheetData>${body}</sheetData></worksheet>`
  );
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  "</Types>";

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  "</Relationships>";

const WORKBOOK_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  "</Relationships>";

const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
  "</styleSheet>";

/** The first row is the (bold, frozen) header. */
export function buildXlsx(name: string, rows: Cell[][], now = new Date()): Blob {
  const enc = new TextEncoder();
  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${xmlText(sheetName(name))}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const zip = buildZip(
    [
      { path: "[Content_Types].xml", data: enc.encode(CONTENT_TYPES) },
      { path: "_rels/.rels", data: enc.encode(ROOT_RELS) },
      { path: "xl/workbook.xml", data: enc.encode(workbook) },
      { path: "xl/_rels/workbook.xml.rels", data: enc.encode(WORKBOOK_RELS) },
      { path: "xl/styles.xml", data: enc.encode(STYLES) },
      { path: "xl/worksheets/sheet1.xml", data: enc.encode(sheetXml(rows)) },
    ],
    now,
  );
  return new Blob([zip], { type: XLSX_TYPE });
}

/* ─────────── own attendance export ─────────── */

const hours = (s: number | null | undefined) => Math.round((Math.max(0, s ?? 0) / 3600) * 100) / 100;

export const ATTENDANCE_HEADER = ["Date", "Status", "In", "Out", "Worked (h)", "Required (h)", "Short by (h)", "Late (min)", "Leave"];

/** Days up to today, then a totals row. */
export function attendanceRows(rows: DayRow[], totals: Totals, today: string): Cell[][] {
  const days = rows
    .filter((r) => r.shift_date <= today)
    .map((r) => [
      r.shift_date,
      dayStatus(r).label,
      localHm(r.effective_in_at, r.timezone),
      localHm(r.effective_out_at, r.timezone),
      hours(r.credited_seconds),
      hours(r.required_seconds),
      hours(r.shortfall_seconds),
      r.is_late ? Math.round((r.late_seconds ?? 0) / 60) : "",
      leaveSlotLabel(r.leave_slots),
    ]);
  return [
    ATTENDANCE_HEADER,
    ...days,
    [],
    ["Total", `${totals.present_days ?? 0} present · ${totals.late_days ?? 0} late · ${totals.absent_days ?? 0} absent`, "", "", hours(totals.credited_seconds), hours(totals.required_seconds), hours(totals.shortfall_seconds), "", ""],
  ];
}

/** "attendance-2026-11.xlsx" */
export const attendanceFileName = (from: string, ext = "xlsx") => `attendance-${from.slice(0, 7)}.${ext}`;

/** "2026-11" → first day "2026-11-01", or null when malformed. */
export function monthParam(v: string | undefined | null): string | null {
  if (!v || !/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) return null;
  return `${v}-01`;
}
