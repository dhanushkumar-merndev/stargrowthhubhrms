import { describe, expect, it } from "vitest";
import { fileError, filenameFrom, mimeFor, sizeLabel, uploadQuery } from "@/lib/files";
import {
  type EmployeeRow,
  type OrgStructure,
  bankErrors,
  countKind,
  documentTitleError,
  importRole,
  initials,
  maskAccount,
  money,
  monthLabel,
  parseCsv,
  planImport,
  privateErrors,
  privatePatch,
  readXlsx,
  sheetDate,
  templateCsv,
  toCsv,
} from "@/lib/people";

describe("formatting", () => {
  it("money uses Indian grouping and tolerates junk", () => {
    expect(money(4500000)).toBe("₹45,00,000");
    expect(money("45000.5")).toBe("₹45,000.5");
    expect(money(0)).toBe("₹0");
    expect(money(null)).toBe("—");
    expect(money("abc")).toBe("—");
    expect(money(10, "USD")).toBe("USD 10");
  });
  it("monthLabel", () => {
    expect(monthLabel("2026-11-01")).toBe("November 2026");
    expect(monthLabel("2026-13-01")).toBe("—");
    expect(monthLabel(null)).toBe("—");
  });
  it("initials", () => {
    expect(initials("Asha Rao")).toBe("AR");
    expect(initials("  priya  k  menon ")).toBe("PM");
    expect(initials("Ravi")).toBe("R");
    expect(initials("")).toBe("?");
  });
  it("maskAccount", () => {
    expect(maskAccount("1234")).toBe("•••• 1234");
    expect(maskAccount(null)).toBe("—");
  });
});

describe("private details", () => {
  const blank = { personal_email: "", personal_phone: "", address: "", emergency_contact_name: "", emergency_contact_phone: "", date_of_birth: "" };
  it("accepts empty and valid values", () => {
    expect(privateErrors(blank, "2026-11-14")).toEqual({});
    expect(privateErrors({ ...blank, personal_email: "a.b@mail.co", personal_phone: "+91 98450 12345", date_of_birth: "1990-05-01" }, "2026-11-14")).toEqual({});
  });
  it("rejects bad email, phone and dates", () => {
    const e = privateErrors({ ...blank, personal_email: "nope@", personal_phone: "12", emergency_contact_phone: "abc", date_of_birth: "2026-11-14" }, "2026-11-14");
    expect(Object.keys(e).sort()).toEqual(["date_of_birth", "emergency_contact_phone", "personal_email", "personal_phone"]);
    expect(privateErrors({ ...blank, date_of_birth: "1900-01-01" }, "2026-11-14").date_of_birth).toMatch(/year/);
    expect(privateErrors({ ...blank, date_of_birth: "2026-02-30x" }, "2026-11-14").date_of_birth).toMatch(/valid/);
    expect(privateErrors({ ...blank, address: "x".repeat(501) }, "2026-11-14").address).toBeTruthy();
  });
  it("patch has only changes; blank clears", () => {
    const before = { personal_email: "old@mail.com", personal_phone: null, address: "Street 1", emergency_contact_name: null, emergency_contact_phone: null, date_of_birth: null, version: 2 };
    expect(privatePatch(before, { ...blank, personal_email: "old@mail.com ", address: "", personal_phone: "9845012345" })).toEqual({ address: null, personal_phone: "9845012345" });
    expect(privatePatch(null, blank)).toEqual({});
  });
});

describe("bank details", () => {
  const ok = { bank_name: "HDFC Bank", account_holder: "Asha Rao", account_number: "50100 1234 5678", confirm_number: "501001234 5678", ifsc: "hdfc0001234", reason: "" };
  it("accepts a valid first setup (no reason needed)", () => expect(bankErrors(ok, false)).toEqual({}));
  it("needs a reason for a change", () => expect(bankErrors(ok, true).reason).toBeTruthy());
  it("checks every field", () => {
    const e = bankErrors({ bank_name: "H", account_holder: "", account_number: "12ab", confirm_number: "", ifsc: "HDFC1234567", reason: "" }, false);
    expect(Object.keys(e).sort()).toEqual(["account_holder", "account_number", "bank_name", "ifsc"]);
    expect(bankErrors({ ...ok, confirm_number: "111111" }, false).confirm_number).toMatch(/match/);
    expect(bankErrors({ ...ok, account_number: "12345", confirm_number: "12345" }, false).account_number).toBeTruthy();
    expect(bankErrors({ ...ok, account_number: "1".repeat(19), confirm_number: "1".repeat(19) }, false).account_number).toBeTruthy();
  });
});

