"use client";

// The punch flow around the attendance machines:
//   /attendance/today         the person's day (opened from the punch push)
//   /attendance/outdoor/new   outdoor punch-in with a reason and a photo
//   /attendance/outdoor       outdoor punch-ins (HR, Admin, team leaders)
//   /attendance/fixes         punch fix requests (HR/Admin review; own for others)

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { rpc } from "@/lib/api";
import { todayIn } from "@/lib/attendance";
import { fetchFile, uploadFile } from "@/lib/files";
import {
  FIX_STATUS,
  OUT_SOURCE,
  type FixForm,
  type Outdoor,
  type PunchDay,
  type PunchFix,
  type PunchOutForm,
  clockIn,
  fixErrors,
  needsReason,
  niceTime,
  outdoorErrors,
  punchOutErrors,
  roughLocation,
  shrinkPhoto,
} from "@/lib/punch-day";
import { useSession } from "@/lib/session";
import { addDays, minutesLabel } from "@/lib/tasks";
import { useRpc } from "@/lib/use-rpc";
import { useAction } from "../forms";
import { Banner, Button, EmptyState, ErrorState, LoadingState, PageTitle, PillTabs, SectionCard, Sheet, StatusChip, TextArea, TextField, cx } from "../ui";

const msg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const dayNice = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

function useZone(now?: Date) {
  const { context } = useSession();
  const tz = context?.org.timezone ?? "Asia/Kolkata";
  const at = now ?? new Date();
  return { tz, today: todayIn(tz, at), nowClock: clockIn(at.toISOString(), tz) };
}

/* ─────────────────────────────── My day ─────────────────────────────── */

