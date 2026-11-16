"use client";

import { useState } from "react";
import { actionScopes, type Scope } from "@/lib/menu";
import { useSession } from "@/lib/session";
import { ActionRow, Art, PageTitle, cx } from "../ui";

export function Action() {
  const { caps } = useSession();
  const [selected, setSelected] = useState<Scope>("user");
  const scopes = actionScopes(caps);
  const active = scopes.find((s) => s.scope === selected) ?? scopes[0];
  return (
    <>
      <PageTitle title="Actions" />
      {scopes.length > 1 && (
        <div className="mx-auto max-w-xl px-page pb-3 pt-8 md:max-w-3xl lg:max-w-6xl">
          <div role="tablist" aria-label="Action groups" className="flex gap-2">
            {scopes.map((s) => (
              <button
                key={s.scope}
                role="tab"
                type="button"
                aria-selected={s.scope === active.scope}
                onClick={() => setSelected(s.scope)}
                className={cx(
                  "flex min-h-12 flex-1 items-center justify-center gap-2 rounded-button px-3 text-[15px] font-semibold transition-shadow",
                  s.scope === active.scope
                    ? "bg-surface text-text shadow-[0_4px_14px_-1px_rgba(38,51,66,0.11),0_1px_6px_rgba(38,51,66,0.05)]"
                    : "text-text-secondary",
                )}
              >
                <Art name={s.art} size={22} />
                {s.label}
              </button>
            ))}
          </div>
          <hr className="mt-3 border-border" />
        </div>
      )}
      <div role="tabpanel" key={active.scope} className="mx-auto flex max-w-xl flex-col gap-2 px-page pb-8 pt-3 md:grid md:max-w-3xl md:grid-cols-2 md:gap-3 lg:max-w-6xl lg:grid-cols-3">
        {active.items.map((it) => (
          <ActionRow key={it.href + it.label} art={it.art} label={it.label} subtitle={it.subtitle} tile={it.tile} href={it.href} />
        ))}
      </div>
    </>
  );
}
