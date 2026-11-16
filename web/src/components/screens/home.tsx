"use client";

// Home dashboard. Phones: one column. Tablets: two. Desktops: three, with
// the person's day on the left, their numbers in the middle and the team /
// organisation on the right. Everything comes from one call (get_dashboard).

import Link from "next/link";
import { useEffect, useState } from "react";
import { type Dashboard, type DayPeople, hoursLabel, pct, readUsage, shortcutsFor, topShortcuts, weekday } from "@/lib/dashboard";
import { niceTime } from "@/lib/punch-day";
import { roleLabel } from "@/lib/roles";
import { useSession } from "@/lib/session";
import { minutesLabel } from "@/lib/tasks";
import { useRpc } from "@/lib/use-rpc";
import { Art, ErrorState, SectionCard, SectionHeader, cx } from "../ui";
import { CelebrationsCard } from "./celebrations";
import { BellBadge, useUnread } from "./notifications";
import { TwoStepNudge } from "./two-step";

export function greeting(hour: number): { text: string; art: string } {
  if (hour < 5 || hour >= 19) return { text: "Good evening", art: "skyline_night" };
  if (hour < 12) return { text: "Good morning", art: "skyline_morning" };
  if (hour < 17) return { text: "Good afternoon", art: "skyline_afternoon" };
  return { text: "Good evening", art: "skyline" };
}

export function firstName(name: string | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}

const big = (art: string) => art.startsWith("tile_") || art === "holiday_calendar";

export function Home({ now = new Date() }: { now?: Date }) {
  const { context, caps } = useSession();
  const unread = useUnread();
  const dash = useRpc<Dashboard>("get_dashboard");
  const g = greeting(now.getHours());
  const tz = context?.org.timezone ?? "Asia/Kolkata";
  const initials = (context?.employee.name ?? "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
  const d = dash.data;
  return (
    <>
      <header className="bg-surface px-page pb-5 pt-[max(16px,env(safe-area-inset-top))]">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-body-md text-text-secondary">{g.text},</p>
            <h1 className="truncate text-headline-sm font-medium">{firstName(context?.employee.name)}</h1>
          </div>
          <Link href="/notifications" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"} className="relative grid size-12 place-items-center rounded-full">
            <Art name="notifications" size={26} />
            <BellBadge count={unread} />
          </Link>
          <Link href="/profile" aria-label="My profile" className="grid size-11 place-items-center rounded-full bg-people-card text-[15px] font-semibold text-people-action">
            {initials}
          </Link>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-4 p-page md:grid-cols-2 lg:grid-cols-3">
        {caps.isHrOrAdmin && (
          <div className="md:col-span-2 lg:col-span-3">
            <TwoStepNudge />
          </div>
        )}

        {/* The person's day */}
        <section aria-label="Today" className="flex flex-col overflow-hidden rounded-card bg-attendance-card md:col-span-2 lg:col-span-1">
          <div className="h-[72px] w-full overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element -- SVG illustration banner */}
            <img src={`/illustrations/${g.art}.svg`} alt="" className="h-full w-full object-cover" draggable={false} />
          </div>
          <div className="flex flex-1 flex-col justify-between p-card">
            <div>
              <p className="text-title-sm font-semibold">{context?.employee.designation || roleLabel(caps.isAdmin ? "admin" : caps.isHr ? "hr" : "employee")}</p>
              <p className="text-body-md text-text-secondary">
                {context?.employee.code} · {context?.org.name}
              </p>
              <p className="mt-2 text-body-md" aria-live="polite">
                {!d ? " " : todayLine(d, tz)}
              </p>
            </div>
            <div className="mt-4">
              <Link href="/attendance/today" className="inline-flex min-h-12 items-center rounded-full bg-attendance-action px-[22px] text-[17px] font-semibold text-white">
                My punch
              </Link>
            </div>
          </div>
        </section>

        {dash.error ? (
          <div className="md:col-span-2">
            <ErrorState message={dash.error.message || "Could not load your numbers."} onRetry={() => void dash.mutate()} />
          </div>
        ) : (
          <>
            <MonthCard d={d} />
            <WeekCard d={d} />
          </>
        )}

        <QuickActions />

        {d && <WorkCard d={d} />}
        {d?.team && <TeamCard t={d.team} />}
        {d?.org && <OrgToday o={d.org} />}
        {d?.org && <OrgWeek o={d.org} />}
        <div className="md:col-span-2 lg:col-span-3">
          <CelebrationsCard />
        </div>
      </div>
    </>
  );
}

function todayLine(d: Dashboard, tz: string): string {
  const t = d.me.today;
  if (t.first_in_at && t.out_at) return `In ${niceTime(t.first_in_at, tz)} · Out ${niceTime(t.out_at, tz)}${t.worked_minutes ? ` · ${minutesLabel(t.worked_minutes)}` : ""}`;
  if (t.first_in_at) return `Punched in at ${niceTime(t.first_in_at, tz)}`;
  if (t.outdoor === "counted") return "Outdoor work today";
  if (t.outdoor === "rejected") return "Outdoor punch-in was rejected";
  return d.has_machines ? "Not punched in yet — use the machine" : "Not checked in yet";
}

function Stat({ label, value, sub, href, warn }: { label: string; value: string | number; sub?: string; href?: string; warn?: boolean }) {
  const inner = (
    <>
      <p className="text-body-sm text-text-secondary">{label}</p>
      <p className={cx("text-headline-sm font-semibold", warn && "text-error")}>{value}</p>
      {sub && <p className="text-body-sm text-text-secondary">{sub}</p>}
    </>
  );
  return href ? (
    <Link href={href} className="block rounded-row bg-background p-3 hover:ring-1 hover:ring-primary">
      {inner}
    </Link>
  ) : (
    <div className="rounded-row bg-background p-3">{inner}</div>
  );
}

function Skeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3" aria-busy="true">
      {Array.from({ length: rows * 2 }, (_, i) => (
        <div key={i} className="h-[76px] animate-pulse rounded-row bg-background" />
      ))}
    </div>
  );
}