export function MyPunchDay({ initialDate, now }: { initialDate?: string; now?: Date }) {
  const { tz, today, nowClock } = useZone(now);
  const [date, setDate] = useState(initialDate && initialDate <= today ? initialDate : today);
  const q = useRpc<PunchDay>("get_my_punch_day", { p_date: date });
  const [sheet, setSheet] = useState<"out" | "fix" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const a = useAction();
  const days = [0, 1, 2].map((n) => addDays(today, -n));

  const body = () => {
    if (q.error) return <ErrorState message={msg(q.error, "Could not load your day.")} onRetry={() => void q.mutate()} />;
    if (!q.data) return <LoadingState />;
    const p = q.data;
    const d = p.day;
    return (
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex flex-col gap-3">
          {notice && <Banner tone="success">{notice}</Banner>}
          {a.error && <Banner>{a.error}</Banner>}
          {d ? (
            <SectionCard>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-body-sm text-text-secondary">Punch in</p>
                  <p className="text-headline-sm font-semibold">{niceTime(d.first_in_at, tz)}</p>
                  <p className="text-body-sm text-text-secondary">
                    {d.in_corrected ? `Fixed by HR (machine said ${niceTime(d.machine_in_at, tz)})` : d.machine ? `At ${d.machine}` : "At the machine"}
                  </p>
                </div>
                <div>
                  <p className="text-body-sm text-text-secondary">Punch out</p>
                  <p className={cx("text-headline-sm font-semibold", !d.out_at && "text-text-secondary")}>{d.out_at && d.out_source !== "auto" ? niceTime(d.out_at, tz) : "—"}</p>
                  <p className="text-body-sm text-text-secondary">{d.out_source ? OUT_SOURCE[d.out_source] : p.is_today ? "Not yet" : "Missing"}</p>
                </div>
              </div>
              {d.worked_minutes != null && <p className="mt-3 text-body-md">Worked {minutesLabel(d.worked_minutes) || "under 1 m"}</p>}
              {d.app_out_reason && d.out_source === "app" && <p className="mt-1 text-body-sm text-text-secondary">Your reason: {d.app_out_reason}</p>}
            </SectionCard>
          ) : p.outdoor ? null : (
            <EmptyState
              art="fingerprint"
              title={p.is_today ? "Not punched in yet" : "No punch that day"}
              body={p.has_machines ? "Punch in at the attendance machine. Working outside today? Punch in for outdoor work below." : "Check in from the app."}
            />
          )}

          {p.outdoor && <OutdoorCard o={p.outdoor} tz={tz} />}

          {p.fix && (
            <SectionCard>
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-semibold">Fix request</h2>
                <StatusChip label={FIX_STATUS[p.fix.status].label} tone={FIX_STATUS[p.fix.status].tone} />
              </div>
              <p className="mt-1 text-body-md">
                {[p.fix.in_at && `In ${niceTime(p.fix.in_at, tz)}`, p.fix.out_at && `Out ${niceTime(p.fix.out_at, tz)}`].filter(Boolean).join(" · ")}
              </p>
              <p className="text-body-md text-text-secondary">{p.fix.reason}</p>
              {p.fix.review_note && <p className="mt-1 text-body-md">HR: {p.fix.review_note}</p>}
              {p.fix.can_withdraw && (
                <Button
                  variant="text"
                  busy={a.busy}
                  onClick={() =>
                    a.run(async () => {
                      await rpc("withdraw_punch_fix", { p_id: p.fix!.id });
                      setNotice("Request withdrawn.");
                      await q.mutate();
                    }, "Could not withdraw.")
                  }
                >
                  Withdraw
                </Button>
              )}
            </SectionCard>
          )}
        </div>

        <aside className="flex flex-col gap-2" aria-label="Actions">
          {p.can_app_out && (
            <Button onClick={() => setSheet("out")}>{p.is_today ? "Punch out" : "Set my punch-out"}</Button>
          )}
          {p.can_outdoor_in && (
            <Link href="/attendance/outdoor/new" className="inline-flex min-h-12 items-center justify-center rounded-button border border-primary px-4 font-semibold text-primary">
              Punch in for outdoor work
            </Link>
          )}
          {p.can_request_fix && (
            <Button variant="outlined" onClick={() => setSheet("fix")}>
              A time is wrong? Ask HR to fix it
            </Button>
          )}
          {!p.has_machines && p.is_today && !d && (
            <Link href="/punch" className="inline-flex min-h-12 items-center justify-center rounded-button px-4 font-semibold text-primary">
              Check in from the app
            </Link>
          )}
          <Link href={`/attendance/${p.date}`} className="inline-flex min-h-10 items-center justify-center px-4 text-body-md text-primary">
            Full day details
          </Link>
        </aside>

        {sheet === "out" && (
          <PunchOutSheet
            day={p}
            tz={tz}
            nowClock={nowClock}
            onClose={() => setSheet(null)}
            onDone={async (t) => {
              setSheet(null);
              setNotice(`Punched out at ${t}.`);
              await q.mutate();
            }}
          />
        )}
        {sheet === "fix" && (
          <FixSheet
            day={p}
            tz={tz}
            onClose={() => setSheet(null)}
            onDone={async () => {
              setSheet(null);
              setNotice("Sent to HR. You will be told when it is handled.");
              await q.mutate();
            }}
          />
        )}
      </div>
    );
  };

  return (
    <>
      <PageTitle title="My punch" back="/home" />
      <div className="mx-auto flex max-w-4xl flex-col gap-3 p-page">
        <PillTabs
          label="Day"
          tabs={days.map((d, i) => ({ id: d, label: i === 0 ? "Today" : i === 1 ? "Yesterday" : dayNice(d) }))}
          value={days.includes(date) ? date : today}
          onChange={(d) => {
            setNotice(null);
            setDate(d);
          }}
        />
        {body()}
      </div>
    </>
  );
}

function OutdoorCard({ o, tz }: { o: Outdoor; tz: string }) {
  return (
    <SectionCard>
      <div className="flex items-start justify-between gap-2">
        <h2 className="font-semibold">Outdoor work</h2>
        <StatusChip label={o.status === "counted" ? "Counts" : "Rejected"} tone={o.status === "counted" ? "success" : "error"} />
      </div>
      <p className="mt-1 text-body-md">
        In {niceTime(o.punch_in_at, tz)}
        {o.punch_out_at ? ` · Out ${niceTime(o.punch_out_at, tz)}` : ""}
      </p>
      <p className="text-body-md text-text-secondary">{o.reason}</p>
      {o.status === "rejected" && (
        <p className="mt-1 text-body-md text-error">
          Rejected{o.rejected_by ? ` by ${o.rejected_by}` : ""}: {o.reject_reason}
        </p>
      )}
    </SectionCard>
  );
}

