"use client";

import { useState, type FormEvent } from "react";
import { ApiError, rpc } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useRpc } from "@/lib/use-rpc";
import { FileViewer } from "../files";
import { Banner, Button, ErrorState, LoadingState, PageTitle, SectionCard } from "../ui";
import { DocumentList, type DocItem } from "./payroll";

interface PolicyReview {
  rules: string[];
  documents: DocItem[];
  revision: string;
}

export function PolicyAcknowledgement() {
  const { context, refresh, logout } = useSession();
  const review = useRpc<PolicyReview>("get_company_policy_review");
  const [open, setOpen] = useState<DocItem | null>(null);
  const [agreedRevision, setAgreedRevision] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const data = review.data;
  const agreed = !!data && agreedRevision === data.revision;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!data || !agreed || busy || review.error) return;
    setBusy(true);
    setError(null);
    try {
      await rpc("acknowledge_company_policies", { p_revision: data.revision });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save your acknowledgement. Try again.");
      if (err instanceof ApiError && err.code === "STALE_VERSION") {
        setAgreedRevision(null);
        void review.mutate().catch(() => undefined);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-dvh bg-surface">
      <PageTitle title="Company policies and terms" action={
        <Button type="button" variant="text" disabled={busy} onClick={() => void logout().catch(() => undefined)}>Sign out</Button>
      } />
      <div className="mx-auto max-w-2xl p-page">
        {review.error ? (
          <ErrorState message={review.error.message} onRetry={() => review.mutate()} />
        ) : !data ? <LoadingState /> : (
          <div className="flex flex-col gap-4">
            <p className="text-body-md text-text-secondary">Review the workplace rules and published policies for {context?.org.name ?? "your company"} before continuing.</p>
            <SectionCard>
              <h2 className="text-title-md font-semibold">Office attendance and working hours</h2>
              <ul className="mt-2 list-disc space-y-2 pl-5 text-body-md">
                {data.rules.map((rule) => <li key={rule}>{rule}</li>)}
              </ul>
            </SectionCard>
            <section className="flex flex-col gap-2">
              <h2 className="text-title-md font-semibold">Published company policies</h2>
              <DocumentList items={data.documents} emptyTitle="No additional policies have been published" onOpen={setOpen} />
            </section>
            <form onSubmit={submit} className="flex flex-col gap-4">
              <label className="flex items-start gap-3 rounded-card border border-border p-card text-body-md">
                <input
                  type="checkbox"
                  className="mt-0.5 size-5 shrink-0 accent-primary"
                  checked={agreed}
                  disabled={busy}
                  onChange={(e) => setAgreedRevision(e.target.checked ? data.revision : null)}
                />
                <span>I have read and acknowledge the company rules and published policies above.</span>
              </label>
              {error && <Banner>{error}</Banner>}
              <Button type="submit" busy={busy} disabled={!agreed}>Acknowledge and continue</Button>
            </form>
          </div>
        )}
      </div>
      {open?.file_version_id && <FileViewer versionId={open.file_version_id} title={open.title || "Company policy"} onClose={() => setOpen(null)} />}
    </main>
  );
}
