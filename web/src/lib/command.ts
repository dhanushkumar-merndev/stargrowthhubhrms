// Command search (Ctrl/⌘-K) for HR/Admin: every screen the person can open,
// from the same role-filtered menus as the Action and Explore tabs.

import { actionScopes, exploreModules } from "./menu";
import type { Caps } from "./roles";

export interface Command {
  label: string;
  href: string;
  group: string;
}

export function commandItems(c: Caps): Command[] {
  const out: Command[] = [{ label: "Home", href: "/home", group: "Go to" }, { label: "Notifications", href: "/notifications", group: "Go to" }];
  for (const s of actionScopes(c)) for (const i of s.items) out.push({ label: i.label, href: i.href, group: s.label });
  for (const m of exploreModules(c)) for (const a of m.actions) out.push({ label: a.label, href: a.href, group: m.title });
  const seen = new Set<string>();
  return out.filter((x) => (seen.has(x.href) ? false : (seen.add(x.href), true)));
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N} ]/gu, " ");

/** Every query word must match the start of a word in the label (or group). Earlier, tighter matches rank first. */
export function rankCommands(items: Command[], query: string, limit = 8): Command[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return items.slice(0, limit);
  const scored: { c: Command; s: number }[] = [];
  for (const c of items) {
    const label = norm(c.label);
    const hay = `${label} ${norm(c.group)}`.split(/\s+/).filter(Boolean);
    let s = 0;
    let okAll = true;
    for (const w of words) {
      const i = hay.findIndex((h) => h.startsWith(w));
      if (i < 0) {
        okAll = false;
        break;
      }
      s += i < label.split(/\s+/).length ? i : 10 + i; // label hits beat group hits
    }
    if (!okAll) continue;
    if (label.startsWith(words.join(" "))) s -= 5;
    scored.push({ c, s: s + label.length / 100 });
  }
  return scored.sort((a, b) => a.s - b.s).slice(0, limit).map((x) => x.c);
}

export const isPaletteKey = (e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">) => (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k";