function PunchOutSheet({ day, tz, nowClock, onClose, onDone }: { day: PunchDay; tz: string; nowClock: string; onClose: () => void; onDone: (time: string) => Promise<void> }) {
  const [f, setF] = useState<PunchOutForm>({ time: "", reason: "" });
  const [errors, setErrors] = useState<Partial<Record<keyof PunchOutForm, string>>>({});
  const a = useAction();
  const inAt = day.day?.first_in_at ?? day.outdoor?.punch_in_at ?? null;
  const o = { isToday: day.is_today, nowClock, inClock: clockIn(inAt, tz) };
  const reason = needsReason(f, o);
  return (
    <Sheet title={day.is_today ? "Punch out" : `Punch-out for ${dayNice(day.date)}`} onClose={onClose}>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const errs = punchOutErrors(f, o);
          setErrors(errs);
          if (Object.keys(errs).length) return;
          void a.run(async () => {
            const r = await rpc<{ out_at: string }>("app_punch_out", { p_date: day.date, p_out_time: f.time || null, p_reason: f.reason.trim() || null });
            await onDone(niceTime(r.out_at, tz));
          }, "Could not punch out.");
        }}
      >
        {a.error && <Banner>{a.error}</Banner>}
        <p className="text-body-md text-text-secondary">
          {day.is_today ? "Leave the time empty to punch out now." : "Enter the time you left."} You punched in at {niceTime(inAt, tz)}.
        </p>
        <TextField label={day.is_today ? "Time (optional)" : "Time you left"} type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} error={errors.time} />
        {reason && <TextArea label="Why the earlier time?" value={f.reason} maxLength={300} rows={2} onChange={(v) => setF({ ...f, reason: v })} error={errors.reason} hint="HR and your team leader will see this." />}
        <Button type="submit" busy={a.busy}>
          {f.time ? `Punch out at ${f.time}` : "Punch out now"}
        </Button>
      </form>
    </Sheet>
  );
}

function FixSheet({ day, tz, onClose, onDone }: { day: PunchDay; tz: string; onClose: () => void; onDone: () => Promise<void> }) {
  const [f, setF] = useState<FixForm>({ in_time: "", out_time: "", reason: "" });
  const [errors, setErrors] = useState<Partial<Record<keyof FixForm, string>>>({});
  const a = useAction();
  return (
    <Sheet title="Ask HR to fix a time" onClose={onClose}>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const errs = fixErrors(f);
          setErrors(errs);
          if (Object.keys(errs).length) return;
          void a.run(async () => {
            await rpc("request_punch_fix", { p_date: day.date, p_in_time: f.in_time || null, p_out_time: f.out_time || null, p_reason: f.reason.trim() });
            await onDone();
          }, "Could not send the request.");
        }}
      >
        {a.error && <Banner>{a.error}</Banner>}
        <p className="text-body-md text-text-secondary">
          Recorded: in {niceTime(day.day?.first_in_at, tz) || "—"}, out {day.day?.out_at && day.day.out_source !== "auto" ? niceTime(day.day.out_at, tz) : "—"}. Fill only the time that is wrong.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Right punch-in" type="time" value={f.in_time} onChange={(e) => setF({ ...f, in_time: e.target.value })} error={errors.in_time} />
          <TextField label="Right punch-out" type="time" value={f.out_time} onChange={(e) => setF({ ...f, out_time: e.target.value })} error={errors.out_time} />
        </div>
        <TextArea label="What went wrong?" value={f.reason} maxLength={500} rows={3} onChange={(v) => setF({ ...f, reason: v })} error={errors.reason} />
        <Button type="submit" busy={a.busy}>
          Send to HR
        </Button>
      </form>
    </Sheet>
  );
}

/* ───────────────────────────── Outdoor punch-in ───────────────────────────── */