describe("documents and files", () => {
  it("title rules", () => {
    expect(documentTitleError("  ")).toBeTruthy();
    expect(documentTitleError("x".repeat(51))).toMatch(/50/);
    expect(documentTitleError("PAN card")).toBeNull();
  });
  it("mime by type or extension", () => {
    expect(mimeFor({ name: "a.PDF", type: "" })).toBe("application/pdf");
    expect(mimeFor({ name: "a.bin", type: "image/png" })).toBe("image/png");
    expect(mimeFor({ name: "a.exe", type: "application/x-msdownload" })).toBeNull();
  });
  it("client checks per class", () => {
    expect(fileError({ name: "a.pdf", size: 0 }, "employee_document")).toMatch(/empty/);
    expect(fileError({ name: "a.pdf", size: 5_000_001 }, "employee_document")).toMatch(/5 MB/);
    expect(fileError({ name: "a.pdf", size: 5_000_000 }, "employee_document")).toBeNull();
    expect(fileError({ name: "a.png", size: 10 }, "payslip")).toBe("Use a PDF file.");
    expect(fileError({ name: "a.webp", size: 10 }, "avatar")).toBeNull();
    expect(fileError({ name: "a.pdf", size: 10 }, "avatar")).toMatch(/image/);
    expect(fileError({ name: "a.jpg", size: 10 }, "leave_attachment")).toBeNull();
  });
  it("upload query encodes and trims", () => {
    const q = new URLSearchParams(uploadQuery("Offer & letter.pdf", { cls: "employee_document", ownerEmployeeId: "e1", title: "x".repeat(300) }));
    expect(q.get("filename")).toBe("Offer & letter.pdf");
    expect(q.get("owner_employee_id")).toBe("e1");
    expect(q.get("title")).toHaveLength(200);
    expect(q.has("salary_month")).toBe(false);
  });
  it("filename from Content-Disposition", () => {
    expect(filenameFrom(`inline; filename="____.pdf"; filename*=UTF-8''%E0%AE%B0.pdf`)).toBe("ர.pdf");
    expect(filenameFrom(`attachment; filename="Nov payslip.pdf"`)).toBe("Nov payslip.pdf");
    expect(filenameFrom(`attachment; filename*=UTF-8''%E0%A4`)).toBeNull();
    expect(filenameFrom(null)).toBeNull();
  });
  it("sizeLabel", () => {
    expect(sizeLabel(999)).toBe("999 B");
    expect(sizeLabel(25_400)).toBe("25 KB");
    expect(sizeLabel(4_200_000)).toBe("4.2 MB");
    expect(sizeLabel(-1)).toBe("—");
  });
});

describe("CSV", () => {
  it("parses quotes, commas, newlines and BOM", () => {
    expect(parseCsv('﻿a,"b,c","d ""q"""\r\n1,"two\nlines",3\n')).toEqual([
      ["a", "b,c", 'd "q"'],
      ["1", "two\nlines", "3"],
    ]);
    expect(parseCsv("x,y")).toEqual([["x", "y"]]);
    expect(parseCsv("")).toEqual([]);
  });
  it("round-trips and neutralises formulas", () => {
    const csv = toCsv([["=SUM(A1)", "a,b", 'q"t', null, 5, "-2", "@x"]]);
    expect(csv).toBe(`'=SUM(A1),"a,b","q""t",,5,'-2,'@x\r\n`);
    expect(parseCsv(csv)[0][1]).toBe("a,b");
  });
});

describe("sheet dates and roles", () => {
  it.each([
    ["2026-10-01", "2026-10-01"],
    ["2026-1-5", "2026-01-05"],
    ["01/10/2026", "2026-10-01"],
    ["1.10.2026", "2026-10-01"],
    ["46296", "2026-10-01"],
    ["2026-10-01T00:00:00", "2026-10-01"],
    ["31/02/2026", null],
    ["2026-13-01", null],
    ["12", null],
    ["tomorrow", null],
    ["", null],
  ])("%s → %s", (raw, out) => expect(sheetDate(raw)).toBe(out));
  it("roles", () => {
    expect(importRole("")).toBe("member");
    expect(importRole("Team Manager")).toBe("manager");
    expect(importRole("Human-Resources")).toBe("hr");
    expect(importRole("Administrator")).toBe("admin");
    expect(importRole("CEO")).toBeNull();
  });
});

