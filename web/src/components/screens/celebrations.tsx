"use client";

// Birthdays and work anniversaries: a Home card and the privacy choices.

import { useState } from "react";
import { rpc } from "@/lib/api";
import { dayLabel } from "@/lib/attendance";
import { useRpc } from "@/lib/use-rpc";
import { Toggle, useAction } from "../forms";
import { Art, Banner, Button, ErrorState, LoadingState, PageTitle, SectionCard, SectionHeader } from "../ui";

export interface Celebration {
  employee_id: string;
  name: string;
  kind: "birthday" | "anniversary";
  date: string;
  years: number | null;
  is_today: boolean;
  is_me: boolean;
}

const ordinal = (n: number) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
};

/** "Asha's birthday" / "Your 3rd work anniversary" and when. */
export function celebrationText(c: Celebration, today: string): { title: string; when: string } {
  const who = c.is_me ? "Your" : `${c.name}'s`;
  const title = c.kind === "birthday" ? `${who} birthday` : `${who} ${c.years && c.years > 0 ? `${ordinal(c.years)} ` : ""}work anniversary`;
  const tomorrow = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10) + 1)).toISOString().slice(0, 10);
  const when = c.is_today || c.date === today ? "Today" : c.date === tomorrow ? "Tomorrow" : dayLabel(c.date);
  return { title, when };
}

/** Home card; hidden when nothing is coming up or the list cannot load. */
export function CelebrationsCard() {
  const q = useRpc<{ today: string; rows: Celebration[] }>("list_celebrations", { p_days: 7 });
  const rows = q.data?.rows ?? [];
  if (!q.data || rows.length === 0) return null;
  return (
    <section aria-label="Celebrations" className="flex flex-col gap-2">
      <SectionHeader title="Celebrations" href="/settings/celebrations" moreLabel="Privacy" />
      <SectionCard>
        <ul className="flex flex-col gap-3">
          {rows.slice(0, 6).map((c) => {
            const t = celebrationText(c, q.data!.today);
            return (
              <li key={`${c.kind}:${c.employee_id}`} className="flex items-center gap-3">
                <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-full bg-leave-card">
                  <Art name={c.kind === "birthday" ? "celebration" : "badge"} size={22} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{t.title}</span>
                  <span className={t.when === "Today" ? "block text-body-sm font-semibold text-primary" : "block text-body-sm text-text-secondary"}>{t.when}</span>
                </span>
              </li>
            );
          })}
        </ul>
        {rows.length > 6 && <p className="mt-3 text-body-sm text-text-secondary">and {rows.length - 6} more this week</p>}
      </SectionCard>
    </section>
  );
}

interface Prefs {
  share_birthday: boolean;
  share_anniversary: boolean;
  has_birthday: boolean;
}

export function CelebrationSettings() {
  const q = useRpc<Prefs>("get_celebration_prefs", {});
  const [saved, setSaved] = useState(false);
  return (
    <>
      <PageTitle title="Birthday and anniversary" back="/settings" />
      <div className="mx-auto flex max-w-xl flex-col gap-4 p-page">
        {q.error ? <ErrorState message="Could not load your choices." onRetry={() => void q.mutate()} /> : !q.data ? <LoadingState /> : <PrefsForm key={JSON.stringify(q.data)} prefs={q.data} saved={saved} onSaved={async () => { await q.mutate(); setSaved(true); }} onEdit={() => setSaved(false)} />}
      </div>
    </>
  );
}

function PrefsForm({ prefs, saved, onSaved, onEdit }: { prefs: Prefs; saved: boolean; onSaved: () => Promise<void>; onEdit: () => void }) {
  const [birthday, setBirthday] = useState(prefs.share_birthday);
  const [anniversary, setAnniversary] = useState(prefs.share_anniversary);
  const a = useAction();
  return (
    <SectionCard>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          onEdit();
          a.run(async () => {
            await rpc("set_celebration_prefs", { p_share_birthday: birthday, p_share_anniversary: anniversary });
            await onSaved();
          }, "Could not save.");
        }}
      >
        <p className="text-body-md text-text-secondary">Colleagues see these on their Home screen during the week of the day. Your age and year of birth are never shown.</p>
        {saved && <Banner tone="success">Saved.</Banner>}
        {a.error && <Banner>{a.error}</Banner>}
        <Toggle
          label="Show my birthday"
          checked={birthday}
          onChange={setBirthday}
          hint={prefs.has_birthday ? "Day and month only." : "Add your date of birth in your profile first; until then nothing is shown."}
        />
        <Toggle label="Show my work anniversary" checked={anniversary} onChange={setAnniversary} hint="Based on your joining date." />
        <Button type="submit" busy={a.busy}>
          Save
        </Button>
      </form>
    </SectionCard>
  );
}