export function OutdoorPunchIn({ locate = roughLocation }: { locate?: typeof roughLocation }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<"reason" | "photo", string>>>({});
  const [step, setStep] = useState<string | null>(null);
  const a = useAction();
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);
  const pick = (f: File | null) => {
    setPhoto(f);
    setPreview(f && typeof URL.createObjectURL === "function" ? URL.createObjectURL(f) : null);
  };
  return (
    <>
      <PageTitle title="Outdoor punch-in" back="/attendance/today" />
      <form
        noValidate
        className="mx-auto flex max-w-xl flex-col gap-3 p-page"
        onSubmit={(e) => {
          e.preventDefault();
          const errs = outdoorErrors({ reason, photo });
          setErrors(errs);
          if (Object.keys(errs).length) return;
          void a.run(async () => {
            try {
              setStep("Getting your location…");
              const [where, small] = await Promise.all([locate(), shrinkPhoto(photo!)]);
              setStep("Uploading the photo…");
              const ver = await uploadFile(small, { cls: "correction_attachment" });
              setStep("Punching in…");
              await rpc("outdoor_punch_in", {
                p_reason: reason.trim(),
                p_photo_file_version_id: ver,
                p_latitude: where?.latitude ?? null,
                p_longitude: where?.longitude ?? null,
              });
              router.push("/attendance/today");
            } finally {
              setStep(null);
            }
          }, "Could not punch in.");
        }}
      >
        <p className="text-body-md text-text-secondary">For work away from the office today. It counts straight away; HR or your team leader can reject it if it is not right.</p>
        {a.error && <Banner>{a.error}</Banner>}
        <TextArea label="Where are you, and what is the work?" value={reason} maxLength={500} rows={3} onChange={setReason} error={errors.reason} />
        <div className="flex flex-col gap-2">
          <label htmlFor="outdoor-photo" className="font-semibold">
            Photo as proof
          </label>
          <input
            id="outdoor-photo"
            type="file"
            accept="image/jpeg,image/png,image/*"
            capture="environment"
            className="text-body-md file:mr-3 file:min-h-10 file:rounded-button file:border-0 file:bg-primary file:px-4 file:font-semibold file:text-white"
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
            aria-describedby={errors.photo ? "outdoor-photo-error" : undefined}
          />
          {errors.photo && (
            <p id="outdoor-photo-error" className="text-body-sm text-error">
              {errors.photo}
            </p>
          )}
          {/* eslint-disable-next-line @next/next/no-img-element -- local preview of a blob URL */}
          {preview && <img src={preview} alt="Your photo" className="max-h-72 w-full rounded-card object-contain" />}
        </div>
        <p className="text-body-sm text-text-secondary">Your location is added when your browser allows it.</p>
        <Button type="submit" busy={a.busy}>
          {step ?? "Punch in"}
        </Button>
      </form>
    </>
  );
}

/* ───────────────────────── Outdoor punch-ins (review) ───────────────────────── */

