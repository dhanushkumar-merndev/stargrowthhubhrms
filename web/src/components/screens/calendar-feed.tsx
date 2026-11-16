"use client";

// Subscribe to holidays and your own approved leave from Google Calendar,
// Outlook or Apple Calendar. The link is secret; it is shown once.

import { useState } from "react";
import { rpc } from "@/lib/api";
import { useRpc } from "@/lib/use-rpc";
import { useAction } from "../forms";
import { Banner, Button, ErrorState, LoadingState, PageTitle, SectionCard, TextField } from "../ui";

interface Feed {
  enabled: boolean;
  created_at: string | null;
  last_used_at: string | null;
  token?: string;
}

/** https://host/api/v1/calendar/<token>.ics */
export function feedUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/api/v1/calendar/${encodeURIComponent(token)}.ics`;
}
/** Same address with webcal:// so the phone opens its calendar app. */
export const webcalUrl = (url: string) => url.replace(/^https?:\/\//, "webcal://");

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "never");

export function CalendarFeed({ origin }: { origin?: string }) {
  const q = useRpc<Feed>("get_calendar_feed", {});
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const a = useAction();
  const base = origin ?? (typeof window === "undefined" ? "" : window.location.origin);

  const create = () =>
    a.run(async () => {
      const f = await rpc<Feed>("create_calendar_feed", {});
      if (!f.token) throw new Error("No link came back. Try again.");
      setUrl(feedUrl(base, f.token));
      setCopied(false);
      setConfirm(false);
      await q.mutate();
    }, "Could not create the link.");

  return (
    <>
      <PageTitle title="Calendar subscription" back="/settings" />
      <div className="mx-auto flex max-w-xl md:max-w-2xl flex-col gap-4 p-page">
        <p className="text-body-md text-text-secondary">See company holidays and your approved leave in Google Calendar, Outlook or Apple Calendar. Calendar apps refresh it every few hours.</p>
        {a.error && <Banner>{a.error}</Banner>}
        {q.error ? (
          <ErrorState message="Could not load your calendar link." onRetry={() => void q.mutate()} />
        ) : !q.data ? (
          <LoadingState />
        ) : (
          <SectionCard>
            <div className="flex flex-col gap-3">
              {url ? (
                <>
                  <Banner tone="success">Your link is ready. Copy it now: for your safety it is shown only once.</Banner>
                  <TextField label="Calendar link" value={url} readOnly onFocus={(e) => e.currentTarget.select()} />
                  <div className="flex flex-wrap gap-3">
                    <Button
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(url);
                          setCopied(true);
                        } catch {
                          a.setError("Could not copy. Select the link and copy it yourself.");
                        }
                      }}
                    >
                      {copied ? "Copied" : "Copy link"}
                    </Button>
                    <a href={webcalUrl(url)} className="inline-flex min-h-12 items-center rounded-full px-4 font-semibold text-primary">
                      Open in calendar app
                    </a>
                  </div>
                  <p className="text-body-sm text-text-secondary">In Google Calendar: Other calendars → + → From URL, then paste. Anyone with this link can see your holidays and leave days, so do not share it.</p>
                </>
              ) : q.data.enabled ? (
                <>
                  <p className="text-body-md">Your calendar link is on.</p>
                  <p className="text-body-sm text-text-secondary">
                    Created {when(q.data.created_at)} · last used {when(q.data.last_used_at)}
                  </p>
                  <p className="text-body-sm text-text-secondary">Lost the link? Make a new one. The old link stops working straight away.</p>
                </>
              ) : (
                <p className="text-body-md">You have no calendar link yet.</p>
              )}
              {confirm ? (
                <div className="flex flex-col gap-2 rounded-row bg-background p-3">
                  <p className="text-body-md">Make a new link? Calendars using the old link will stop updating until you add the new one.</p>
                  <div className="flex gap-3">
                    <Button busy={a.busy} onClick={create}>
                      Make new link
                    </Button>
                    <Button variant="text" onClick={() => setConfirm(false)}>
                      Keep the old one
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-3">
                  {!q.data.enabled ? (
                    <Button busy={a.busy} onClick={create}>
                      Create calendar link
                    </Button>
                  ) : (
                    <>
                      <Button variant="outlined" onClick={() => setConfirm(true)}>
                        Make a new link
                      </Button>
                      <Button
                        variant="text"
                        busy={a.busy}
                        onClick={() =>
                          a.run(async () => {
                            await rpc("revoke_calendar_feed", {});
                            setUrl(null);
                            await q.mutate();
                          }, "Could not turn the link off.")
                        }
                      >
                        Turn off
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          </SectionCard>
        )}
      </div>
    </>
  );
}
