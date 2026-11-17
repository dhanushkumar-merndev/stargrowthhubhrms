"use client";

// Home. The first column is a port of hrms/lib/features/home/home_screen.dart
// (top bar, greeting, shift card with the live office clock, quick actions,
// exception strip, approvals, team today, payslips, holidays): same sizes,
// colours and wording. The cards after it (month, week, work, waiting) are the
// web dashboard. Phones: one column. Tablets: two. Desktops: three.

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { type Dashboard, type DayPeople, hoursLabel, pct, shortcutsFor, weekday } from "@/lib/dashboard";
import { niceTime } from "@/lib/punch-day";
import { useSession } from "@/lib/session";
import { minutesLabel } from "@/lib/tasks";
import { useRpc } from "@/lib/use-rpc";
import { Glyph } from "../glyphs";
import { Art, ErrorState, SectionCard, cx } from "../ui";
import { CelebrationsCard } from "./celebrations";
import { BellBadge, useUnread } from "./notifications";
import { TwoStepNudge } from "./two-step";

/** get_home_summary, the same call the Android Home uses. */
export interface HomeSummary {
  today: string;
  org: { name: string; timezone: string };
  shift: {
    shift_date?: string;
    kind?: string;
    is_required?: boolean;
    start_at?: string;
    end_at?: string;
    next_action?: "IN" | "OUT" | null;
    blocked_reason?: string | null;
    session_state?: string | null;
    effective_in_at?: string | null;
    effective_out_at?: string | null;
    credited_seconds?: number | null;
    is_late?: boolean;
    checkin_opens_at?: string | null;
    outside_reason?: string | null;
  } | null;
  team: { on_time: number; late: number; not_yet_in: number; out_of_office: number; total: number } | null;
  upcoming_holidays: { date: string; name: string | null }[];
  extras?: { admin_tasks?: { kind: string; title?: string }[]; latest_payslip?: { salary_month?: string } | null };
  exception_days: number;
  pending_reviews: number;
  unassigned_reviews: number;
}

export type DayPhase = "morning" | "afternoon" | "sunset" | "night";

/** Office-time phases: the skyline and the clock dial change together. */
export function dayPhase(minutes: number): DayPhase {
  if (minutes >= 6 * 60 && minutes < 12 * 60) return "morning";
  if (minutes >= 12 * 60 && minutes < 17 * 60) return "afternoon";
  if (minutes >= 17 * 60 && minutes < 19 * 60 + 30) return "sunset";
  return "night";
}

const SKYLINE: Record<DayPhase, string> = { morning: "skyline_morning", afternoon: "skyline_afternoon", sunset: "skyline", night: "skyline_night" };

export function firstName(name: string | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}

/** The wall clock in the organisation's time zone. */
export function orgClock(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true, weekday: "long", day: "numeric", month: "long", year: "numeric" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour12 = Number(get("hour")) % 12;
  const pm = get("dayPeriod").toUpperCase() === "PM";
  return {
    time: `${get("hour")}:${get("minute")}`,
    period: pm ? "PM" : "AM",
    minutes: (hour12 + (pm ? 12 : 0)) * 60 + Number(get("minute")),
    weekday: get("weekday"),
    date: `${get("day")} ${get("month")} ${get("year")}`,
  };
}

function longDate(ymd: string) {
  const d = new Date(`${ymd.slice(0, 10)}T00:00:00Z`);
  return {
    weekday: d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" }),
    date: d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }),
  };
}

const hm = (seconds: number | null | undefined) => minutesLabel(Math.floor((seconds ?? 0) / 60)) || "0 m";
const big = (art: string) => art.startsWith("tile_") || art === "holiday_calendar";