export function OutdoorReview({ now }: { now?: Date }) {
  const { tz, today } = useZone(now);
  const [range, setRange] = useState<"7" | "30">("7");
  const q = useRpc<{ rows: Outdoor[] }>("list_outdoor_punches", { p_from: addDays(today, range === "7" ? -6 : -29), p_to: today });
  const [reject, setReject] = useState<Outdoor | null>(null);
  const [photo, setPhoto] = useState<Outdoor | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <>
      <PageTitle title="Outdoor punch-ins" back="/action" />
      <div className="mx-auto flex max-w-5xl flex-col gap-3 p-page">
        <PillTabs
          label="Period"
          tabs={[
            { id: "7", label: "Last 7 days" },
            { id: "30", label: "Last 30 days" },
          ]}
          value={range}
          onChange={setRange}
        />
        {notice && <Banner tone="success">{notice}</Banner>}
        {q.error ? (
          <ErrorState message={msg(q.error, "Could not load outdoor punch-ins.")} onRetry={() => void q.mutate()} />
        ) : !q.data ? (
          <LoadingState />
        ) : q.data.rows.length === 0 ? (
          <EmptyState art="location" title="No outdoor punch-ins" />
        ) : (
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="Outdoor punch-ins">
            {q.data.rows.map((o) => (
              <li key={o.id}>
                <SectionCard className="h-full">
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 flex-1 font-semibold">{o.employee.name}</p>
                    <StatusChip label={o.status === "counted" ? "Counts" : "Rejected"} tone={o.status === "counted" ? "success" : "error"} />
                  </div>
                  <p className="text-body-sm text-text-secondary">
                    {dayNice(o.work_date)} · in {niceTime(o.punch_in_at, tz)}
                    {o.punch_out_at ? ` · out ${niceTime(o.punch_out_at, tz)}` : ""}
                  </p>
                  <p className="mt-1 text-body-md">{o.reason}</p>
                  {o.status === "rejected" && <p className="text-body-sm text-error">Rejected: {o.reject_reason}</p>}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button variant="text" onClick={() => setPhoto(o)}>
                      View photo
                    </Button>
                    {o.latitude != null && (
                      <a className="inline-flex min-h-12 items-center px-2 font-semibold text-primary" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${o.latitude}&mlon=${o.longitude}#map=17/${o.latitude}/${o.longitude}`}>
                        Map
                      </a>
                    )}
                    {o.can_reject && (
                      <Button variant="text" onClick={() => setReject(o)}>
                        Reject
                      </Button>
                    )}
                  </div>
                </SectionCard>
              </li>
            ))}
          </ul>
        )}
      </div>
      {photo && <PhotoSheet o={photo} onClose={() => setPhoto(null)} />}
      {reject && (
        <RejectSheet
          o={reject}
          onClose={() => setReject(null)}
          onDone={async () => {
            setReject(null);
            setNotice("Rejected. They have been told.");
            await q.mutate();
          }}
        />
      )}
    </>
  );
}

function PhotoSheet({ o, onClose }: { o: Outdoor; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null;
    let live = true;
    fetchFile(o.photo_file_version_id, "review")
      .then((f) => {
        if (!live) return;
        u = URL.createObjectURL(f.blob);
        setUrl(u);
      })
      .catch((e) => live && setError(msg(e, "Could not open the photo.")));
    return () => {
      live = false;
      if (u) URL.revokeObjectURL(u);
    };
  }, [o.photo_file_version_id]);
  return (
    <Sheet title={`${o.employee.name} · ${dayNice(o.work_date)}`} onClose={onClose}>
      {error ? <Banner>{error}</Banner> : url ? (
        // eslint-disable-next-line @next/next/no-img-element -- private blob URL
        <img src={url} alt={`Outdoor photo from ${o.employee.name}`} className="max-h-[70vh] w-full rounded-card object-contain" />
      ) : (
        <LoadingState />
      )}
    </Sheet>
  );
}

function RejectSheet({ o, onClose, onDone }: { o: Outdoor; onClose: () => void; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | undefined>();
  const a = useAction();
  return (
    <Sheet title={`Reject ${o.employee.name}'s punch-in?`} onClose={onClose}>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim().length < 3) return setErr("Say why it is rejected.");
          setErr(undefined);
          void a.run(async () => {
            await rpc("reject_outdoor_punch", { p_id: o.id, p_reason: reason.trim() });
            await onDone();
          }, "Could not reject.");
        }}
      >
        {a.error && <Banner>{a.error}</Banner>}
        <p className="text-body-md text-text-secondary">The day will no longer count as outdoor work.</p>
        <TextArea label="Reason" value={reason} maxLength={500} rows={2} onChange={setReason} error={err} />
        <Button type="submit" variant="danger" busy={a.busy}>
          Reject
        </Button>
      </form>
    </Sheet>
  );
}

/* ───────────────────────────── Fix requests ───────────────────────────── */

