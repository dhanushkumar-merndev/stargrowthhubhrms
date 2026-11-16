"use client";

// notifications_screen.dart (inbox) + the new push setup and preferences.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { rpc } from "@/lib/api";
import { useLive } from "@/lib/live";
import { type Notice, type PushSupport, CATEGORIES, PushSetupError, ago, currentEnv, disablePush, enablePush, pushEnabledHere, pushSupport, quietErrors, safeLink, sendTest } from "@/lib/push";
import { useRpc } from "@/lib/use-rpc";
import { Toggle, useAction } from "../forms";
import { Banner, Button, EmptyState, ErrorState, LoadingState, PageTitle, SectionCard, TextField, cx } from "../ui";

interface Page {
  unread: number;
  rows: Notice[];
}
const PAGE = 25;
const noop = () => () => undefined;

/** Unread count for the bell; refreshed live. */
export function useUnread(): number {
  const q = useRpc<Page>("list_notifications", { p_before_created_at: null, p_before_id: null, p_limit: 1 });
  useLive(["notification.new"], () => void q.mutate());
  return q.data?.unread ?? 0;
}

export function BellBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span aria-label={`${count} unread`} className="absolute right-1.5 top-1.5 grid min-w-[18px] place-items-center rounded-full bg-error px-1 text-[11px] font-semibold leading-[18px] text-white">
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function NotificationsScreen({ now = new Date() }: { now?: Date }) {
  const router = useRouter();
  const q = useRpc<Page>("list_notifications", { p_before_created_at: null, p_before_id: null, p_limit: PAGE });
  const [older, setOlder] = useState<Notice[]>([]);
  const [end, setEnd] = useState(false);
  const [more, setMore] = useState(false);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  useLive(["notification.new"], () => void q.mutate());
  const rows = [...(q.data?.rows ?? []), ...older.filter((o) => !(q.data?.rows ?? []).some((r) => r.id === o.id))];
  const isRead = (n: Notice) => !!n.read_at || readIds.has(n.id);
  const unread = Math.max(0, (q.data?.unread ?? 0) - rows.filter((n) => !n.read_at && readIds.has(n.id)).length);
  const last = rows[rows.length - 1];

  const open = async (n: Notice) => {
    if (!isRead(n)) {
      setReadIds(new Set(readIds).add(n.id));
      rpc("mark_notifications_read", { p_ids: [n.id] }).catch(() => undefined);
    }
    router.push(safeLink(n.deep_link));
  };

  return (
    <>
      <PageTitle
        title="Notifications"
        back="/home"
        action={
          unread > 0 ? (
            <Button
              variant="text"
              onClick={async () => {
                setError(null);
                try {
                  await rpc("mark_notifications_read", { p_ids: null });
                  setReadIds(new Set(rows.map((r) => r.id)));
                  await q.mutate();
                } catch {
                  setError("Could not mark them as read.");
                }
              }}
            >
              Mark all read
            </Button>
          ) : undefined
        }
      />
      <div className="mx-auto flex max-w-xl md:max-w-3xl lg:max-w-5xl flex-col gap-3 p-page">
        <Link href="/settings/notifications" className="text-body-md font-semibold text-primary">
          Notification settings
        </Link>
        {error && <Banner>{error}</Banner>}
        {q.error ? (
          <ErrorState message="Could not load notifications." onRetry={() => void q.mutate()} />
        ) : !q.data ? (
          <LoadingState />
        ) : rows.length === 0 ? (
          <EmptyState art="notifications" title="You're all caught up" body="Approvals, payslips and announcements show up here." />
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((n) => (
              <li key={n.id}>
                <button type="button" onClick={() => void open(n)} className={cx("flex w-full items-start gap-3 rounded-card border border-border p-card text-left", isRead(n) ? "bg-surface" : "bg-attendance-card")}>
                  <span aria-hidden className={cx("mt-1.5 size-2.5 shrink-0 rounded-full", isRead(n) ? "bg-transparent" : "bg-primary")} />
                  <span className="min-w-0 flex-1">
                    <span className={cx("block", isRead(n) ? "font-medium" : "font-semibold")}>
                      {n.title}
                      {!isRead(n) && <span className="sr-only"> (unread)</span>}
                    </span>
                    {n.body && <span className="mt-0.5 block text-body-md text-text-secondary">{n.body}</span>}
                    <span className="mt-1 block text-body-sm text-text-secondary">{ago(n.created_at, now)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {q.data && q.data.rows.length >= PAGE && !end && last && (
          <Button
            variant="outlined"
            busy={more}
            onClick={async () => {
              setMore(true);
              try {
                const next = await rpc<Page>("list_notifications", { p_before_created_at: last.created_at, p_before_id: last.id, p_limit: PAGE });
                setOlder([...older, ...next.rows]);
                if (next.rows.length < PAGE) setEnd(true);
              } catch {
                setError("Could not load older notifications.");
              } finally {
                setMore(false);
              }
            }}
          >
            Load older
          </Button>
        )}
      </div>
    </>
  );
}

interface Prefs {
  muted: string[];
  quiet_start: string | null;
  quiet_end: string | null;
  timezone: string;
  devices: number;
}

const SUPPORT_TEXT: Record<Exclude<PushSupport, "ok">, string> = {
  unsupported: "This browser cannot show notifications. Use Chrome, Edge, Firefox or Safari.",
  "ios-needs-install": "On iPhone and iPad, add HRMS to your Home Screen first (Share → Add to Home Screen), then open it from there to turn on notifications.",
  denied: "Notifications are blocked for this site. Allow them in your browser's site settings, then come back.",
};

export function NotificationSettings({ support: forced }: { support?: PushSupport }) {
  const q = useRpc<Prefs>("get_notification_prefs", {});
  // Browser capabilities: null while server-rendering, then the real answer.
  const detected = useSyncExternalStore(noop, () => pushSupport(currentEnv()), () => null);
  const support = forced ?? detected;
  const [here, setHere] = useState<boolean | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const device = useAction();
  useEffect(() => {
    let live = true;
    pushEnabledHere().then((v) => live && setHere(v));
    return () => {
      live = false;
    };
  }, []);

  return (
    <>
      <PageTitle title="Notification settings" back="/notifications" />
      <div className="mx-auto flex max-w-xl md:max-w-3xl lg:max-w-5xl flex-col gap-4 p-page">
        {notice && <Banner tone="success">{notice}</Banner>}
        <SectionCard>
          <div className="flex flex-col gap-3">
            <h2 className="text-title-md font-semibold">This device</h2>
            {device.error && <Banner>{device.error}</Banner>}
            {support && support !== "ok" ? (
              <Banner tone="info">{SUPPORT_TEXT[support]}</Banner>
            ) : here ? (
              <>
                <p className="text-body-md">Notifications are on for this browser.</p>
                <div className="flex flex-wrap gap-3">
                  <Button
                    variant="outlined"
                    busy={device.busy}
                    onClick={() =>
                      device.run(async () => {
                        await sendTest();
                        setNotice("Test sent. It should arrive in a few seconds.");
                      }, "Could not send a test.")
                    }
                  >
                    Send a test
                  </Button>
                  <Button
                    variant="text"
                    onClick={() =>
                      device.run(async () => {
                        await disablePush();
                        setHere(false);
                        setNotice("Notifications are off for this browser.");
                        await q.mutate();
                      }, "Could not turn notifications off.")
                    }
                  >
                    Turn off
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-body-md text-text-secondary">Get approvals, payslips and announcements even when HRMS is closed.</p>
                <Button
                  busy={device.busy}
                  disabled={here === null && !forced}
                  onClick={() =>
                    device.run(async () => {
                      try {
                        await enablePush();
                      } catch (e) {
                        if (e instanceof PushSetupError) throw e;
                        throw new Error("Could not turn on notifications. Try again.");
                      }
                      setHere(true);
                      setNotice("Notifications are on for this browser.");
                      await q.mutate();
                    }, "Could not turn on notifications.")
                  }
                >
                  Turn on notifications
                </Button>
              </>
            )}
            {q.data && <p className="text-body-sm text-text-secondary">Signed-in devices with notifications: {q.data.devices}</p>}
          </div>
        </SectionCard>
        {q.error ? <ErrorState message="Could not load your settings." onRetry={() => void q.mutate()} /> : !q.data ? <LoadingState /> : <PrefsForm key={JSON.stringify(q.data)} prefs={q.data} saved={saved} onSaved={async () => { await q.mutate(); setSaved(true); }} onEdit={() => setSaved(false)} />}
      </div>
    </>
  );
}

function PrefsForm({ prefs, saved, onSaved, onEdit }: { prefs: Prefs; saved: boolean; onSaved: () => Promise<void>; onEdit: () => void }) {
  const [muted, setMuted] = useState(new Set(prefs.muted));
  const [start, setStart] = useState(prefs.quiet_start ?? "");
  const [end, setEnd] = useState(prefs.quiet_end ?? "");
  const a = useAction();
  const quiet = quietErrors(start, end);
  return (
    <SectionCard>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          onEdit();
          if (quiet) return a.setError(quiet);
          a.run(async () => {
            await rpc("set_notification_prefs", { p_muted: [...muted].sort(), p_quiet_start: start || null, p_quiet_end: end || null });
            await onSaved();
          }, "Could not save.");
        }}
      >
        <h2 className="text-title-md font-semibold">What to send</h2>
        <p className="text-body-sm text-text-secondary">Everything still appears in the app. These only control pop-up notifications. Security notices are always sent.</p>
        {saved && <Banner tone="success">Saved.</Banner>}
        {a.error && <Banner>{a.error}</Banner>}
        {CATEGORIES.map((c) => (
          <Toggle
            key={c.id}
            label={c.label}
            checked={!muted.has(c.id)}
            onChange={(on) => {
              const next = new Set(muted);
              if (on) next.delete(c.id);
              else next.add(c.id);
              setMuted(next);
            }}
          />
        ))}
        <h2 className="mt-2 text-title-md font-semibold">Quiet hours</h2>
        <p className="text-body-sm text-text-secondary">No pop-ups between these times ({prefs.timezone}). Leave both empty to turn off.</p>
        <div className="grid grid-cols-2 gap-3">
          <TextField label="From" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          <TextField label="To" type="time" value={end} onChange={(e) => setEnd(e.target.value)} error={quiet ?? a.fields.quiet_end} />
        </div>
        <Button type="submit" busy={a.busy}>
          Save
        </Button>
      </form>
    </SectionCard>
  );
}
