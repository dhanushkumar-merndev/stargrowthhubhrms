"use client";

// home_screen.dart header + quick tiles. The attendance card, approvals and
// payslip sections are filled in by P4 (attendance), P6 (leave) and P7 (salary).

import { BellBadge, useUnread } from "./notifications";
import Link from "next/link";
import { useSession } from "@/lib/session";
import { roleLabel } from "@/lib/roles";
import { Art, SectionHeader } from "../ui";

export function greeting(hour: number): { text: string; art: string } {
  if (hour < 5 || hour >= 19) return { text: "Good evening", art: "skyline_night" };
  if (hour < 12) return { text: "Good morning", art: "skyline_morning" };
  if (hour < 17) return { text: "Good afternoon", art: "skyline_afternoon" };
  return { text: "Good evening", art: "skyline" };
}

export function firstName(name: string | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}

const TILES = [
  { art: "tile_apply_leave", label: "Apply\nleave", card: "bg-leave-card", href: "/leave/apply" },
  { art: "tile_fix_punch", label: "Fix a\npunch", card: "bg-attendance-card", href: "/corrections/new" },
  { art: "tile_my_attendance", label: "My\nattendance", card: "bg-approvals-card", href: "/attendance" },
  { art: "tile_my_requests", label: "My\nrequests", card: "bg-salary-card", href: "/requests" },
];

export function Home({ now = new Date() }: { now?: Date }) {
  const { context, caps } = useSession();
  const unread = useUnread();
  const g = greeting(now.getHours());
  const initials = (context?.employee.name ?? "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <>
      <header className="bg-surface px-page pb-5 pt-[max(16px,env(safe-area-inset-top))]">
        <div className="mx-auto flex max-w-xl items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-body-md text-text-secondary">{g.text},</p>
            <h1 className="truncate text-headline-sm font-medium">{firstName(context?.employee.name)}</h1>
          </div>
          <Link href="/notifications" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"} className="relative grid size-12 place-items-center rounded-full">
            <Art name="notifications" size={26} />
            <BellBadge count={unread} />
          </Link>
          <Link
            href="/profile"
            aria-label="My profile"
            className="grid size-11 place-items-center rounded-full bg-people-card text-[15px] font-semibold text-people-action"
          >
            {initials}
          </Link>
        </div>
        <div className="mx-auto mt-4 flex max-w-xl items-center gap-3 overflow-hidden rounded-card bg-attendance-card p-card">
          <div className="min-w-0 flex-1">
            <p className="text-title-sm font-semibold">{context?.employee.designation || roleLabel(caps.isAdmin ? "admin" : caps.isHr ? "hr" : "employee")}</p>
            <p className="text-body-md text-text-secondary">
              {context?.employee.code} · {context?.org.name}
            </p>
            <Link href="/punch" className="mt-3 inline-flex min-h-12 items-center rounded-full bg-attendance-action px-[22px] text-[17px] font-semibold text-white">
              Check in / out
            </Link>
          </div>
          <Art name={g.art} size={96} big />
        </div>
      </header>
      <div className="mx-auto flex max-w-xl flex-col gap-4 p-page">
        <SectionHeader title="Quick actions" href="/action" moreLabel="All actions" />
        <div className="grid grid-cols-4 gap-3">
          {TILES.map((t) => (
            <Link key={t.href} href={t.href} className={`flex flex-col items-center gap-2 rounded-row ${t.card} px-1 py-3 text-center`}>
              <Art name={t.art} size={40} big />
              <span className="whitespace-pre-line text-body-sm font-medium leading-tight text-text">{t.label}</span>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}
