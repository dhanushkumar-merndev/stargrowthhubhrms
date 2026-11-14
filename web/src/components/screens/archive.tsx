"use client";

// archive_screen.dart + archive_job_screen.dart: annual periods, export,
// in-browser ZIP build + acknowledgement, and the storage cleanup that the
// acknowledged archive unlocks.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { type BuiltArchive, type CleanupJob, type Manifest, type Progress, ArchiveError, buildArchive } from "@/lib/archive";
import { post, rpc } from "@/lib/api";
import { bytesLabel, storagePercent } from "@/lib/admin";
import { dayLabel } from "@/lib/attendance";
import { useSession } from "@/lib/session";
import { useRpc } from "@/lib/use-rpc";
import { SheetForm, Toggle, useAction } from "../forms";
import { withReauth } from "../reauth";
import { Banner, Button, EmptyState, ErrorState, KeyValue, LoadingState, PageTitle, SectionCard, StatusChip, TextArea, TextField } from "../ui";

const msg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

interface Period {
  id: string;
  kind: string;
  label: string;
  period_start: string;
  period_end: string;
  live_until: string | null;
  unlocks_on: string;
  closed: boolean;
  due: boolean;
  cleanup_running: boolean;
  jobs: Manifest[];
  cleanups: CleanupJob[];
}
interface Overview {
  today: string;
  timezone: string;
  annual_start_month: number;
  storage: { used_bytes: number; reserved_bytes: number; budget_bytes: number };
  periods: Period[];
}

