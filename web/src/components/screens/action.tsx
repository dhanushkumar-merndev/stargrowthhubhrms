"use client";

// action_screen.dart: a white card with the User / HR / Admin switcher (the
// jelly pill, as in the bottom bar), a divider, then the rows of the chosen
// group. Rows carry live numbers: paid leave left, your requests waiting,
// reviews waiting for you.

import { useState } from "react";
import type { Balances } from "@/lib/leave";
import { type ActionItem, actionScopes, type Scope } from "@/lib/menu";
import type { RequestRow } from "@/lib/requests";
import { useSession } from "@/lib/session";
import { useRpc } from "@/lib/use-rpc";
import { ActionRow, Art, PageTitle, cx } from "../ui";

/** Paid leave left in half-day units summed over types, or null when unknown. */
export function paidUnitsLeft(b: Balances | undefined): number | null {
  const rows = b?.balances ?? [];
  const known = rows.filter((r) => typeof r.available_units === "number");
  return known.length ? known.reduce((s, r) => s + (r.available_units ?? 0), 0) : null;
}

export function daysLabel(units: number): string {
  const d = units / 2;
  return `${Number.isInteger(d) ? d : d.toFixed(1)} ${d === 1 ? "day" : "days"}`;
}

export function Action() {
  const { caps } = useSession();
  const [selected, setSelected] = useState<Scope>("user");
  const reviews = useRpc<{ pending_reviews: number }>(caps.canReview ? "get_home_summary" : null).data?.pending_reviews ?? 0;
  const leftUnits = paidUnitsLeft(useRpc<Balances>("get_leave_balances", { p_leave_year: null }).data);
  const pending = (useRpc<RequestRow[]>("list_my_requests", { p_kind: null, p_state: null, p_limit: 100 }).data ?? []).filter(
    (r) => r.state === "submitted" || r.state === "under_review",
  ).length;
  const scopes = actionScopes(caps);
  const index = Math.max(0, scopes.findIndex((s) => s.scope === selected));
  const active = scopes[index];
  const live = (it: ActionItem): ActionItem & { badge?: string } => {
    if (it.href === "/leave/apply" && leftUnits !== null) return { ...it, subtitle: `${daysLabel(leftUnits)} of paid leave left` };
    if (it.href === "/requests") return pending > 0 ? { ...it, subtitle: `${pending} waiting for approval`, badge: String(pending) } : it;
    if (it.href === "/approvals")
      return reviews > 0 ? { ...it, subtitle: `${reviews} waiting for your decision`, badge: String(reviews) } : { ...it, subtitle: "Nothing waiting right now" };
    return it;
  };
  return (
    <>
      <PageTitle title="Actions" />
      {scopes.length > 1 && (
        <div className="mx-auto max-w-xl px-page md:max-w-3xl lg:max-w-6xl">
          <div className="mt-6 overflow-hidden rounded-[18px] border border-border bg-surface shadow-[0_4px_14px_-1px_rgba(38,51,66,0.11),0_1px_6px_rgba(38,51,66,0.05)]">
            <div role="tablist" aria-label="Action groups" className="relative flex h-[72px]">
              <span
                aria-hidden
                key={index}
                className="jelly-pill pointer-events-none absolute top-[11px] h-8 w-16 rounded-full bg-attendance-card"
                style={{ left: `calc(${(index * 100) / scopes.length}% + ${100 / scopes.length / 2}% - 32px)` }}
              />
              {scopes.map((s, i) => (
                <button
                  key={s.scope}
                  role="tab"
                  type="button"
                  aria-selected={i === index}
                  onClick={() => setSelected(s.scope)}
                  className="relative z-10 flex flex-1 flex-col items-center justify-start gap-1 pt-[16px]"
                >
                  <span className={cx("transition-opacity", i === index ? "opacity-100" : "opacity-70")}>
                    <Art name={s.art} size={22} />
                  </span>
                  <span className={cx("text-[13px] leading-[1.2]", i === index ? "font-semibold text-primary" : "font-medium text-text-secondary")}>{s.label}</span>
                </button>
              ))}
            </div>
          </div>
          <hr className="mt-3 border-border" />
        </div>
      )}
      <div role="tabpanel" key={active.scope} className="mx-auto flex max-w-xl flex-col gap-2 px-page pb-6 pt-3 md:grid md:max-w-3xl md:grid-cols-2 md:gap-3 lg:max-w-6xl lg:grid-cols-3">
        {active.items.map(live).map((it) => (
          <ActionRow key={it.href + it.label} art={it.art} label={it.label} subtitle={it.subtitle} tile={it.tile} href={it.href} badge={it.badge} />
        ))}
      </div>
    </>
  );
}
