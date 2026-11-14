"use client";

import { useState } from "react";
import { exploreModules } from "@/lib/menu";
import { useSession } from "@/lib/session";
import { ModuleCard, PageTitle } from "../ui";

export function Explore() {
  const { caps } = useSession();
  const [open, setOpen] = useState<string | null>(null);
  const modules = exploreModules(caps);
  return (
    <>
      <PageTitle title="Explore" />
      <div className="mx-auto flex max-w-xl flex-col gap-4 p-page">
        {modules.map((m) => (
          <ModuleCard
            key={m.id}
            title={m.title}
            subtitle={m.subtitle}
            card={m.card}
            action={m.action}
            art={m.art}
            expanded={open === m.id}
            onToggle={() => setOpen((o) => (o === m.id ? null : m.id))}
            actions={m.actions}
          />
        ))}
      </div>
    </>
  );
}
