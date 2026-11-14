"use client";

// Ctrl/⌘-K for HR/Admin: jump to a screen or an employee.

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { type Command, commandItems, isPaletteKey, rankCommands } from "@/lib/command";
import type { EmployeeRow, Paged } from "@/lib/people";
import { useSession } from "@/lib/session";
import { useRpc } from "@/lib/use-rpc";
import { cx } from "./ui";

type Row = Command & { kind: "screen" | "employee" };

export function CommandPalette() {
  const { phase, caps } = useSession();
  const enabled = phase === "ready" && caps.isHrOrAdmin;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (isPaletteKey(e)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
  if (!enabled || !open) return null;
  return <Palette onClose={() => setOpen(false)} />;
}

function Palette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { caps } = useSession();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  const all = useMemo(() => commandItems(caps), [caps]);
  const people = useRpc<Paged<EmployeeRow>>(caps.canViewEmployees && debounced.length >= 2 ? "list_employees" : null, { p_search: debounced, p_status: "all", p_team_id: null, p_department_id: null, p_limit: 5, p_offset: 0 });
  const rows: Row[] = [
    ...rankCommands(all, q).map((c) => ({ ...c, kind: "screen" as const })),
    ...(debounced.length >= 2 ? (people.data?.rows ?? []).map((e) => ({ label: `${e.name} · ${e.code}`, href: `/employees/${e.id}`, group: "Employees", kind: "employee" as const })) : []),
  ];
  const go = (r: Row | undefined) => {
    if (!r) return;
    onClose();
    router.push(r.href);
  };
  const sel = Math.min(active, Math.max(0, rows.length - 1));
  return (
    <div role="dialog" aria-modal="true" aria-label="Search" className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 p-4 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-lg overflow-hidden rounded-[20px] bg-surface shadow-xl">
        <input
          ref={input}
          value={q}
          aria-label="Search screens and people"
          placeholder="Search screens and people…"
          role="combobox"
          aria-expanded="true"
          aria-controls="cmd-list"
          aria-activedescendant={rows[sel] ? `cmd-${sel}` : undefined}
          className="min-h-14 w-full border-b border-border bg-transparent px-5 text-body-lg outline-none"
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((sel + 1) % Math.max(1, rows.length));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((sel - 1 + rows.length) % Math.max(1, rows.length));
            } else if (e.key === "Enter") {
              e.preventDefault();
              go(rows[sel]);
            }
          }}
        />
        <ul id="cmd-list" role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto py-2">
          {rows.length === 0 && <li className="px-5 py-3 text-body-md text-text-secondary">{people.isLoading ? "Searching…" : "No matches"}</li>}
          {rows.map((r, i) => (
            <li
              key={`${r.kind}:${r.href}`}
              id={`cmd-${i}`}
              role="option"
              aria-selected={i === sel}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(r)}
              className={cx("flex cursor-pointer items-center gap-3 px-5 py-2.5", i === sel && "bg-background")}
            >
              <span className="min-w-0 flex-1 truncate">{r.label}</span>
              <span className="shrink-0 text-body-sm text-text-secondary">{r.group}</span>
            </li>
          ))}
        </ul>
        <p className="border-t border-border px-5 py-2 text-body-sm text-text-secondary">↑↓ to move · Enter to open · Esc to close</p>
      </div>
    </div>
  );
}