export function PunchFixes({ now }: { now?: Date }) {
  const { tz } = useZone(now);
  const [filter, setFilter] = useState<"pending" | "done">("pending");
  const q = useRpc<PunchFix[]>("list_punch_fixes", { p_status: filter });
  const [rejecting, setRejecting] = useState<PunchFix | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const a = useAction();
  const approve = (r: PunchFix) =>
    a.run(async () => {
      await rpc("review_punch_fix", { p_id: r.id, p_approve: true, p_note: null });
      setNotice(`Fixed ${r.employee.name}'s punch for ${dayNice(r.date)}.`);
      await q.mutate();
    }, "Could not approve.");
  return (
    <>
      <PageTitle title="Punch fix requests" back="/action" />
      <div className="mx-auto flex max-w-5xl flex-col gap-3 p-page">
        <PillTabs
          label="Status"
          tabs={[
            { id: "pending", label: "Waiting" },
            { id: "done", label: "Handled" },
          ]}
          value={filter}
          onChange={setFilter}
        />
        {notice && <Banner tone="success">{notice}</Banner>}
        {a.error && <Banner>{a.error}</Banner>}
        {q.error ? (
          <ErrorState message={msg(q.error, "Could not load requests.")} onRetry={() => void q.mutate()} />
        ) : !q.data ? (
          <LoadingState />
        ) : q.data.length === 0 ? (
          <EmptyState art="fact_check" title={filter === "pending" ? "Nothing waiting" : "Nothing yet"} />
        ) : (
          <ul className="grid gap-3 md:grid-cols-2" aria-label="Fix requests">
            {q.data.map((r) => (
              <li key={r.id}>
                <SectionCard className="h-full">
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 flex-1 font-semibold">
                      {r.employee.name} <span className="font-normal text-text-secondary">· {dayNice(r.date)}</span>
                    </p>
                    <StatusChip label={FIX_STATUS[r.status].label} tone={FIX_STATUS[r.status].tone} />
                  </div>
                  <dl className="mt-2 grid grid-cols-[auto_1fr_1fr] gap-x-3 text-body-md">
                    <dt />
                    <dd className="text-text-secondary">Recorded</dd>
                    <dd className="text-text-secondary">Asked</dd>
                    <dt className="text-text-secondary">In</dt>
                    <dd>{niceTime(r.day?.first_in_at, tz) || "—"}</dd>
                    <dd className={cx(r.in_at && "font-semibold")}>{niceTime(r.in_at, tz) || "no change"}</dd>
                    <dt className="text-text-secondary">Out</dt>
                    <dd>{r.day?.out_at && r.day.out_source !== "auto" ? niceTime(r.day.out_at, tz) : "—"}</dd>
                    <dd className={cx(r.out_at && "font-semibold")}>{niceTime(r.out_at, tz) || "no change"}</dd>
                  </dl>
                  <p className="mt-2 text-body-md">{r.reason}</p>
                  {r.review_note && (
                    <p className="text-body-sm text-text-secondary">
                      {r.reviewed_by}: {r.review_note}
                    </p>
                  )}
                  {r.can_review && (
                    <div className="mt-3 flex gap-2">
                      <Button busy={a.busy} onClick={() => approve(r)}>
                        Approve
                      </Button>
                      <Button variant="outlined" onClick={() => setRejecting(r)}>
                        Reject
                      </Button>
                    </div>
                  )}
                </SectionCard>
              </li>
            ))}
          </ul>
        )}
      </div>
      {rejecting && (
        <FixRejectSheet
          r={rejecting}
          onClose={() => setRejecting(null)}
          onDone={async () => {
            setRejecting(null);
            setNotice("Rejected. They have been told.");
            await q.mutate();
          }}
        />
      )}
    </>
  );
}

function FixRejectSheet({ r, onClose, onDone }: { r: PunchFix; onClose: () => void; onDone: () => Promise<void> }) {
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | undefined>();
  const a = useAction();
  return (
    <Sheet title="Reject this fix?" onClose={onClose}>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (note.trim().length < 3) return setErr("Say why it is rejected.");
          setErr(undefined);
          void a.run(async () => {
            await rpc("review_punch_fix", { p_id: r.id, p_approve: false, p_note: note.trim() });
            await onDone();
          }, "Could not reject.");
        }}
      >
        {a.error && <Banner>{a.error}</Banner>}
        <TextArea label={`Reason (${r.employee.name} will see it)`} value={note} maxLength={300} rows={2} onChange={setNote} error={err} />
        <Button type="submit" variant="danger" busy={a.busy}>
          Reject
        </Button>
      </form>
    </Sheet>
  );
}
