import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReauthHost } from "@/components/reauth";
import { ArchiveJob, ArchiveScreen } from "@/components/screens/archive";
import { canonicalManifest, sha256Hex } from "@/lib/archive";
import { SessionProvider } from "@/lib/session";
import { ctx, fail, mockFetch, ok } from "./helpers";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }), usePathname: () => "/admin/archive", useSearchParams: () => new URLSearchParams() }));

function wrap(ui: React.ReactNode) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SessionProvider>
        {ui}
        <ReauthHost />
      </SessionProvider>
    </SWRConfig>,
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});
const session = { "/rpc/get_session_context": () => ok(ctx("admin")) };
const enc = new TextEncoder();
const PDF = enc.encode("%PDF-1.4 slip");

const overview = (over: Record<string, unknown> = {}) => ({
  today: "2026-11-14", timezone: "Asia/Kolkata", annual_start_month: 4, storage: { used_bytes: 500, reserved_bytes: 0, budget_bytes: 1000 },
  periods: [
    { id: "p1", kind: "annual", label: "FY 2025-26", period_start: "2025-04-01", period_end: "2026-03-31", live_until: null, unlocks_on: "2026-04-01", closed: true, due: true, cleanup_running: false, jobs: [], cleanups: [], ...over },
    { id: "p2", kind: "annual", label: "FY 2026-27", period_start: "2026-04-01", period_end: "2027-03-31", live_until: null, unlocks_on: "2027-04-01", closed: false, due: false, cleanup_running: false, jobs: [], cleanups: [] },
  ],
});

