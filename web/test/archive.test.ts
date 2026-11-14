import { afterEach, describe, expect, it, vi } from "vitest";
import { type Manifest, ArchiveError, archiveFileName, buildArchive, canonicalManifest, csvCell, extractOriginals, isSafeZipPath, localHm, sha256Hex } from "@/lib/archive";
import { buildZip, crc32, readZipDirectory, readZipEntry } from "@/lib/zip";
import { fail, mockFetch, ok } from "./helpers";

afterEach(() => vi.unstubAllGlobals());
const enc = new TextEncoder();
const dec = new TextDecoder();

describe("zip", () => {
  it("crc32 matches known vectors", () => {
    expect(crc32(enc.encode(""))).toBe(0);
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(enc.encode("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  });
  it("writes a zip that reads back byte for byte (UTF-8 names, empty file)", async () => {
    const files = [
      { path: "a.txt", data: enc.encode("hello") },
      { path: "EMP001 Asha/Profile.json", data: enc.encode('{"x":1}') },
      { path: "ராஜ்/நோட்.txt", data: enc.encode("unicode") },
      { path: "empty.bin", data: new Uint8Array(0) },
    ];
    const zip = buildZip(files, new Date(2026, 10, 14, 10, 30));
    const dir = await readZipDirectory(zip);
    expect(dir.map((d) => d.path)).toEqual(files.map((f) => f.path));
    for (const [i, e] of dir.entries()) expect(dec.decode(await readZipEntry(zip, e))).toBe(dec.decode(files[i].data));
  });
  it("refuses duplicate paths", () => {
    expect(() => buildZip([{ path: "a", data: new Uint8Array(1) }, { path: "a", data: new Uint8Array(1) }])).toThrow(/Duplicate/);
  });
  it("rejects non-zips and damaged entries", async () => {
    await expect(readZipDirectory(new Blob([enc.encode("not a zip at all")]))).rejects.toThrow(/not a ZIP/);
    const zip = buildZip([{ path: "a.txt", data: enc.encode("hello") }]);
    const [e] = await readZipDirectory(zip);
    await expect(readZipEntry(zip, { ...e, crc: e.crc ^ 1 })).rejects.toThrow(/failed its check/);
    await expect(readZipEntry(zip, e, 2)).rejects.toThrow(/larger than allowed/);
    await expect(readZipEntry(zip, { ...e, method: 12 })).rejects.toThrow(/unsupported/);
    await expect(readZipEntry(zip, { ...e, localOffset: 5 })).rejects.toThrow(/damaged/);
  });
});

describe("archive helpers", () => {
  it.each(["a.pdf", "EMP001 Asha/Payslips/2026-04.pdf", "x/y/z"])("safe path %s", (p) => expect(isSafeZipPath(p)).toBe(true));
  it.each(["", "/abs", "a/../b", "a\\b", "C:/x", "a//b", "./a", "a/.", "trail.", "trail ", "con", "aux.txt", "COM1/x", "a\u0001b", "x".repeat(401)])("unsafe path %j", (p) => expect(isSafeZipPath(p)).toBe(false));
  it("csvCell quotes and neutralises formulas", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("-5")).toBe("-5");
    expect(csvCell("-x")).toBe("'-x");
    expect(csvCell(true)).toBe("Yes");
    expect(csvCell(null)).toBe("");
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
  });
  it("local times use the org zone", () => {
    expect(localHm("2026-11-14T04:00:00Z", "Asia/Kolkata")).toBe("09:30");
    expect(localHm(null, "Asia/Kolkata")).toBe("");
    expect(localHm("garbage", "Asia/Kolkata")).toBe("");
  });
  it("file name marks partial archives", () => {
    const m = { period_start: "2025-04-01", period_end: "2026-03-31", revision: 2 };
    expect(archiveFileName(m, false)).toBe("HRMS_2025-04-01_2026-03-31_r2.zip");
    expect(archiveFileName(m, true)).toBe("HRMS_2025-04-01_2026-03-31_r2_PARTIAL.zip");
  });
  it("canonical manifest sorts by path / employee id in byte order and omits empty sections", () => {
    const text = canonicalManifest({
      id: "j1", period_start: "2025-04-01", period_end: "2026-03-31", revision: 1,
      items: [
        { path: "b/x.pdf", size_bytes: 2, sha256: "bb", file_version_id: "f2", source: "cloud" },
        { path: "B/x.pdf", size_bytes: 1, sha256: "aa", file_version_id: "f1", source: "local_base" },
      ] as never,
      employees: [{ employee_id: "e2", attendance_count: 3, leave_count: 0 }, { employee_id: "e1", attendance_count: 1, leave_count: 2 }] as never,
    });
    expect(text).toBe(["hrms-archive-v1", "job:j1", "period:2025-04-01..2026-03-31", "revision:1", "file:B/x.pdf|1|aa|f1|local_base", "file:b/x.pdf|2|bb|f2|cloud", "employee:e1|1|2", "employee:e2|3|0"].join("\n"));
    expect(canonicalManifest({ id: "j", period_start: "a", period_end: "b", revision: 1, items: [], employees: [] })).toBe("hrms-archive-v1\njob:j\nperiod:a..b\nrevision:1");
  });
  it("sha256Hex", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

const PDF = enc.encode("%PDF-1.4 slip");
const PDF2 = enc.encode("%PDF-1.4 old");

async function manifest(over: Partial<Manifest> = {}): Promise<Manifest> {
  const m = {
    id: "j1", period_id: "p1", period_start: "2025-04-01", period_end: "2026-03-31", label: "FY 2025-26", revision: 1, state: "ready", stale: false,
    stale_reason: null, provisional: false, live_until: null, as_of: "2026-04-02T00:00:00Z", timezone: "Asia/Kolkata", file_count: 1, total_bytes: PDF.length,
    local_base_count: 0, requires_local_base: false, base_export_id: null, base: null, manifest_hash: "", row_counts: {}, exclusions: [], missing_file_ids: null,
    ready_expires_at: null, acknowledged_at: null, acknowledged_by: null, cleanup_consumed: false, cleanup: null, org: { name: "Acme", code: "ACME" },
    items: [{ file_version_id: "f1", employee_id: "e1", class: "payslip", business_date: "2025-05-01", path: "EMP001 Asha/Payslips/2025-05.pdf", size_bytes: PDF.length, sha256: await sha256Hex(PDF), source: "cloud" }],
    employees: [{ employee_id: "e1", code: "EMP001", name: "Asha", folder: "EMP001 Asha", status: "active", attendance_count: 1, leave_count: 1, totals: { required_seconds: 32400, credited_seconds: 30000, shortfall_seconds: 2400, extra_seconds: 0, unresolved_days: 0 } }],
    ...over,
  } as Manifest;
  m.manifest_hash = await sha256Hex(canonicalManifest(m));
  return m;
}
const employeeData = {
  profile: { name: "Asha" },
  attendance: [{ shift_date: "2025-05-02", status: "present", start_at: "2025-05-02T04:00:00Z", end_at: "2025-05-02T13:00:00Z", effective_in_at: "2025-05-02T04:05:00Z", effective_out_at: null, effective_source: "geo", required_seconds: 32400, credited_seconds: 30000, is_late: true }],
  leave: [{ request_id: "r1", leave_type_code: "CL", leave_type: "=evil()", paid: true, start_date: "2025-06-01", end_date: "2025-06-01", status: "approved", units_total: 2 }],
};

describe("buildArchive", () => {
  it("downloads, verifies, writes sheets + manifest and re-verifies the ZIP", async () => {
    const m = await manifest();
    const calls = mockFetch({ "/archive/j1/files/f1": () => [200, PDF], "/rpc/get_export_employee": () => ok(employeeData) });
    const progress: string[] = [];
    const b = await buildArchive(m, { onProgress: (p) => progress.push(p.label), now: new Date("2026-11-14T00:00:00Z") });
    expect(b).toMatchObject({ fileName: "HRMS_2025-04-01_2026-03-31_r1.zip", includedFiles: 1, includedBytes: PDF.length, partial: false, missingIds: [], manifestHash: m.manifest_hash });
    const dir = await readZipDirectory(b.blob);
    expect(dir.map((d) => d.path).sort()).toEqual(["EMP001 Asha/Attendance.csv", "EMP001 Asha/Leave.csv", "EMP001 Asha/Payslips/2025-05.pdf", "EMP001 Asha/Profile.json", "Summary.csv", "manifest.json"]);
    const read = async (p: string) => dec.decode(await readZipEntry(b.blob, dir.find((d) => d.path === p)!));
    expect(await read("EMP001 Asha/Payslips/2025-05.pdf")).toBe("%PDF-1.4 slip");
    expect(await read("EMP001 Asha/Attendance.csv")).toContain("2025-05-02,Present · late,09:30,18:30,09:35,,Location verified");
    expect(await read("EMP001 Asha/Leave.csv")).toContain("'=evil()");
    expect(await read("Summary.csv")).toContain("EMP001,Asha,active,EMP001 Asha,1,1,540,500,40,0,0,1");
    const mj = JSON.parse(await read("manifest.json"));
    expect(mj).toMatchObject({ format: "hrms-archive-v1", partial: false, job: { id: "j1", manifest_hash: m.manifest_hash }, generated_at: "2026-11-14T00:00:00.000Z" });
    expect(mj.items[0].included).toBe(true);
    expect(progress).toEqual(expect.arrayContaining(["Downloading files", "Preparing spreadsheets", "Writing the ZIP file", "Verifying the archive"]));
    expect(calls.filter((c) => c.path === "/rpc/get_export_employee")[0].body).toEqual({ p_job_id: "j1", p_employee_id: "e1" });
  });

  it("refuses a manifest whose hash does not match", async () => {
    const m = { ...(await manifest()), manifest_hash: "0".repeat(64) };
    await expect(buildArchive(m)).rejects.toThrow(/did not verify/);
  });
  it("refuses unsafe paths even with a valid hash", async () => {
    const good = await manifest();
    const bad = await manifest({ items: [{ ...good.items[0], path: "../../etc/passwd" }] });
    await expect(buildArchive(bad)).rejects.toThrow(/unsafe path/);
    const badFolder = await manifest({ employees: [{ ...good.employees[0], folder: "con" }] });
    await expect(buildArchive(badFolder)).rejects.toThrow(/unsafe folder/);
  });
  it("retries a corrupted download and fails after three bad copies", async () => {
    const m = await manifest();
    let n = 0;
    mockFetch({ "/archive/j1/files/f1": () => (++n < 3 ? [200, enc.encode("%PDF-1.4 XXXX")] : [200, PDF]), "/rpc/get_export_employee": () => ok(employeeData) });
    await expect(buildArchive(m)).resolves.toBeTruthy();
    expect(n).toBe(3);
    mockFetch({ "/archive/j1/files/f1": () => [200, enc.encode("%PDF-1.4 XXXX")] });
    await expect(buildArchive(m)).rejects.toThrow(/fingerprint/);
  });
  it("a file gone from the cloud stops the build with a clear message", async () => {
    mockFetch({ "/archive/j1/files/f1": () => fail(410, "ARCHIVED", "This file is no longer in cloud storage.") });
    await expect(buildArchive(await manifest())).rejects.toThrow(/no longer in cloud storage: EMP001 Asha/);
  });
  it("row count mismatch stops the build", async () => {
    mockFetch({ "/archive/j1/files/f1": () => [200, PDF], "/rpc/get_export_employee": () => ok({ ...employeeData, leave: [] }) });
    await expect(buildArchive(await manifest())).rejects.toThrow(/Row counts did not match for EMP001/);
  });
  it("stop keeps verified downloads for the next run", async () => {
    const m = await manifest();
    const cache = new Map<string, Uint8Array>();
    const signal = { cancelled: false };
    let downloads = 0;
    mockFetch({
      "/archive/j1/files/f1": () => (downloads++, [200, PDF]),
      "/rpc/get_export_employee": () => {
        signal.cancelled = true;
        return ok(employeeData);
      },
    });
    await expect(buildArchive(m, { cache, signal })).rejects.toBeInstanceOf(ArchiveError);
    expect(cache.has("f1")).toBe(true);
    signal.cancelled = false;
    await buildArchive(m, { cache, signal: { cancelled: false } });
    expect(downloads).toBe(1);
  });

  describe("earlier originals (local_base)", () => {
    const oldItem = async () => ({ file_version_id: "f0", employee_id: "e1", class: "payslip", business_date: "2024-05-01", path: "EMP001 Asha/Payslips/2024-05.pdf", size_bytes: PDF2.length, sha256: await sha256Hex(PDF2), source: "local_base" });
    const baseZip = (over: Record<string, unknown> = {}, data = PDF2) =>
      buildZip([
        { path: "manifest.json", data: enc.encode(JSON.stringify({ job: { id: "j0", manifest_hash: "h0" }, items: [{ file_version_id: "f0", path: "old/2024-05.pdf", included: true }], ...over })) },
        { path: "old/2024-05.pdf", data },
      ]);
    it("merges verified originals from the previous archive", async () => {
      const m0 = await manifest();
      const m = await manifest({ items: [...m0.items, await oldItem()], local_base_count: 1, requires_local_base: true, base: { id: "j0", revision: 1, manifest_hash: "h0" } });
      mockFetch({ "/archive/j1/files/f1": () => [200, PDF], "/rpc/get_export_employee": () => ok(employeeData) });
      await expect(buildArchive(m)).rejects.toThrow(/Select the previous archive/);
      const b = await buildArchive(m, { baseZip: baseZip() });
      const dir = await readZipDirectory(b.blob);
      expect(dec.decode(await readZipEntry(b.blob, dir.find((d) => d.path === "EMP001 Asha/Payslips/2024-05.pdf")!))).toBe("%PDF-1.4 old");
      expect(b.includedFiles).toBe(2);
    });
    it("a different or tampered previous archive is refused; partial build records what is missing", async () => {
      const m0 = await manifest();
      const m = await manifest({ items: [...m0.items, await oldItem()], local_base_count: 1, requires_local_base: true, base: { id: "j0", revision: 1, manifest_hash: "h0" } });
      mockFetch({ "/archive/j1/files/f1": () => [200, PDF], "/rpc/get_export_employee": () => ok(employeeData) });
      await expect(buildArchive(m, { baseZip: baseZip({ job: { id: "other", manifest_hash: "h0" } }) })).rejects.toThrow(/different archive/);
      await expect(buildArchive(m, { baseZip: baseZip({}, enc.encode("%PDF-1.4 new")) })).rejects.toThrow(/1 earlier file/);
      const b = await buildArchive(m, { partial: true });
      expect(b).toMatchObject({ partial: true, missingIds: ["f0"], includedFiles: 1, fileName: expect.stringMatching(/_PARTIAL\.zip$/) });
      const dir = await readZipDirectory(b.blob);
      const mj = JSON.parse(dec.decode(await readZipEntry(b.blob, dir.find((d) => d.path === "manifest.json")!)));
      expect(mj.missing_file_ids).toEqual(["f0"]);
      expect(mj.notes.at(-1)).toMatch(/PARTIAL/);
    });
    it("extractOriginals rejects archives without a manifest or with unsafe names", async () => {
      const need = [await oldItem()] as never;
      await expect(extractOriginals(buildZip([{ path: "x.txt", data: enc.encode("x") }]), { id: "j0", manifest_hash: "h0" }, need)).rejects.toThrow(/manifest.json is missing/);
      await expect(extractOriginals(buildZip([{ path: "../evil", data: enc.encode("x") }]), { id: "j0", manifest_hash: "h0" }, need)).rejects.toThrow(/unsafe file names/);
    });
  });
});