const structure: OrgStructure = {
  departments: [{ id: "d1", name: "General", active: true }, { id: "d2", name: "Sales", active: true }],
  teams: [{ id: "t1", name: "Management", active: true }, { id: "t2", name: "Field", active: true }, { id: "tx", name: "Old", active: false }],
  offices: [{ id: "o1", name: "Bengaluru HQ", active: true }],
  shifts: [{ id: "s1", name: "General", active: true }],
};
const emp = (over: Partial<EmployeeRow> = {}): EmployeeRow => ({
  id: "e1", code: "EMP001", name: "Asha Rao", designation: "Engineer", position_label: "member", role: "employee", business_email: null, business_phone: null,
  avatar_file_version_id: null, department: { id: "d1", name: "General" }, team: { id: "t1", name: "Management" }, status: "active", roles: [], join_date: "2026-10-01",
  end_date: null, setup_pending: false, version: 3, ...over,
});
const ctx = (over = {}) => ({ existing: new Map([["EMP001", emp()], ["ADMIN1", emp({ id: "a1", code: "ADMIN1", name: "Demo Admin", roles: ["admin"] })]]), structure, isAdmin: true, canProvision: true, canManagePayroll: true, myEmployeeId: "a1", ...over });
const H = ["Employee ID", "Full name", "Role", "Department", "Team", "Office", "Shift", "Join date", "Work email", "Monthly salary", "Salary effective from", "Bank name", "Favourite colour"];

