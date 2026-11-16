"use client";

// jelly_nav_bar.dart: three tabs, a soft pill that slides (and squishes) to
// the selected tab. 68 px tall, white, hairline top border.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { TABS, activeTab } from "@/lib/routing";
import { Art, cx } from "./ui";

const ART: Record<string, string> = { home: "home", bolt: "bolt", grid: "grid_view" };

export function NavBar() {
  const path = usePathname();
  const active = activeTab(path);
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <div className="relative mx-auto flex h-[68px] max-w-xl">
        <span
          aria-hidden
          className="jelly-pill pointer-events-none absolute top-2 h-8 w-16 rounded-full bg-attendance-card"
          style={{ left: `calc(${(active * 100) / TABS.length}% + ${100 / TABS.length / 2}% - 32px)` }}
          key={active}
        />
        {TABS.map((t, i) => (
          <Link
            key={t.href}
            href={t.href}
            aria-current={i === active ? "page" : undefined}
            className="relative z-10 flex flex-1 flex-col items-center justify-start gap-1 pt-3"
          >
            <span className={cx("transition-opacity", i === active ? "opacity-100" : "opacity-70")}>
              <Art name={ART[t.icon]} size={24} />
            </span>
            <span className={cx("text-body-sm", i === active ? "font-semibold text-primary" : "font-medium text-text-secondary")}>
              {t.label}
            </span>
          </Link>
        ))}
      </div>
    </nav>
  );
}
