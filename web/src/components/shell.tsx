"use client";

// Signed-in frame. Phones keep the bottom tab bar (NavBar in the tabs layout);
// tablets get an icon rail and desktops a sidebar with tabs and fixed
// shortcuts. Every signed-in page sits inside it, so desktop navigation is
// never more than one click away.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { shortcutsFor, type Shortcut } from "@/lib/dashboard";
import { TABS, activeTab } from "@/lib/routing";
import { useSession } from "@/lib/session";
import { NotificationPrompt } from "./notification-prompt";
import { Art, cx } from "./ui";

const TAB_ART: Record<string, string> = { home: "home", bolt: "bolt", grid: "grid_view" };
const big = (art: string) => art.startsWith("tile_") || art === "holiday_calendar";

/** Pages that stay full-bleed (printing, the password step). */
export function bareFrame(path: string): boolean {
  return path === "/password-change" || path === "/login" || path === "/offline" || path.endsWith("/print") || path.includes("/print/");
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  if (bareFrame(path)) return <>{children}</>;
  return (
    <div className="md:pl-20 lg:pl-64">
      <SideNav path={path} />
      {children}
      <NotificationPrompt />
    </div>
  );
}

function SideNav({ path }: { path: string }) {
  const { caps, context } = useSession();
  const tab = TABS.some((t) => path === t.href || path.startsWith(t.href + "/")) ? activeTab(path) : -1;
  const short = shortcutsFor(caps);
  const isOn = (s: Shortcut) => path === s.href.split("?")[0];
  return (
    <nav aria-label="Sidebar" className="fixed inset-y-0 left-0 z-30 hidden w-20 flex-col overflow-y-auto border-r border-border bg-surface pt-[env(safe-area-inset-top)] md:flex lg:w-64">
      <Link href="/home" className="flex items-center gap-3 px-4 py-5 lg:px-5">
        <Art name="attendance" size={36} big />
        <span className="hidden min-w-0 lg:block">
          <span className="block truncate text-title-sm font-semibold">{context?.org.name ?? "HRMS"}</span>
          <span className="block truncate text-body-sm text-text-secondary">{context?.employee.name}</span>
        </span>
      </Link>
      <ul className="flex flex-col gap-1 px-2 lg:px-3">
        {TABS.map((t, i) => (
          <li key={t.href}>
            <NavItem href={t.href} label={t.label} art={TAB_ART[t.icon]} on={i === tab} />
          </li>
        ))}
      </ul>
      <p className="mt-5 hidden px-6 text-body-sm font-semibold uppercase tracking-wide text-text-secondary lg:block">Shortcuts</p>
      <div className="mx-4 my-3 border-t border-border lg:hidden" />
      <ul className="flex flex-col gap-1 px-2 pb-6 lg:px-3" aria-label="Shortcuts">
        {short.map((s) => (
          <li key={s.href}>
            <NavItem href={s.href} label={s.label} art={s.art} on={isOn(s)} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

function NavItem({ href, label, art, on }: { href: string; label: string; art: string; on: boolean }) {
  return (
    <Link
      href={href}
      aria-current={on ? "page" : undefined}
      title={label}
      className={cx(
        "flex flex-col items-center gap-1 rounded-row px-1 py-2 text-center lg:flex-row lg:gap-3 lg:px-3 lg:text-left",
        on ? "bg-attendance-card font-semibold text-primary" : "text-text hover:bg-background",
      )}
    >
      <Art name={art} size={big(art) ? 28 : 22} big={big(art)} />
      <span className="line-clamp-2 text-[11px] leading-tight lg:text-body-md">{label}</span>
    </Link>
  );
}