describe("planImport", () => {
  it("finds the header within the first 10 rows and reports extras", () => {
    const p = planImport([["Staff list"], [], H, ["EMP100", "New Person", "", "", "Field", "", "", "2026-11-01", "", "", "", "", "blue"]], ctx());
    expect(p.unknownHeaders).toEqual(["Favourite colour"]);
    expect(p.missingColumns).toEqual([]);
    expect(p.rows[0]).toMatchObject({ rowNumber: 4, kind: "create", teamId: "t2", officeId: "o1", shiftId: "s1", role: "member" });
  });
  it("no Employee ID column", () => expect(planImport([["Name"], ["X"]], ctx()).missingColumns).toEqual(["Employee ID"]));

  it("create: validation errors", () => {
    const p = planImport(
      [H, ["e 1", "", "CEO", "", "", "", "", "soon", "", "abc", "x", "", ""], ["EMP200", "B", "HR", "", "Old", "", "", "2026-11-01", "", "", "", "", ""], ["EMP200", "C", "", "", "Field", "", "", "2026-11-01", "", "", "", "", ""]],
      ctx({ isAdmin: false }),
    );
    const [a, b, c] = p.rows;
    expect(a.errors.join("|")).toMatch(/3–32.*Role must.*not a number.*not a date.*Full name.*Join date "soon"/);
    expect(b.errors.join("|")).toMatch(/Only an Admin.*Unknown team "Old" — use one of: Management, Field/);
    expect(c.errors).toEqual(["Employee ID EMP200 appears more than once in the file"]);
    expect(countKind(p, "error")).toBe(3);
  });

  it("team is required when there are several; blank office/shift pick the only one", () => {
    const p = planImport([H, ["EMP300", "D", "", "", "", "", "", "2026-11-01", "", "", "", "", ""]], ctx());
    expect(p.rows[0].errors).toEqual(["team is required (Management, Field)"]);
  });

  it("salary: skipped without payroll access; bank columns always skipped", () => {
    const p = planImport([H, ["EMP400", "E", "", "", "Field", "", "", "2026-11-01", "", "₹45,000", "01/11/2026", "HDFC", ""]], ctx({ canManagePayroll: false }));
    expect(p.rows[0].salary).toEqual({});
    expect(p.rows[0].notes.join("|")).toMatch(/Bank columns skipped.*no.*payroll access/i);
    const q = planImport([H, ["EMP400", "E", "", "", "Field", "", "", "2026-11-01", "", "Rs. 45,000", "01/11/2026", "", ""]], ctx());
    expect(q.rows[0].salary).toEqual({ monthly_salary: 45000, effective_from: "2026-11-01" });
    expect(q.rows[0].changes).toContain("Salary details added");
  });

  it("cannot create without the right", () => {
    expect(planImport([H, ["EMP500", "F", "", "", "Field", "", "", "2026-11-01", "", "", "", "", ""]], ctx({ canProvision: false })).rows[0].errors).toContain("You cannot create employees");
  });

  it("update: diffs details, explains what it will not change", () => {
    const p = planImport(
      [["Employee ID", "Full name", "Role", "Department", "Team", "Office", "Work email", "Monthly salary"], ["emp001", "Asha Rao", "Admin", "Sales", "Field", "HQ", "asha@acme.in", "50000"]],
      ctx(),
    );
    const r = p.rows[0];
    expect(r.kind).toBe("update");
    expect(r.patch).toEqual({ business_email: "asha@acme.in", department_id: "d2" });
    expect(r.changes.join("|")).toMatch(/Work email: — → asha@acme.in.*Department: General → Sales.*Salary details updated \(amount\)/);
    expect(r.notes.join("|")).toMatch(/Role not changed \(Member → Admin\).*Team not changed.*Office and shift/);
    expect(p.missingColumns).toEqual(["Join date"]);
  });

  it("update: unchanged rows and own salary", () => {
    const same = planImport([["Employee ID", "Full name"], ["EMP001", "Asha Rao"]], ctx());
    expect(same.rows[0].kind).toBe("unchanged");
    const own = planImport([["Employee ID", "Monthly salary"], ["ADMIN1", "90000"]], ctx({ isAdmin: false, myEmployeeId: "a1" }));
    expect(own.rows[0].salary).toEqual({});
    expect(own.rows[0].kind).toBe("unchanged");
    expect(own.rows[0].notes[0]).toMatch(/own salary/);
    const unknownDept = planImport([["Employee ID", "Department"], ["EMP001", "Ops"]], ctx());
    expect(unknownDept.rows[0].kind).toBe("error");
  });

  it("skips blank lines", () => {
    expect(planImport([H, ["", "", ""], []], ctx()).rows).toHaveLength(0);
  });

  it("template lists the organisation's names", () => {
    const csv = templateCsv(structure);
    expect(csv.split("\r\n")[0]).toBe("Employee ID,Full name,Role,Designation,Department,Team,Office,Shift,Join date,Work email,Work phone,Monthly salary,Salary effective from");
    expect(csv).toMatch(/Management \/ Field/);
    expect(planImport(parseCsv(csv), ctx()).rows[0]).toMatchObject({ kind: "create", values: expect.objectContaining({ code: "EMP100" }) });
  });
});

/* A minimal stored (uncompressed) zip with the xlsx parts we read. */
function zip(files: Record<string, string>): ArrayBuffer {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = enc.encode(name);
    const data = enc.encode(text);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(26, n.length, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    parts.push(new Uint8Array(local.buffer), n, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, n.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), n);
    offset += 30 + n.length + data.length;
  }
  const csize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, csize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const a of all) {
    out.set(a, p);
    p += a.length;
  }
  return out.buffer;
}

describe("readXlsx", () => {
  it("reads shared, inline and numeric cells with gaps", async () => {
    const buf = zip({
      "xl/sharedStrings.xml": `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Employee ID</t></si><si><r><t>Full </t></r><r><t>name</t></r></si><si><t>EMP900</t></si></sst>`,
      "xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Join date</t></is></c></row>
        <row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3" t="inlineStr"><is><t>Zed</t></is></c><c r="D3"><v>46296</v></c></row>
      </sheetData></worksheet>`,
      "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>ignored</t></is></c></row></sheetData></worksheet>`,
    });
    const rows = await readXlsx(buf);
    expect(rows[0]).toEqual(["Employee ID", "Full name", "", "Join date"]);
    expect(rows[1]).toEqual([]);
    expect(rows[2]).toEqual(["EMP900", "Zed", "", "46296"]);
    expect(sheetDate(rows[2][3])).toBe("2026-10-01");
  });
  it("rejects a non-zip", async () => {
    await expect(readXlsx(new TextEncoder().encode("not a zip at all, sorry").buffer as ArrayBuffer)).rejects.toThrow("not a zip");
  });
});