describe("Archive overview", () => {
  it("creating an export needs a fresh password, then opens the job", async () => {
    let n = 0;
    const calls = mockFetch({
      ...session,
      "/rpc/get_archive_overview": () => ok(overview()),
      "/rpc/create_archive_export": () => (++n === 1 ? fail(403, "REAUTH_REQUIRED") : ok({ id: "j1" })),
      "/auth/reauth": () => ok({ grant_id: "g", expires_at: "x" }),
    });
    wrap(<ArchiveScreen />);
    expect(await screen.findByText("Archive due")).toBeInTheDocument();
    expect(screen.getByText(/can be archived from/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Create export" })).toHaveLength(1); // the open year cannot be exported
    await userEvent.click(screen.getByRole("button", { name: "Create export" }));
    expect(await screen.findByText(/create the annual archive/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Password"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/admin/archive/j1"));
    expect(calls.find((c) => c.path === "/auth/reauth")?.body).toEqual({ password: "pw", action: "export.annual", target_id: "p1" });
  });
  it("an export in progress is linked instead of offering a new one", async () => {
    mockFetch({ ...session, "/rpc/get_archive_overview": () => ok(overview({ jobs: [{ id: "j1", revision: 1, state: "ready", stale: false }] })) });
    wrap(<ArchiveScreen />);
    expect(await screen.findByRole("link", { name: /Revision 1/ })).toHaveAttribute("href", "/admin/archive/j1");
    expect(screen.queryByRole("button", { name: /Create/ })).toBeNull();
  });
});

async function manifest(over: Record<string, unknown> = {}) {
  const m: Record<string, unknown> = {
    id: "j1", period_id: "p1", period_start: "2025-04-01", period_end: "2026-03-31", label: "FY 2025-26", revision: 1, state: "ready", stale: false, stale_reason: null,
    provisional: false, live_until: null, as_of: "2026-04-02T00:00:00Z", timezone: "Asia/Kolkata", file_count: 1, total_bytes: PDF.length, local_base_count: 0,
    requires_local_base: false, base_export_id: null, base: null, row_counts: {}, exclusions: [], missing_file_ids: null, ready_expires_at: null, acknowledged_at: null,
    acknowledged_by: null, cleanup_consumed: false, cleanup: null, org: { name: "Acme", code: "ACME" },
    items: [{ file_version_id: "f1", employee_id: "e1", class: "payslip", business_date: "2025-05-01", path: "EMP001 Asha/Payslips/2025-05.pdf", size_bytes: PDF.length, sha256: await sha256Hex(PDF), source: "cloud" }],
    employees: [{ employee_id: "e1", code: "EMP001", name: "Asha", folder: "EMP001 Asha", status: "active", attendance_count: 0, leave_count: 0, totals: {} }],
    ...over,
  };
  m.manifest_hash = await sha256Hex(canonicalManifest(m as never));
  return m;
}

describe("Archive job", () => {
  it("builds and verifies the ZIP, requires the saved tick, then acknowledges", async () => {
    const m = await manifest();
    const calls = mockFetch({
      ...session,
      "/rpc/get_export_manifest": () => ok(m),
      "/archive/j1/files/f1": () => [200, PDF],
      "/rpc/get_export_employee": () => ok({ profile: {}, attendance: [], leave: [] }),
      "/rpc/acknowledge_export": () => ok({}),
    });
    wrap(<ArchiveJob id="j1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Build archive" }));
    expect(await screen.findByText(/Verified: HRMS_2025-04-01_2026-03-31_r1.zip/)).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Confirm saved" });
    expect(confirm).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Download ZIP" }));
    await userEvent.click(screen.getByLabelText(/I saved the ZIP/));
    await userEvent.click(confirm);
    await waitFor(() => expect(calls.find((c) => c.path === "/rpc/acknowledge_export")?.body).toEqual({ p_job_id: "j1", p_manifest_hash: m.manifest_hash, p_included_files: 1, p_included_bytes: PDF.length, p_partial: false, p_missing_file_ids: null, p_saved: true }));
  });
  it("a tampered manifest is refused before anything is downloaded", async () => {
    const m = { ...(await manifest()), manifest_hash: "f".repeat(64) };
    const calls = mockFetch({ ...session, "/rpc/get_export_manifest": () => ok(m) });
    wrap(<ArchiveJob id="j1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Build archive" }));
    expect(await screen.findByText(/manifest did not verify/)).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith("/archive/"))).toBe(false);
  });
  it("a stale export shows why and offers no build", async () => {
    mockFetch({ ...session, "/rpc/get_export_manifest": async () => ok(await manifest({ stale: true, stale_reason: "Attendance changed after export" })) });
    wrap(<ArchiveJob id="j1" />);
    expect(await screen.findByText(/Attendance changed after export/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Build archive" })).toBeNull();
  });
  it("earlier files need the previous archive; partial build is offered", async () => {
    const m0 = await manifest();
    const m = await manifest({
      local_base_count: 1, requires_local_base: true, base: { id: "j0", revision: 1, manifest_hash: "h0" },
      items: [...(m0.items as unknown[]), { file_version_id: "f0", employee_id: "e1", class: "payslip", business_date: null, path: "EMP001 Asha/old.pdf", size_bytes: 3, sha256: "00", source: "local_base" }],
    });
    mockFetch({ ...session, "/rpc/get_export_manifest": () => ok(m) });
    wrap(<ArchiveJob id="j1" />);
    expect(await screen.findByRole("button", { name: "Build archive" })).toBeDisabled();
    expect(screen.getByText(/revision 1, to include them/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /partial archive/ })).toBeEnabled();
  });

  const preview = { confirm_label: "FY 2025-26", checks: [{ key: "ack", ok: true, label: "Archive saved and verified" }], item_count: 4, total_bytes: 4000, employee_count: 2, visible_payslips: 1, kept: ["Avatars", "Company policies"] };
  it("cleanup needs both ticks, the exact label and a fresh password, then runs batches", async () => {
    const m = await manifest({ state: "acknowledged", acknowledged_at: "2026-11-01T00:00:00Z", acknowledged_by: { id: "e1", name: "Asha Rao" } });
    const job = { id: "c1", export_job_id: "j1", state: "running", label: "FY 2025-26", total_items: 4, total_bytes: 4000, deleted_items: 0, deleted_bytes: 0, pending_items: 4, in_flight_items: 0, failed_items: 0, driver: { id: "e1", name: "Asha Rao" }, lease_active: true, finished_at: null, abandoned_at: null };
    let begin = 0;
    let batch = 0;
    const calls = mockFetch({
      ...session,
      "/rpc/get_export_manifest": () => ok(m),
      "/rpc/preview_cleanup": () => ok(preview),
      "/rpc/begin_cleanup": () => (++begin === 1 ? fail(403, "REAUTH_REQUIRED") : ok(job)),
      "/auth/reauth": () => ok({ grant_id: "g", expires_at: "x" }),
      "/archive/cleanup/c1": () => (++batch === 1 ? ok({ job: { ...job, deleted_items: 2, deleted_bytes: 2000 } }) : ok({ done: true, job: { ...job, state: "completed", deleted_items: 4, deleted_bytes: 4000 } })),
      "/rpc/get_cleanup_job": () => ok({ ...job, state: "completed", deleted_items: 4 }),
    });
    wrap(<ArchiveJob id="j1" />);
    expect(await screen.findByText("✓ Archive saved and verified")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete cloud files" }));
    const sheet = within(screen.getByRole("dialog"));
    expect(sheet.getByText("Kept: Avatars, Company policies.")).toBeInTheDocument();
    await userEvent.type(sheet.getByLabelText("Type FY 2025-26 to confirm"), "fy 2025-26");
    await userEvent.click(sheet.getByRole("button", { name: "Delete files" }));
    expect(await sheet.findByText(/Tick both boxes/)).toBeInTheDocument();
    await userEvent.click(sheet.getByLabelText(/recent payslip/));
    await userEvent.click(sheet.getByLabelText(/I keep the saved archive safe/));
    await userEvent.click(sheet.getByRole("button", { name: "Delete files" }));
    await userEvent.type(await screen.findByLabelText("Password"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(batch).toBe(2));
    expect(calls.filter((c) => c.path === "/rpc/begin_cleanup").at(-1)?.body).toEqual({ p_job_id: "j1", p_manifest_hash: m.manifest_hash, p_confirm_label: "fy 2025-26", p_accept_visible_loss: true });
    expect(calls.find((c) => c.path === "/auth/reauth")?.body).toEqual({ password: "pw", action: "archive.cleanup", target_id: "j1" });
  });
  it("a failed check blocks the delete button", async () => {
    const m = await manifest({ state: "acknowledged" });
    mockFetch({ ...session, "/rpc/get_export_manifest": () => ok(m), "/rpc/preview_cleanup": () => ok({ ...preview, checks: [{ key: "lock", ok: false, label: "A shift is still open" }] }) });
    wrap(<ArchiveJob id="j1" />);
    expect(await screen.findByText("✗ A shift is still open")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete cloud files" })).toBeDisabled();
  });
  it("abandon reconciles in-flight items for the driver first", async () => {
    const job = { id: "c1", export_job_id: "j1", state: "paused", label: "FY", total_items: 4, total_bytes: 4000, deleted_items: 1, deleted_bytes: 1000, pending_items: 2, in_flight_items: 1, failed_items: 0, driver: { id: "e1", name: "Asha Rao" }, lease_active: false, finished_at: null, abandoned_at: null };
    const m = await manifest({ state: "acknowledged", cleanup: job, cleanup_consumed: true });
    const calls = mockFetch({ ...session, "/rpc/get_export_manifest": () => ok(m), "/rpc/get_cleanup_job": () => ok(job), "/archive/cleanup/c1": () => ok({ done: false }), "/rpc/abandon_cleanup": () => ok({}) });
    wrap(<ArchiveJob id="j1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Abandon" }));
    const sheet = within(screen.getByRole("dialog"));
    expect(sheet.getByText(/1 file\(s\) already deleted stay deleted/)).toBeInTheDocument();
    await userEvent.type(sheet.getByLabelText("Reason"), "Wrong period");
    await userEvent.click(sheet.getByRole("button", { name: "Abandon" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/rpc/abandon_cleanup")?.body).toEqual({ p_cleanup_job_id: "c1", p_reason: "Wrong period" }));
    const reconcile = calls.find((c) => c.path === "/archive/cleanup/c1")!;
    expect(reconcile.query.get("reconcile_only")).toBe("true");
    expect(calls.indexOf(reconcile)).toBeLessThan(calls.findIndex((c) => c.path === "/rpc/abandon_cleanup"));
  });
});
