"use client";

// Small form building blocks shared by the HR and admin screens.

import { type ReactNode, useId, useState } from "react";
import { ApiError } from "@/lib/api";
import type { Ref } from "@/lib/people";
import { Banner, Button, Sheet, cx } from "./ui";

const msg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export function Select({ label, value, onChange, options, error, placeholder }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; error?: string | null; placeholder?: string }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-body-md font-medium text-text-secondary">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        className={cx("min-h-12 w-full rounded-input border bg-surface px-4", error ? "border-error" : "border-border")}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error && <p className="mt-1 text-body-sm text-error">{error}</p>}
    </div>
  );
}


export const activeOpts = (items: (Ref & { active: boolean })[] | undefined, keep?: string | null) =>
  (items ?? []).filter((x) => x.active || x.id === keep).map((x) => ({ value: x.id, label: x.name }));

/** Runs one async action for a sheet: busy flag, error text and field errors. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const run = async (fn: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await fn();
    } catch (x) {
      if (x instanceof ApiError) setFields(x.fieldErrors);
      setError(x instanceof ApiError && x.code === "STALE_VERSION" ? "This record changed since you opened it. Close and try again." : msg(x, fallback));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, fields, setError, run };
}


export function SheetForm({ title, submit, busy, error, onClose, onSubmit, children }: { title: string; submit: string; busy: boolean; error: string | null; onClose: () => void; onSubmit: () => void; children: ReactNode }) {
  return (
    <Sheet title={title} onClose={onClose}>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(ev) => {
          ev.preventDefault();
          onSubmit();
        }}
      >
        {error && <Banner>{error}</Banner>}
        {children}
        <Button type="submit" busy={busy}>
          {submit}
        </Button>
      </form>
    </Sheet>
  );
}

export type Saved = { onClose: () => void; onSaved: () => Promise<void> };

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-1 size-5 accent-[var(--color-primary)]" />
      <label htmlFor={id} className="flex-1">
        <span className="block font-medium">{label}</span>
        {hint && <span className="block text-body-sm text-text-secondary">{hint}</span>}
      </label>
    </div>
  );
}