function MonthCard({ d }: { d?: Dashboard }) {
  const m = d?.me.month;
  return (
    <SectionCard>
      <h2 className="mb-3 text-title-sm font-semibold">This month</h2>
      {!d || !m ? (
        <Skeleton />
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Days present" value={m.days + d.me.outdoor_days} sub={d.me.outdoor_days ? `${d.me.outdoor_days} outdoor` : undefined} href="/attendance" />
          <Stat label="Hours worked" value={hoursLabel(m.worked_minutes)} sub={m.days ? `${hoursLabel(Math.round(m.worked_minutes / m.days))} a day` : undefined} />
          <Stat label="Missed punch-outs" value={m.missed_out} warn={m.missed_out > 0} href="/attendance/today" />
          <Stat label="Open requests" value={d.me.open_requests + d.me.pending_fixes} href="/requests" />
        </div>
      )}
    </SectionCard>
  );
}

function Bars({ items, max, label }: { items: { key: string; label: string; value: number; title: string; muted?: boolean }[]; max: number; label: string }) {
  return (
    <figure>
      <div className="flex h-28 items-end gap-2" role="img" aria-label={label}>
        {items.map((b) => (
          <div key={b.key} className="flex h-full flex-1 flex-col items-center justify-end gap-1" title={b.title}>
            <div
              className={cx("w-full max-w-8 rounded-t-[6px]", b.muted ? "bg-border" : "bg-primary")}
              style={{ height: `${max > 0 ? Math.max(b.value > 0 ? 6 : 2, (b.value / max) * 100) : 2}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-2">
        {items.map((b) => (
          <span key={b.key} className="flex-1 text-center text-body-sm text-text-secondary">
            {b.label}
          </span>
        ))}
      </div>
      <figcaption className="sr-only">
        <ul>
          {items.map((b) => (
            <li key={b.key}>{b.title}</li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

function WeekCard({ d }: { d?: Dashboard }) {
  const week = d?.me.week ?? [];
  const total = week.reduce((s, w) => s + (w.worked_minutes ?? 0), 0);
  return (
    <SectionCard>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-title-sm font-semibold">Last 7 days</h2>
        {d && <span className="text-body-md text-text-secondary">{hoursLabel(total)} worked</span>}
      </div>
      {!d ? (
        <div className="h-32 animate-pulse rounded-row bg-background" />
      ) : (
        <Bars
          label="Hours worked on each of the last 7 days"
          max={Math.max(...week.map((w) => w.worked_minutes ?? 0), 480)}
          items={week.map((w) => ({
            key: w.date,
            label: weekday(w.date).slice(0, 2),
            value: w.worked_minutes ?? (w.in ? 30 : 0),
            muted: w.worked_minutes == null,
            title: `${weekday(w.date)}: ${w.worked_minutes != null ? minutesLabel(w.worked_minutes) || "under 1 m" : w.in ? "in, no punch-out" : "no punch"}`,
          }))}
        />
      )}
    </SectionCard>
  );
}

function WorkCard({ d }: { d: Dashboard }) {
  const t = d.me.tasks;
  return (
    <SectionCard>
      <h2 className="mb-3 text-title-sm font-semibold">My work</h2>
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Open tasks" value={t.open} sub={t.due_today ? `${t.due_today} due today` : undefined} href="/tasks" />
        <Stat label="Overdue" value={t.overdue} warn={t.overdue > 0} href="/tasks" />
        <Stat
          label="Today's report"
          value={d.me.report_entries_today ? `${d.me.report_entries_today} entr${d.me.report_entries_today === 1 ? "y" : "ies"}` : "Not written"}
          warn={!d.me.report_entries_today}
          sub={d.me.report_minutes_today ? minutesLabel(d.me.report_minutes_today) : undefined}
          href="/work"
        />
        <Stat label="Fix requests" value={d.me.pending_fixes} sub="waiting for HR" href="/attendance/today" />
      </div>
    </SectionCard>
  );
}

function QuickActions() {
  const { caps } = useSession();
  const [usage, setUsage] = useState<Record<string, number>>({});
  useEffect(() => {
    const id = setTimeout(() => setUsage(readUsage()), 0);
    return () => clearTimeout(id);
  }, []);
  const list = topShortcuts(shortcutsFor(caps), usage, 8);
  return (
    <section aria-label="Quick actions" className="md:col-span-2 lg:col-span-3">
      <SectionHeader title="Quick actions" href="/action" moreLabel="All actions" />
      <div className="mt-2 grid grid-cols-4 gap-3 md:grid-cols-8">
        {list.map((s) => (
          <Link key={s.href} href={s.href} className="flex flex-col items-center gap-2 rounded-row bg-surface px-1 py-3 text-center ring-1 ring-border hover:ring-primary">
            <Art name={s.art} size={big(s.art) ? 40 : 30} big={big(s.art)} />
            <span className="text-body-sm font-medium leading-tight text-text">{s.label}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function PeopleBar({ p }: { p: DayPeople }) {
  const notIn = Math.max(0, p.total - p.punched_in - p.outdoor - p.on_leave);
  const parts = [
    { label: "In", n: p.punched_in, cls: "bg-success" },
    { label: "Outdoor", n: p.outdoor, cls: "bg-primary" },
    { label: "On leave", n: p.on_leave, cls: "bg-warning" },
    { label: "Not in", n: notIn, cls: "bg-border" },
  ];
  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full bg-background" role="img" aria-label={parts.map((x) => `${x.label} ${x.n}`).join(", ")}>
        {parts.map((x) => (x.n > 0 ? <div key={x.label} className={x.cls} style={{ width: `${pct(x.n, p.total)}%` }} /> : null))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-body-sm">
        {parts.map((x) => (
          <li key={x.label} className="flex items-center gap-1.5">
            <span className={cx("inline-block size-2.5 rounded-full", x.cls)} aria-hidden />
            {x.label} <span className="font-semibold">{x.n}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TeamCard({ t }: { t: NonNullable<Dashboard["team"]> }) {
  return (
    <SectionCard>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-title-sm font-semibold">My team today</h2>
        <span className="text-body-md text-text-secondary">{t.total} people</span>
      </div>
      <PeopleBar p={t} />
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Stat label="Reports written" value={`${t.reports}/${t.total}`} href="/work?tab=team" />
        <Stat label="Open tasks" value={t.open_tasks} sub={t.overdue_tasks ? `${t.overdue_tasks} overdue` : undefined} warn={t.overdue_tasks > 0} href="/tasks?scope=team" />
      </div>
    </SectionCard>
  );
}

function OrgToday({ o }: { o: NonNullable<Dashboard["org"]> }) {
  const w = o.waiting;
  return (
    <SectionCard className="md:col-span-2 lg:col-span-1">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-title-sm font-semibold">Everyone today</h2>
        <Link href="/devices" className="text-body-md font-semibold text-primary">
          Day board
        </Link>
      </div>
      <p className="mb-2 text-headline-sm font-semibold">
        {pct(o.punched_in + o.outdoor, o.total)}% <span className="text-body-md font-normal text-text-secondary">present · {o.in_now} in now</span>
      </p>
      <PeopleBar p={o} />
      <h3 className="mt-4 text-body-md font-semibold">Waiting for you</h3>
      <ul className="mt-1 divide-y divide-border">
        <Waiting href="/approvals" label="Requests to review" n={w.requests} />
        <Waiting href="/attendance/fixes" label="Punch fix requests" n={w.punch_fixes} />
        <Waiting href="/attendance/outdoor" label="Outdoor punch-ins today" n={w.outdoor_today} />
        <Waiting href="/devices?tab=unmatched" label="Machine people not in the app" n={w.machine_people} />
        <Waiting href="/work?tab=team" label="Work reports written today" n={o.reports} of={o.total} />
      </ul>
    </SectionCard>
  );
}

function Waiting({ href, label, n, of }: { href: string; label: string; n: number; of?: number }) {
  return (
    <li>
      <Link href={href} className="flex min-h-11 items-center justify-between gap-2 py-1 text-body-md">
        <span>{label}</span>
        <span className={cx("min-w-8 rounded-full px-2 py-0.5 text-center font-semibold", n > 0 && of === undefined ? "bg-error text-white" : "bg-background")}>
          {of !== undefined ? `${n}/${of}` : n}
        </span>
      </Link>
    </li>
  );
}

function OrgWeek({ o }: { o: NonNullable<Dashboard["org"]> }) {
  const avg = o.week.length ? Math.round(o.week.reduce((s, d) => s + pct(d.punched_in + d.outdoor, o.total), 0) / o.week.length) : 0;
  return (
    <SectionCard>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-title-sm font-semibold">Attendance, last 7 days</h2>
        <span className="text-body-md text-text-secondary">avg {avg}%</span>
      </div>
      <Bars
        label="Share of people present on each of the last 7 days"
        max={100}
        items={o.week.map((d) => {
          const v = pct(d.punched_in + d.outdoor, o.total);
          return { key: d.date, label: weekday(d.date).slice(0, 2), value: v, title: `${weekday(d.date)}: ${v}% present (${d.punched_in} in, ${d.outdoor} outdoor, ${d.on_leave} on leave)` };
        })}
      />
    </SectionCard>
  );
}