export function Home({ now }: { now?: Date }) {
  const { context, caps } = useSession();
  const unread = useUnread();
  const home = useRpc<HomeSummary>("get_home_summary");
  const dash = useRpc<Dashboard>("get_dashboard");
  const [tick, setTick] = useState(() => now ?? new Date());
  useEffect(() => {
    if (now) return;
    const id = setInterval(() => setTick(new Date()), 15_000);
    return () => clearInterval(id);
  }, [now]);
  const at = now ?? tick;
  const tz = context?.org.timezone ?? "Asia/Kolkata";
  const name = context?.employee.name ?? "";
  const initials = (name || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
  const d = dash.data;
  const h = home.data;
  const team = teamToday(d, h);
  return (
    <div className="mx-auto max-w-6xl px-page pb-8 pt-[max(8px,env(safe-area-inset-top))]">
      <div className="flex items-center">
        <span className="rounded-lg bg-attendance-card px-2.5 py-1.5 text-[12px] font-bold uppercase leading-[1.35] tracking-[1.2px] text-primary">{context?.org.name ?? h?.org.name ?? ""}</span>
        <span className="flex-1" />
        <Link href="/notifications" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"} className="relative grid size-12 place-items-center rounded-full">
          <Art name="notifications" size={28} />
          <BellBadge count={unread} />
        </Link>
        <Link href="/profile" aria-label="My profile" className="ml-1 grid size-11 place-items-center rounded-full bg-people-card text-[15px] font-semibold text-people-action">
          {initials}
        </Link>
      </div>
      <h1 className="mt-6 text-headline-md font-medium leading-[1.2]">Hello {firstName(name)} 👋</h1>

      <div className="mt-6 grid items-start gap-4 md:grid-cols-2 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4">
          <ShiftCard at={at} tz={tz} home={h} dash={d} />
          <QuickActions />
          {caps.isHrOrAdmin && <TwoStepNudge />}
          {h && h.exception_days > 0 && <ExceptionStrip count={h.exception_days} />}
          {h && (h.pending_reviews > 0 || h.unassigned_reviews > 0) && <ReviewsCard pending={h.pending_reviews} unassigned={h.unassigned_reviews} />}
          {(h?.extras?.admin_tasks ?? [])
            .filter((t) => t.kind !== "reviewer_missing")
            .map((t, i) => (
              <Link key={i} href={t.kind === "archive_due" ? "/admin/archive" : "/action"} className="flex min-h-14 items-center gap-3 rounded-row border border-border bg-surface px-4 py-2.5">
                <span className="grid size-10 place-items-center rounded-xl bg-warning-soft">
                  <Art name={t.kind === "archive_due" ? "archive" : "task_alt"} size={22} />
                </span>
                <span className="flex-1 text-body-lg">{t.title ?? ""}</span>
                <Glyph name="chevron_right" />
              </Link>
            ))}
          {team && <WhoIsInCard team={team} href={team.href} />}
          <PayslipCard month={h?.extras?.latest_payslip?.salary_month} />
          <HolidaysCard holidays={h?.upcoming_holidays ?? []} />
        </div>

        <div className="grid min-w-0 content-start gap-4 lg:col-span-2 lg:grid-cols-2">
          {dash.error ? (
            <div className="lg:col-span-2">
              <ErrorState message={dash.error.message || "Could not load your numbers."} onRetry={() => void dash.mutate()} />
            </div>
          ) : (
            <>
              <MonthCard d={d} />
              <WeekCard d={d} />
            </>
          )}
          {d && <WorkCard d={d} />}
          {d?.team && <TeamCard t={d.team} bar={Boolean(d.org)} />}
          {d?.org && <OrgToday o={d.org} />}
          {d?.org && <OrgWeek o={d.org} />}
          <Shortcuts />
          <div className="lg:col-span-2">
            <CelebrationsCard />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Shift card ─────────────────────────────────────────────────────────── */

const DIAL: Record<DayPhase, { from: string; to: string; border: string; shadow: string; text: string; sub: string }> = {
  morning: { from: "#FFF9ED", to: "#FFE8C7", border: "#FFE3B8", shadow: "rgba(255,179,0,0.10)", text: "#263342", sub: "#263342" },
  afternoon: { from: "#FFF6EB", to: "#FFE0B8", border: "#FFE7C7", shadow: "rgba(255,159,42,0.08)", text: "#263342", sub: "#263342" },
  sunset: { from: "#FFF1EB", to: "#FDD5C6", border: "#FBC6B3", shadow: "rgba(255,112,67,0.10)", text: "#263342", sub: "#263342" },
  night: { from: "#242E4C", to: "#141A2D", border: "#38466D", shadow: "rgba(20,26,45,0.15)", text: "#FFFFFF", sub: "#CBD5E1" },
};

/** Sun by day, a setting sun at dusk, a crescent moon and stars at night. */
function Celestial({ phase }: { phase: DayPhase }) {
  if (phase === "night")
    return (
      <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden>
        <defs>
          <linearGradient id="moon" x1="1" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#FFF9C4" />
            <stop offset="1" stopColor="#FFCA28" />
          </linearGradient>
          <mask id="crescent">
            <rect width="32" height="32" fill="#fff" />
            <circle cx="9.9" cy="11.4" r="12.1" fill="#000" />
          </mask>
          <filter id="aura" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" />
          </filter>
        </defs>
        <circle cx="16.6" cy="15.4" r="12.7" fill="#FFD54F" opacity="0.3" filter="url(#aura)" />
        <circle cx="16.6" cy="15.4" r="14.1" fill="url(#moon)" mask="url(#crescent)" />
        <g fill="#fff" opacity="0.95">
          <path d="M5.1 20.2Q5.1 23 7.3 23Q5.1 23 5.1 25.9Q5.1 23 2.9 23Q5.1 23 5.1 20.2Z" />
          <path d="M26.2 23.9Q26.2 26.2 28 26.2Q26.2 26.2 26.2 28.6Q26.2 26.2 24.4 26.2Q26.2 26.2 26.2 23.9Z" />
          <path d="M9 3.9Q9 5.8 10.4 5.8Q9 5.8 9 7.6Q9 5.8 7.6 5.8Q9 5.8 9 3.9Z" />
        </g>
      </svg>
    );
  if (phase === "sunset")
    return (
      <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden>
        <defs>
          <linearGradient id="dusk" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#FFC44D" />
            <stop offset="1" stopColor="#FF6B45" />
          </linearGradient>
          <clipPath id="horizon">
            <rect width="32" height="22.4" />
          </clipPath>
          <filter id="dusk-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.5" />
          </filter>
        </defs>
        <circle cx="16" cy="18.2" r="11.2" fill="#FF8A3D" opacity="0.27" filter="url(#dusk-glow)" />
        <circle cx="16" cy="18.2" r="8.6" fill="url(#dusk)" clipPath="url(#horizon)" />
        <g stroke="#FF754B" strokeWidth="1.76" strokeLinecap="round">
          <path d="M16 2.6V7M7.7 6.4l2.9 3.2M24.3 6.4l-2.9 3.2M3.8 22.4h24.4M9.6 26.9h12.8" />
        </g>
      </svg>
    );
  const morning = phase === "morning";
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="sun" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={morning ? "#FFD54F" : "#FFB74D"} />
          <stop offset="1" stopColor={morning ? "#FF9800" : "#F57C00"} />
        </linearGradient>
        <filter id="sun-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
        <filter id="sun-flare" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1" />
        </filter>
      </defs>
      <circle cx="16" cy="16" r="14.7" fill={morning ? "#FFA726" : "#FF9800"} opacity={morning ? 0.25 : 0.22} filter="url(#sun-glow)" />
      <circle cx="16" cy="16" r="14.7" fill="url(#sun)" />
      <circle cx="11.9" cy="11.9" r="3.7" fill="#fff" opacity="0.3" filter="url(#sun-flare)" />
    </svg>
  );
}

function LiveClock({ at, tz }: { at: Date; tz: string }) {
  const c = orgClock(at, tz);
  const phase = dayPhase(c.minutes);
  const k = DIAL[phase];
  return (
    <div
      role="img"
      aria-label={`Office time ${c.time} ${c.period}, ${phase}`}
      className="relative size-[88px] shrink-0 overflow-hidden rounded-full border-[1.5px] transition-colors duration-500"
      style={{ background: `radial-gradient(circle 79px at 40% 40%, ${k.from}, ${k.to})`, borderColor: k.border, boxShadow: `0 3px 10px ${k.shadow}` }}
    >
      <span className="absolute right-[28px] top-[2px]">
        <Celestial phase={phase} />
      </span>
      <span className="absolute inset-0 top-[14px] grid place-items-center" aria-hidden>
        <span>
          <span className="text-[20px] font-bold tracking-[-0.3px]" style={{ color: k.text }}>
            {c.time}
          </span>
          <span className="text-[11.5px] font-bold" style={{ color: k.sub }}>
            {" "}
            {c.period}
          </span>
        </span>
      </span>
    </div>
  );
}

const KIND: Record<string, string> = { holiday: "Holiday", weekly_off: "Weekly off", day_off: "Day off" };

function ShiftCard({ at, tz, home, dash }: { at: Date; tz: string; home?: HomeSummary; dash?: Dashboard }) {
  const s = home?.shift ?? null;
  const c = orgClock(at, tz);
  const day = s?.shift_date ? longDate(s.shift_date) : home?.today ? longDate(home.today) : { weekday: c.weekday, date: c.date };
  const chip = !home ? "" : !s ? "No shift" : s.kind === "workday" || s.kind === "extra_workday" ? "Office shift" : (KIND[s.kind ?? ""] ?? "Shift");
  const holiday = s?.blocked_reason === "holiday" || s?.kind === "holiday";
  const holidayName = home?.upcoming_holidays.find((x) => x.date === home.today)?.name ?? null;
  return (
    <section aria-label="Today" className="overflow-hidden rounded-card border border-border bg-surface">
      <div className="h-[72px] w-full overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element -- SVG illustration banner */}
        <img src={`/illustrations/${SKYLINE[dayPhase(c.minutes)]}.svg`} alt="" className="h-full w-full object-cover" draggable={false} />
      </div>
      <div className="p-card">
        <div className="flex items-center">
          <div className="grid flex-[2] place-items-center">
            <LiveClock at={at} tz={tz} />
          </div>
          <div className="min-w-0 flex-[3] pl-5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-[17px] font-bold">{day.weekday}</span>
              {chip && <span className="rounded-md bg-attendance-card px-2 py-[2.5px] text-[12px] font-semibold text-primary">{chip}</span>}
            </div>
            <p className="mt-1 text-[14px] font-medium text-text-secondary">{day.date}</p>
            {s?.is_required && s.start_at && s.end_at && (
              <p className="mt-1.5 flex items-start gap-1 text-[12px] font-medium leading-[1.3] text-text-secondary">
                <span className="mt-0.5 shrink-0">
                  <Art name="schedule" size={14} />
                </span>
                <span className="truncate">
                  {niceTime(s.start_at, tz)}–{niceTime(s.end_at, tz)}
                </span>
              </p>
            )}
          </div>
        </div>
        <div className="mt-4" aria-live="polite">
          {!home && !dash ? (
            <div className="h-[46px] animate-pulse rounded-[14px] bg-background" />
          ) : holiday ? (
            <HolidayBanner name={holidayName} />
          ) : dash?.has_machines ? (
            <MachineDay d={dash} tz={tz} at={at} blocked={s?.blocked_reason ?? null} shift={s} />
          ) : (
            <PhoneDay s={s} tz={tz} at={at} />
          )}
        </div>
      </div>
    </section>
  );
}

function HolidayBanner({ name }: { name: string | null }) {
  return (
    <div className="flex items-center gap-3 rounded-row border border-[#E8CFF0] bg-holiday-card px-4 py-3.5">
      <span className="grid size-[42px] shrink-0 place-items-center rounded-full bg-white">
        <Art name="celebration" size={24} />
      </span>
      <div className="min-w-0">
        <p className="text-[16px] font-bold text-holiday-text">Happy holiday!</p>
        <p className="mt-0.5 text-body-md text-text-secondary">{name ? `${name} · No check-in needed today.` : "No check-in or check-out needed today."}</p>
      </div>
    </div>
  );
}

function DoneBanner({ href, line }: { href: string; line: string }) {
  return (
    <Link href={href} className="flex items-center rounded-2xl border border-[#BBF7D0] bg-[#F0FDF4] px-4 py-3.5">
      <span className="grid size-[38px] shrink-0 place-items-center rounded-full bg-success text-white">
        <Glyph name="check" size={22} />
      </span>
      <span className="ml-3.5 min-w-0 flex-1">
        <span className="block text-[15px] font-bold text-[#14532D]">Done for today</span>
        <span className="mt-0.5 block text-[13px] font-medium text-[#166534]">{line}</span>
      </span>
      <span className="flex items-center text-[13px] font-semibold text-primary">
        Log
        <Glyph name="chevron_right" size={16} />
      </span>
    </Link>
  );
}

function PunchButton({ href, label, out }: { href: string; label: string; out: boolean }) {
  return (
    <Link href={href} className={cx("flex min-h-[52px] w-full items-center justify-center gap-2 rounded-full text-[17px] font-semibold text-white shadow-sm", out ? "bg-primary" : "bg-success")}>
      <span className="[&>img]:brightness-0 [&>img]:invert">
        <Art name={out ? "logout" : "login"} size={22} />
      </span>
      {label}
    </Link>
  );
}

function SoFar({ text }: { text: string }) {
  return (
    <p className="mx-auto mt-2 flex w-fit items-center gap-2 rounded-full bg-[#EBF5FF] px-3.5 py-1.5 text-[13px] font-semibold text-primary">
      <span className="size-2.5 shrink-0 rounded-full bg-success" aria-hidden />
      {text}
    </p>
  );
}

function Notice({ art, children, warn, href }: { art: string; children: ReactNode; warn?: boolean; href?: string }) {
  const cls = cx("flex items-center gap-3 rounded-[14px] border px-4 py-3", warn ? "border-[#FDE68A] bg-[#FFFBEB]" : "border-border bg-[#F4F6F9]");
  const body = (
    <>
      <span className="shrink-0">
        <Art name={art} size={22} />
      </span>
      <span className={cx("flex-1 text-[14px]", warn ? "font-semibold text-warning" : "font-medium text-text-secondary")}>{children}</span>
    </>
  );
  return href ? (
    <Link href={href} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

const BLOCKED_ART: Record<string, string> = { not_open_yet: "schedule", on_leave: "beach", outside_work: "location", work_from_home: "home", holiday: "celebration", weekly_off: "weekend", day_off: "wb_sunny" };

function blockedReason(blocked: string | null | undefined, s: HomeSummary["shift"], tz: string): string {
  switch (blocked) {
    case "outside_work":
      return `Outside work today${s?.outside_reason ? ` (${s.outside_reason})` : ""}. No check-in needed.`;
    case "work_from_home":
      return "Working from home today (approved). No check-in needed.";
    case "on_leave":
      return "You are on approved leave today.";
    case "holiday":
      return "Happy holiday! No check-in or check-out is needed today.";
    case "weekly_off":
      return "Today is your weekly off.";
    case "day_off":
      return "Today is a day off.";
    case "no_office":
      return "No office is assigned to you yet.";
    case "not_open_yet":
      return `Check-in opens at ${niceTime(s?.checkin_opens_at, tz)}.`;
    case "window_closed":
      return "The check-in window has closed for today.";
    case "completed":
      return "You have completed today's shift.";
    case "needs_correction":
      return "This shift needs a punch correction.";
    default:
      return s ? "Check-in is currently unavailable." : "No shift is scheduled for you today.";
  }
}

const elapsed = (from: string, at: Date) => minutesLabel(Math.max(0, Math.floor((at.getTime() - new Date(from).getTime()) / 60000))) || "0 m";

/** Without a machine: check in and out on the phone, as in the Android app. */
function PhoneDay({ s, tz, at }: { s: HomeSummary["shift"]; tz: string; at: Date }) {
  if (s?.session_state === "closed") return <DoneBanner href="/attendance" line={`${niceTime(s.effective_in_at, tz)} – ${niceTime(s.effective_out_at, tz)} · ${hm(s.credited_seconds)} credited`} />;
  if (s?.next_action) {
    const out = s.next_action === "OUT";
    return (
      <>
        <PunchButton href="/punch" label={out ? "Check out" : "Check in"} out={out} />
        {out && s.effective_in_at ? (
          <SoFar text={`Checked in at ${niceTime(s.effective_in_at, tz)} · ${elapsed(s.effective_in_at, at)} so far${s.is_late ? " · late" : ""}`} />
        ) : (
          <p className="mt-2 text-center text-body-md text-text-secondary">Ready when you are.</p>
        )}
      </>
    );
  }
  const b = s?.blocked_reason ?? null;
  return (
    <Notice art={BLOCKED_ART[b ?? ""] ?? "info"} warn={b === "not_open_yet"}>
      {blockedReason(b, s, tz)}
    </Notice>
  );
}

/** With a machine: punch in there; the app shows the day and punches out. */
function MachineDay({ d, tz, at, blocked, shift }: { d: Dashboard; tz: string; at: Date; blocked: string | null; shift: HomeSummary["shift"] }) {
  const t = d.me.today;
  if (t.first_in_at && t.out_at)
    return <DoneBanner href="/attendance/today" line={`${niceTime(t.first_in_at, tz)} – ${niceTime(t.out_at, tz)}${t.worked_minutes ? ` · ${minutesLabel(t.worked_minutes)} worked` : ""}`} />;
  if (t.first_in_at)
    return (
      <>
        <PunchButton href="/attendance/today" label="Punch out" out />
        <SoFar text={`Punched in at ${niceTime(t.first_in_at, tz)} · ${elapsed(t.first_in_at, at)} so far`} />
      </>
    );
  if (t.outdoor === "counted")
    return (
      <Notice art="location" href="/attendance/today">
        Outdoor work today. No punch-in needed.
      </Notice>
    );
  if (t.outdoor === "rejected")
    return (
      <Notice art="info" href="/attendance/today">
        Your outdoor punch-in was rejected.
      </Notice>
    );
  if (blocked && ["on_leave", "work_from_home", "outside_work", "weekly_off", "day_off"].includes(blocked))
    return <Notice art={BLOCKED_ART[blocked] ?? "info"}>{blockedReason(blocked, shift, tz)}</Notice>;
  return (
    <Notice art="fingerprint" href="/attendance/today">
      Not punched in yet. Punch in at the machine.
    </Notice>
  );
}

/* ── Quick actions, strips and cards ────────────────────────────────────── */

const QUICK: [art: string, label: string, bg: string, href: string][] = [
  ["tile_apply_leave", "Apply\nleave", "bg-leave-card", "/leave/apply"],
  ["tile_fix_punch", "Fix a\npunch", "bg-attendance-card", "/attendance/today"],
  ["tile_my_attendance", "My\nattendance", "bg-approvals-card", "/attendance"],
  ["tile_my_requests", "My\nrequests", "bg-salary-card", "/requests"],
];

function Tile({ art, label, bg, href }: { art: string; label: string; bg: string; href: string }) {
  return (
    <Link href={href} aria-label={label.replace("\n", " ")} className="flex flex-1 flex-col items-center rounded-[18px] border border-border bg-surface px-1 pb-[11px] pt-2.5">
      <span className={cx("grid size-[54px] place-items-center rounded-2xl", bg)}>
        <Art name={art} size={big(art) ? 42 : 30} big={big(art)} />
      </span>
      <span className="mt-[7px] whitespace-pre-line text-center text-[12.5px] font-semibold leading-[1.15] text-text">{label}</span>
    </Link>
  );
}

function QuickActions() {
  return (
    <section aria-label="Quick actions" className="flex items-start gap-2">
      {QUICK.map(([art, label, bg, href]) => (
        <Tile key={href} art={art} label={label} bg={bg} href={href} />
      ))}
    </section>
  );
}

function ExceptionStrip({ count }: { count: number }) {
  return (
    <Link href="/attendance?filter=needs_correction" className="flex items-center gap-3 rounded-row border border-[#F6C4C8] bg-exception-strip px-4 py-3">
      <Art name="error" size={24} />
      <span className="flex-1 text-[16px]">
        {String(count).padStart(2, "0")} Exception day{count === 1 ? "" : "s"}
      </span>
      <span className="text-[16px] font-semibold text-primary">Fix a punch</span>
    </Link>
  );
}

function ReviewsCard({ pending, unassigned }: { pending: number; unassigned: number }) {
  return (
    <Link href={pending === 0 && unassigned > 0 ? "/approvals?scope=unassigned" : "/approvals"} className="flex items-center gap-3 rounded-card border border-border bg-approvals-card p-card">
      <Art name="tile_review_requests" size={40} big />
      <span className="min-w-0 flex-1">
        <span className="block text-title-sm font-semibold">{pending > 0 ? `${pending} request${pending === 1 ? "" : "s"} waiting for you` : "Approvals"}</span>
        {unassigned > 0 && <span className="block text-body-md text-error">{unassigned} need an approver assigned</span>}
      </span>
      <Glyph name="chevron_right" />
    </Link>
  );
}

interface TeamToday {
  total: number;
  arrived: number;
  href?: string;
  segments: { label: string; count: number; color: string; art: string }[];
}

/** Who is in: from the machines when the office has one, else from phone check-ins. */
function teamToday(d: Dashboard | undefined, h: HomeSummary | undefined): TeamToday | null {
  if (d?.has_machines) {
    const p = d.org ?? d.team;
    if (!p) return null;
    return {
      total: p.total,
      arrived: p.punched_in + p.outdoor,
      href: d.org ? "/devices" : undefined,
      segments: [
        { label: "In", count: p.punched_in, color: "#2FB5A6", art: "status_on_time" },
        { label: "Outdoor", count: p.outdoor, color: "#F2A33A", art: "status_late" },
        { label: "Not in yet", count: Math.max(0, p.total - p.punched_in - p.outdoor - p.on_leave), color: "#F26B6B", art: "status_not_in" },
        { label: "On leave", count: p.on_leave, color: "#A7B1C2", art: "status_away" },
      ],
    };
  }
  const t = h?.team;
  if (!t) return null;
  return {
    total: t.total,
    arrived: t.on_time + t.late,
    href: "/reports/hours",
    segments: [
      { label: "On time", count: t.on_time, color: "#2FB5A6", art: "status_on_time" },
      { label: "Late", count: t.late, color: "#F2A33A", art: "status_late" },
      { label: "Not in yet", count: t.not_yet_in, color: "#F26B6B", art: "status_not_in" },
      { label: "Away", count: t.out_of_office, color: "#A7B1C2", art: "status_away" },
    ],
  };
}

function Ring({ arrived, total }: { arrived: number; total: number }) {
  const r = 21.5;
  const len = 2 * Math.PI * r;
  const progress = total === 0 ? 0 : Math.min(1, Math.max(0, arrived / total));
  return (
    <span role="img" aria-label={`${arrived} of ${total} teammates have arrived`} className="relative grid size-12 place-items-center">
      <svg width="48" height="48" viewBox="0 0 48 48" className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx="24" cy="24" r={r} fill="none" stroke="#E9ECF1" strokeWidth="5" />
        {progress > 0 && <circle cx="24" cy="24" r={r} fill="none" stroke="#2FB5A6" strokeWidth="5" strokeLinecap="round" strokeDasharray={`${len * progress} ${len}`} />}
      </svg>
      <span className="text-[14px] font-bold" aria-hidden>
        {arrived}
      </span>
    </span>
  );
}

function WhoIsInCard({ team, href }: { team: TeamToday; href?: string }) {
  const body = (
    <>
      <div className="relative flex min-h-12 items-center justify-between">
        <Ring arrived={team.arrived} total={team.total} />
        <div className="absolute inset-x-12 text-center">
          <h2 className="text-title-md font-semibold">Team today</h2>
          <p className="mt-0.5 text-body-sm text-text-secondary">{team.total} people</p>
        </div>
        {href ? <Glyph name="chevron_right" /> : <span />}
      </div>
      <ul className="mt-4 grid grid-cols-2 gap-2">
        {team.segments.map((s) => (
          <li key={s.label} className="flex items-center gap-2 rounded-xl px-2.5 py-2" style={{ backgroundColor: `${s.color}1A` }}>
            <Art name={s.art} size={36} big />
            <span className="min-w-0 flex-1 text-center">
              <span className="block text-[18px] font-bold leading-[1.1]">{s.count}</span>
              <span className="block truncate text-body-sm text-text-secondary">{s.label}</span>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
  const cls = "block rounded-card border border-border bg-surface py-card pl-card pr-6";
  return href ? (
    <Link href={href} className={cls}>
      {body}
    </Link>
  ) : (
    <section className={cls}>{body}</section>
  );
}

function InfoCard({ href, art, size, title, line }: { href: string; art: string; size: number; title: string; line: string }) {
  return (
    <Link href={href} className="flex items-center gap-3 rounded-card border border-border bg-surface p-card">
      <span className="grid size-14 shrink-0 place-items-center">
        <Art name={art} size={size} big />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-title-sm font-semibold">{title}</span>
        <span className="mt-[3px] line-clamp-2 block text-body-md text-text-secondary">{line}</span>
      </span>
      <Glyph name="chevron_right" />
    </Link>
  );
}

function PayslipCard({ month }: { month?: string }) {
  const label = month ? new Date(`${month.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }) : null;
  return <InfoCard href="/payslips" art="piggy" size={54} title="Payslips" line={label ? `${label} is ready` : "No payslip available yet"} />;
}

function HolidaysCard({ holidays }: { holidays: HomeSummary["upcoming_holidays"] }) {
  const next = holidays[0];
  const when = next ? new Date(`${next.date.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "";
  const line = next ? `${next.name ?? "Holiday"} · ${when}${holidays.length > 1 ? ` · +${holidays.length - 1} more` : ""}` : "No holidays published yet";
  return <InfoCard href="/holidays" art="holiday_calendar" size={52} title="Upcoming holidays" line={line} />;
}

/* ── Web dashboard cards ────────────────────────────────────────────────── */

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

function Shortcuts() {
  const { caps } = useSession();
  const list = shortcutsFor(caps);
  return (
    <section aria-label="Shortcuts" className="lg:col-span-2">
      <div className="flex items-center justify-between">
        <h2 className="text-title-sm font-semibold">Shortcuts</h2>
        <Link href="/action" className="text-body-md font-semibold text-primary">
          All actions
        </Link>
      </div>
      <div className="mt-2 grid grid-cols-4 gap-2 md:grid-cols-8">
        {list.map((s) => (
          <Tile key={s.href} art={s.art} label={s.label} bg="bg-background" href={s.href} />
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

/** `bar`: the "Team today" card above already shows everyone, so show the team split here. */
function TeamCard({ t, bar }: { t: NonNullable<Dashboard["team"]>; bar: boolean }) {
  return (
    <SectionCard>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-title-sm font-semibold">My team today</h2>
        <span className="text-body-md text-text-secondary">{t.total} people</span>
      </div>
      {bar && <PeopleBar p={t} />}
      <div className={cx("grid grid-cols-2 gap-3", bar && "mt-3")}>
        <Stat label="Reports written" value={`${t.reports}/${t.total}`} href="/work?tab=team" />
        <Stat label="Open tasks" value={t.open_tasks} sub={t.overdue_tasks ? `${t.overdue_tasks} overdue` : undefined} warn={t.overdue_tasks > 0} href="/tasks?scope=team" />
      </div>
    </SectionCard>
  );
}

function OrgToday({ o }: { o: NonNullable<Dashboard["org"]> }) {
  const w = o.waiting;
  return (
    <SectionCard>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-title-sm font-semibold">Everyone today</h2>
        <Link href="/devices" className="text-body-md font-semibold text-primary">
          Day board
        </Link>
      </div>
      <p className="text-headline-sm font-semibold">
        {pct(o.punched_in + o.outdoor, o.total)}% <span className="text-body-md font-normal text-text-secondary">present · {o.in_now} in now</span>
      </p>
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