export const JOB_STATE: Record<string, { label: string; tone: "success" | "info" | "warning" | "error" | "neutral" }> = {
  building: { label: "Preparing", tone: "info" },
  ready: { label: "Ready to save", tone: "info" },
  acknowledged: { label: "Saved", tone: "success" },
  partial: { label: "Partial", tone: "warning" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
  failed: { label: "Failed", tone: "error" },
};

export function ArchiveScreen() {
  const router = useRouter();
  const q = useRpc<Overview>("get_archive_overview", {});
  const a = useAction();
  const o = q.data;
  return (
    <>
      <PageTitle title="Annual archive" back="/explore" />
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-page">
        <p className="text-body-md text-text-secondary">After a year closes, save a verified ZIP of its records and files. Once saved, the cloud copies can be removed to free storage.</p>
        {a.error && <Banner>{a.error}</Banner>}
        {q.error ? (
          <ErrorState message={msg(q.error, "Could not load the archive.")} onRetry={() => q.mutate()} />
        ) : !o ? (
          <LoadingState />
        ) : (
          <>
            <SectionCard>
              <KeyValue k="Storage used" v={`${bytesLabel(o.storage.used_bytes + o.storage.reserved_bytes)} of ${bytesLabel(o.storage.budget_bytes)} (${storagePercent(o.storage.used_bytes, o.storage.reserved_bytes, o.storage.budget_bytes)}%)`} />
            </SectionCard>
            {o.periods.length === 0 ? (
              <EmptyState art="archive" title="No periods yet" body="The first period appears after your first year of records." />
            ) : (
              o.periods.map((p) => {
                const active = p.jobs.find((j) => ["building", "ready"].includes(j.state) && !j.stale);
                return (
                  <SectionCard key={p.id}>
                    <div className="mb-1 flex items-center gap-2">
                      <h2 className="flex-1 text-title-sm font-semibold">{p.label}</h2>
                      {p.due && <StatusChip label="Archive due" tone="warning" />}
                      {!p.closed && <StatusChip label="Open" tone="neutral" />}
                      {p.cleanup_running && <StatusChip label="Cleanup running" tone="info" />}
                    </div>
                    <p className="text-body-sm text-text-secondary">
                      {dayLabel(p.period_start)} – {dayLabel(p.period_end)}
                      {!p.closed ? ` · can be archived from ${dayLabel(p.unlocks_on)}` : ""}
                    </p>
                    {p.jobs.length > 0 && (
                      <ul className="mt-2 flex flex-col gap-1">
                        {p.jobs.map((j) => (
                          <li key={j.id}>
                            <Link href={`/admin/archive/${j.id}`} className="flex min-h-12 items-center gap-2 rounded-input px-2 hover:bg-background">
                              <span className="flex-1">Revision {j.revision}</span>
                              {j.stale && <StatusChip label="Out of date" tone="warning" />}
                              <StatusChip label={JOB_STATE[j.state]?.label ?? j.state} tone={JOB_STATE[j.state]?.tone ?? "neutral"} />
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                    {p.closed && !active && (
                      <Button
                        variant="outlined"
                        className="mt-2"
                        busy={a.busy}
                        onClick={() =>
                          a.run(async () => {
                            const j = await withReauth("export.annual", p.id, () => rpc<Manifest>("create_archive_export", { p_period_id: p.id }));
                            router.push(`/admin/archive/${j.id}`);
                          }, "Could not start the export.")
                        }
                      >
                        {p.jobs.length ? "Create a new export" : "Create export"}
                      </Button>
                    )}
                  </SectionCard>
                );
              })
            )}
          </>
        )}
      </div>
    </>
  );
}

interface Preview {
  confirm_label: string;
  checks: { key: string; ok: boolean; label: string; code?: string }[];
  item_count: number;
  total_bytes: number;
  employee_count: number;
  visible_payslips: number;
  kept: string[];
}

export function ArchiveJob({ id }: { id: string }) {
  const { context } = useSession();
  const q = useRpc<Manifest>("get_export_manifest", { p_job_id: id });
  const m = q.data;
  const cleanupId = m?.cleanup?.id ?? null;
  const cleanup = useRpc<CleanupJob>(cleanupId ? "get_cleanup_job" : null, { p_cleanup_job_id: cleanupId });
  const canPreview = !!m && (m.state === "acknowledged") && !m.stale && !m.cleanup_consumed && !cleanupId;
  const preview = useRpc<Preview>(canPreview ? "preview_cleanup" : null, { p_job_id: id });
  const [built, setBuilt] = useState<BuiltArchive | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [baseZip, setBaseZip] = useState<File | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [abandon, setAbandon] = useState<CleanupJob | null>(null);
  const [deleting, setDeleting] = useState(false);
  const signal = useRef({ cancelled: false });
  const stopDeleting = useRef(false);
  const cache = useRef(new Map<string, Uint8Array>());
  const a = useAction();

  const reload = async () => {
    await Promise.all([q.mutate(), cleanup.mutate(), preview.mutate()]);
  };

  const build = async (partial: boolean) => {
    if (!m) return;
    setError(null);
    setBuilt(null);
    setSaved(false);
    signal.current = { cancelled: false };
    try {
      setBuilt(await buildArchive(m, { baseZip, partial, cache: cache.current, signal: signal.current, onProgress: setProgress }));
    } catch (e) {
      setError(e instanceof ArchiveError || e instanceof Error ? e.message : "Could not build the archive.");
    } finally {
      setProgress(null);
    }
  };

  const download = () => {
    if (!built) return;
    const url = URL.createObjectURL(built.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = built.fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const runBatches = async (cid: string) => {
    setDeleting(true);
    stopDeleting.current = false;
    try {
      while (!stopDeleting.current) {
        const res = (await post<{ data: { busy?: boolean; done?: boolean; stalled?: boolean; retry_after_seconds?: number; job?: CleanupJob } }>(`/archive/cleanup/${cid}`)).data;
        if (res.busy) {
          await new Promise((r) => setTimeout(r, Math.min(30, Math.max(2, res.retry_after_seconds ?? 10)) * 1000));
          continue;
        }
        if (res.job) await cleanup.mutate(res.job, { revalidate: false });
        if (res.done || res.stalled || !res.job) break;
      }
    } catch (e) {
      setError(msg(e, "Cleanup stopped. Resume it to continue."));
    } finally {
      setDeleting(false);
      await reload();
    }
  };

  if (q.error) return <><PageTitle title="Archive export" back="/admin/archive" /><div className="p-page"><ErrorState message={msg(q.error, "Could not load this export.")} onRetry={() => q.mutate()} /></div></>;
  if (!m) return <><PageTitle title="Archive export" back="/admin/archive" /><LoadingState /></>;

  const c = cleanup.data ?? m.cleanup;
  const isDriver = !!c?.driver && c.driver.id === context?.employee.id;
  const p = preview.data;
  const needsBase = m.requires_local_base && m.local_base_count > 0;
  const live = m.state === "ready" && !m.stale;
  return (
    <>
      <PageTitle title={`${m.label} · r${m.revision}`} back="/admin/archive" />
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-page">
        {error && <Banner>{error}</Banner>}
        {a.error && <Banner>{a.error}</Banner>}
        {m.provisional && m.live_until && <Banner tone="warning">Provisional: a shift from this period can still be checked out until {new Date(m.live_until).toLocaleString("en-IN")}.</Banner>}
        {m.stale && <Banner tone="warning">{m.stale_reason ?? "Records changed"}. Create a new export for a complete archive.</Banner>}
        <SectionCard>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-title-sm font-semibold">Contents</h2>
            <StatusChip label={JOB_STATE[m.state]?.label ?? m.state} tone={JOB_STATE[m.state]?.tone ?? "neutral"} />
          </div>
          <KeyValue k="Period" v={`${dayLabel(m.period_start)} – ${dayLabel(m.period_end)}`} />
          <KeyValue k="Employees" v={String(m.employees.length)} />
          <KeyValue k="Files" v={`${m.file_count} · ${bytesLabel(m.total_bytes)}`} />
          {m.acknowledged_at && <KeyValue k="Saved" v={`${new Date(m.acknowledged_at).toLocaleString("en-IN")}${m.acknowledged_by ? ` by ${m.acknowledged_by.name}` : ""}`} />}
          {m.state === "partial" && <Banner tone="warning">Recorded as a PARTIAL archive: some earlier originals were not available. It is kept for reference and cannot unlock cleanup.</Banner>}
        </SectionCard>

        {live && (
          <SectionCard>
            <div className="flex flex-col gap-3">
              <h2 className="text-title-sm font-semibold">1. Build the ZIP</h2>
              <p className="text-body-md text-text-secondary">Every file is downloaded through an audited link, its fingerprint checked, and the finished ZIP read back and verified. Keep this page open until it finishes.</p>
              {needsBase && (
                <>
                  <p className="text-body-md">{m.local_base_count} earlier file(s) were already removed from the cloud. Choose the saved archive, revision {m.base?.revision}, to include them.</p>
                  <label className="text-body-md font-semibold text-primary">
                    <input type="file" accept=".zip,application/zip" aria-label="Previous archive" className="block" onChange={(e) => setBaseZip(e.target.files?.[0] ?? null)} />
                  </label>
                </>
              )}
              {progress ? (
                <>
                  <p role="status" className="text-body-md">
                    {progress.label}
                    {progress.total ? ` · ${progress.done} of ${progress.total}` : "…"}
                  </p>
                  {progress.total > 0 && <progress className="w-full" value={progress.done} max={progress.total} />}
                  <Button variant="outlined" onClick={() => (signal.current.cancelled = true)}>
                    Stop
                  </Button>
                </>
              ) : (
                <>
                  <Button disabled={needsBase && !baseZip} onClick={() => build(false)}>
                    {built ? "Build again" : "Build archive"}
                  </Button>
                  {needsBase && (
                    <Button variant="text" onClick={() => build(true)}>
                      Build a partial archive without earlier files
                    </Button>
                  )}
                </>
              )}
            </div>
          </SectionCard>
        )}

        {live && built && (
          <SectionCard>
            <div className="flex flex-col gap-3">
              <h2 className="text-title-sm font-semibold">2. Save it somewhere safe</h2>
              <Banner tone="success">
                Verified: {built.fileName} ({bytesLabel(built.blob.size)}), {built.includedFiles} file(s).
              </Banner>
              <Button variant="outlined" onClick={download}>
                Download ZIP
              </Button>
              <Toggle label="I saved the ZIP to a safe place outside this browser" checked={saved} onChange={setSaved} hint="Deleted cloud files can only ever be restored from this ZIP." />
              <Button
                disabled={!saved}
                busy={a.busy}
                onClick={() =>
                  a.run(async () => {
                    await rpc("acknowledge_export", {
                      p_job_id: m.id,
                      p_manifest_hash: built.manifestHash,
                      p_included_files: built.includedFiles,
                      p_included_bytes: built.includedBytes,
                      p_partial: built.partial,
                      p_missing_file_ids: built.partial ? built.missingIds : null,
                      p_saved: true,
                    });
                    await reload();
                  }, "Could not record the archive.")
                }
              >
                Confirm saved
              </Button>
            </div>
          </SectionCard>
        )}

        {live && !progress && (
          <Button
            variant="text"
            className="text-error"
            busy={a.busy}
            onClick={() =>
              a.run(async () => {
                await rpc("cancel_export", { p_job_id: m.id });
                await reload();
              }, "Could not cancel.")
            }
          >
            Cancel this export
          </Button>
        )}

        {p && (
          <SectionCard>
            <div className="flex flex-col gap-2">
              <h2 className="text-title-sm font-semibold">Free cloud storage</h2>
              <p className="text-body-md">
                {p.item_count} file(s), {bytesLabel(p.total_bytes)}, for {p.employee_count} employee(s) can be removed from cloud storage.
              </p>
              <ul className="flex flex-col gap-1" aria-label="Cleanup checks">
                {p.checks.map((ch) => (
                  <li key={ch.key} className={ch.ok ? "text-body-sm text-text-secondary" : "text-body-sm text-error"}>
                    {ch.ok ? "✓" : "✗"} {ch.label}
                  </li>
                ))}
              </ul>
              <Button variant="danger" disabled={p.checks.some((ch) => !ch.ok) || p.item_count === 0} onClick={() => setConfirmDelete(true)}>
                Delete cloud files
              </Button>
            </div>
          </SectionCard>
        )}

        {c && (
          <SectionCard>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h2 className="text-title-sm font-semibold">Cleanup</h2>
                <StatusChip label={c.state} tone={c.state === "completed" ? "success" : c.state === "abandoned" ? "neutral" : c.failed_items ? "warning" : "info"} />
              </div>
              <progress className="w-full" value={c.deleted_items} max={Math.max(1, c.total_items)} aria-label="Files deleted" />
              <p className="text-body-sm text-text-secondary">
                {c.deleted_items} of {c.total_items} deleted ({bytesLabel(c.deleted_bytes)})
                {c.failed_items ? ` · ${c.failed_items} failed` : ""}
                {c.driver ? ` · run by ${c.driver.name}` : ""}
              </p>
              {deleting ? (
                <Button variant="outlined" onClick={() => (stopDeleting.current = true)}>
                  Pause
                </Button>
              ) : (
                !["completed", "abandoned"].includes(c.state) && (
                  <div className="flex flex-wrap gap-3">
                    <Button
                      variant="outlined"
                      onClick={() =>
                        a.run(async () => {
                          if (!(isDriver && c.state === "running")) await withReauth("archive.cleanup", c.id, () => rpc("resume_cleanup", { p_cleanup_job_id: c.id }));
                          await runBatches(c.id);
                        }, "Could not resume.")
                      }
                    >
                      {isDriver && c.state === "running" ? "Continue" : "Resume"}
                    </Button>
                    <Button variant="text" className="text-error" onClick={() => setAbandon(c)}>
                      Abandon
                    </Button>
                  </div>
                )
              )}
            </div>
          </SectionCard>
        )}
      </div>

      {confirmDelete && p && (
        <ConfirmCleanup
          preview={p}
          onClose={() => setConfirmDelete(false)}
          onConfirm={async (label, acceptVisible) => {
            const job = await withReauth("archive.cleanup", m.id, () => rpc<CleanupJob>("begin_cleanup", { p_job_id: m.id, p_manifest_hash: m.manifest_hash, p_confirm_label: label, p_accept_visible_loss: acceptVisible }));
            setConfirmDelete(false);
            await q.mutate();
            await runBatches(job.id);
          }}
        />
      )}
      {abandon && (
        <AbandonSheet
          job={abandon}
          isDriver={isDriver}
          onClose={() => setAbandon(null)}
          onSaved={async () => {
            setAbandon(null);
            await reload();
          }}
        />
      )}
    </>
  );
}

function ConfirmCleanup({ preview, onClose, onConfirm }: { preview: Preview; onClose: () => void; onConfirm: (label: string, acceptVisible: boolean) => Promise<void> }) {
  const [typed, setTyped] = useState("");
  const [acceptVisible, setAcceptVisible] = useState(preview.visible_payslips === 0);
  const [acceptLocal, setAcceptLocal] = useState(false);
  const a = useAction();
  const ready = typed.trim().toUpperCase() === preview.confirm_label.toUpperCase() && acceptVisible && acceptLocal;
  return (
    <SheetForm
      title="Delete cloud files?"
      submit="Delete files"
      busy={a.busy}
      error={a.error}
      onClose={onClose}
      onSubmit={() => {
        if (!ready) return a.setError(`Tick both boxes and type ${preview.confirm_label} to confirm.`);
        a.run(() => onConfirm(typed.trim(), acceptVisible), "Could not start the cleanup.");
      }}
    >
      <p className="text-body-md">
        {preview.item_count} file(s), {bytesLabel(preview.total_bytes)}, for {preview.employee_count} employee(s) will be permanently removed from cloud storage. This cannot be undone from the app.
      </p>
      {preview.kept.length > 0 && <p className="text-body-sm text-text-secondary">Kept: {preview.kept.join(", ")}.</p>}
      {preview.visible_payslips > 0 && <Toggle label={`${preview.visible_payslips} recent payslip(s) will remain listed as archived and cannot be downloaded from the app.`} checked={acceptVisible} onChange={setAcceptVisible} />}
      <Toggle label="I keep the saved archive safe. Deleted files can only be restored from it." checked={acceptLocal} onChange={setAcceptLocal} />
      <TextField label={`Type ${preview.confirm_label} to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
    </SheetForm>
  );
}

function AbandonSheet({ job, isDriver, onClose, onSaved }: { job: CleanupJob; isDriver: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const [reason, setReason] = useState("");
  const a = useAction();
  return (
    <SheetForm
      title="Abandon this cleanup?"
      submit="Abandon"
      busy={a.busy}
      error={a.error}
      onClose={onClose}
      onSubmit={() => {
        if (reason.trim().length < 3) return a.setError("Give a reason.");
        a.run(async () => {
          if (isDriver && job.in_flight_items > 0) await post(`/archive/cleanup/${job.id}?reconcile_only=true`);
          await rpc("abandon_cleanup", { p_cleanup_job_id: job.id, p_reason: reason.trim() });
          await onSaved();
        }, "Could not abandon.");
      }}
    >
      <p className="text-body-md">
        {job.deleted_items} file(s) already deleted stay deleted; they exist only in your saved archive. The other {job.total_items - job.deleted_items} file(s) are kept and the period is unlocked for changes. Another cleanup will need a new complete archive.
      </p>
      <TextArea label="Reason" value={reason} onChange={setReason} maxLength={500} />
    </SheetForm>
  );
}
