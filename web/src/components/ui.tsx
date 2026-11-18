"use client";

// React versions of hrms/lib/core/widgets (cards.dart, states.dart,
// dialogs.dart). Same sizes, radii and colours as the Android app.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { hasPreviousAppPage } from "@/lib/back-navigation";
import { Glyph } from "./glyphs";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

/** HRMS illustration icon (untinted SVG from /public/illus or /illustrations). */
export function Art({ name, size = 24, big = false, alt = "" }: { name: string; size?: number; big?: boolean; alt?: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- tiny local SVGs; next/image adds nothing here
  return <img src={`/${big ? "illustrations" : "illus"}/${name}.svg`} width={size} height={size} alt={alt} draggable={false} />;
}

export function PageTitle({ title, back, action }: { title: string; back?: string | (() => void); action?: ReactNode }) {
  const router = useRouter();
  return (
    <header className="sticky top-0 z-20 flex items-center gap-1 bg-surface px-4 py-4 pt-[max(16px,env(safe-area-inset-top))]">
      {back !== undefined && (
        <button
          type="button"
          aria-label="Back"
          className="-ml-2 grid size-12 place-items-center rounded-full text-text"
          onClick={() => {
            if (typeof back === "function") back();
            else if (hasPreviousAppPage()) router.back();
            else router.replace(back);
          }}
        >
          <Glyph name="arrow_back" />
        </button>
      )}
      <h1 className={cx("flex-1 text-headline-sm font-medium text-text", back === undefined && "pl-2")}>{title}</h1>
      {action}
    </header>
  );
}

export function SectionCard({ children, className, onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  const cls = cx("block w-full rounded-card border border-border bg-surface p-card text-left", className);
  return onClick ? (
    <button type="button" onClick={onClick} className={cls}>
      {children}
    </button>
  ) : (
    <section className={cls}>{children}</section>
  );
}

export function SectionHeader({ title, href, moreLabel }: { title: string; href?: string; moreLabel?: string }) {
  return (
    <div className="flex items-center">
      <h2 className="flex-1 text-title-lg font-medium">{title}</h2>
      {href && (
        <Link href={href} aria-label={moreLabel ?? `Open ${title}`} className="grid size-12 place-items-center text-text">
          <Glyph name="north_east" />
        </Link>
      )}
    </div>
  );
}

export function CountBadge({ text, tone = "error" }: { text: string; tone?: "error" | "primary" }) {
  return (
    <span className={cx("rounded-xl px-2 py-0.5 text-body-sm font-semibold text-white", tone === "error" ? "bg-error" : "bg-primary")}>
      {text}
    </span>
  );
}

export function ActionRow({
  art,
  label,
  subtitle,
  tile,
  href,
  onClick,
  badge,
}: {
  art: string;
  label: string;
  subtitle?: string;
  tile: string;
  href?: string;
  onClick?: () => void;
  badge?: string;
}) {
  const body = (
    <>
      <span className={cx("grid size-icon-tile shrink-0 place-items-center rounded-xl", tile)}>
        <Art name={art} size={art.startsWith("tile_") || art === "holiday_calendar" ? 40 : 28} big={art.startsWith("tile_") || art === "holiday_calendar"} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-title-md font-medium text-text">{label}</span>
        {subtitle && <span className="block text-body-md text-text-secondary">{subtitle}</span>}
      </span>
      {badge && <CountBadge text={badge} />}
      <Glyph name="chevron_right" className="ml-1 text-text-secondary" />
    </>
  );
  const cls = "flex w-full items-center gap-4 rounded-row border border-border bg-surface p-3 text-left";
  return href ? (
    <Link href={href} className={cls}>
      {body}
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={cls}>
      {body}
    </button>
  );
}

export function Pill({ label, color, href, onClick }: { label: string; color: string; href?: string; onClick?: () => void }) {
  const cls = cx("inline-flex min-h-12 items-center rounded-full px-[22px] py-3 text-[17px] font-semibold text-white", color);
  return href ? (
    <Link href={href} className={cls} onClick={(e) => e.stopPropagation()}>
      {label}
    </Link>
  ) : (
    <button
      type="button"
      className={cls}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
    >
      {label}
    </button>
  );
}

export interface ModuleAction {
  label: string;
  href: string;
}

/** Explore accordion card (cards.dart ModuleCard). */
export function ModuleCard({
  title,
  subtitle,
  card,
  action,
  art,
  expanded,
  onToggle,
  actions,
}: {
  title: string;
  subtitle: string;
  card: string;
  action: string;
  art: string;
  expanded: boolean;
  onToggle: () => void;
  actions: ModuleAction[];
}) {
  const panel = useId();
  return (
    <div className={cx("rounded-card p-card pr-3", card)}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={panel}
        className="flex w-full items-start gap-2 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="line-clamp-2 text-headline-md font-medium leading-[1.2] text-text">{title}</span>
            <Glyph
              name="expand_more"
              size={28}
              className={cx("shrink-0 text-text transition-transform duration-[180ms] motion-reduce:transition-none", expanded && "rotate-180")}
            />
          </span>
          <span className="mt-2 block text-[16px] leading-[1.35] text-text">{subtitle}</span>
        </span>
        <Art name={art} size={96} big />
      </button>
      {expanded && actions.length > 0 && (
        <div id={panel} className="mt-4 flex flex-wrap gap-3">
          {actions.map((a) => (
            <Pill key={a.label} label={a.label} color={action} href={a.href} />
          ))}
        </div>
      )}
    </div>
  );
}

export type Tone = "success" | "warning" | "error" | "info" | "neutral";
const TONES: Record<Tone, string> = {
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  error: "bg-error-soft text-error",
  info: "bg-attendance-card text-primary",
  neutral: "bg-[#eff1f4] text-text-secondary",
};

export function StatusChip({ label, tone }: { label: string; tone: Tone }) {
  return <span className={cx("inline-flex items-center rounded-[20px] px-2.5 py-1 text-body-sm font-semibold", TONES[tone])}>{label}</span>;
}

export function Banner({ children, tone = "error" }: { children: ReactNode; tone?: "error" | "warning" | "success" | "info" }) {
  const cls = {
    error: "bg-error-soft text-error",
    warning: "bg-warning-soft text-warning",
    success: "bg-success-soft text-success",
    info: "bg-attendance-card text-primary",
  }[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cx("rounded-input px-4 py-3 text-body-md font-medium", cls)}>
      {children}
    </div>
  );
}

export function Spinner({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={cx("animate-spin", className)} aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="2.4" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "filled" | "outlined" | "text" | "danger"; busy?: boolean };

export function Button({ variant = "filled", busy, disabled, className, children, ...rest }: ButtonProps) {
  const v = {
    filled: "min-h-[52px] bg-primary text-white disabled:bg-[#e3e3e8] disabled:text-[#9aa1ac]",
    danger: "min-h-[52px] bg-error text-white disabled:opacity-50",
    outlined: "min-h-12 border border-border bg-surface text-primary disabled:opacity-50",
    text: "min-h-12 text-primary disabled:opacity-50",
  }[variant];
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx("inline-flex items-center justify-center gap-2 rounded-button px-4 text-[16px] font-semibold", v, className)}
    >
      {busy ? <Spinner /> : children}
    </button>
  );
}

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  label: string;
  error?: string | null;
  hint?: string;
  icon?: string;
  revealable?: boolean;
};

export function TextField({ label, error, hint, icon, revealable, type, id, className, ...rest }: FieldProps) {
  const auto = useId();
  const fid = id ?? auto;
  const [shown, setShown] = useState(false);
  const describedBy = error ? `${fid}-err` : hint ? `${fid}-hint` : undefined;
  return (
    <div className={className}>
      <label htmlFor={fid} className="mb-1.5 block text-body-md font-medium text-text-secondary">
        {label}
      </label>
      <div
        className={cx(
          "flex items-center rounded-input border bg-surface focus-within:outline-[1.6px] focus-within:outline-primary",
          error ? "border-error" : "border-border",
        )}
      >
        {icon && (
          <span className="pl-3.5">
            <Art name={icon} size={20} />
          </span>
        )}
        <input
          {...rest}
          id={fid}
          type={revealable ? (shown ? "text" : "password") : type}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className="min-h-[52px] w-full min-w-0 flex-1 bg-transparent px-4 py-3.5 text-body-lg text-text outline-none placeholder:text-[#9aa1ac]"
        />
        {revealable && (
          <button
            type="button"
            onClick={() => setShown((s) => !s)}
            aria-label={shown ? "Hide password" : "Show password"}
            className="grid size-12 place-items-center text-text-secondary"
          >
            <Glyph name={shown ? "visibility_off" : "visibility"} />
          </button>
        )}
      </div>
      {error ? (
        <p id={`${fid}-err`} className="mt-1 text-body-sm text-error">
          {error}
        </p>
      ) : hint ? (
        <p id={`${fid}-hint`} className="mt-1 text-body-sm text-text-secondary">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** states.dart: loading / empty / error placeholders. */
export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" className="grid place-items-center gap-3 py-16 text-primary">
      <Spinner size={32} />
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function EmptyState({ art = "inbox", title, body }: { art?: string; title: string; body?: string }) {
  return (
    <div className="grid place-items-center gap-2 px-6 py-14 text-center">
      <Art name={art} size={72} />
      <p className="mt-2 text-title-md font-semibold">{title}</p>
      {body && <p className="text-body-md text-text-secondary">{body}</p>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="grid place-items-center gap-3 px-6 py-14 text-center">
      <Art name="cloud_off" size={72} />
      <p className="text-body-lg text-text">{message}</p>
      {onRetry && (
        <Button variant="outlined" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** dialogs.dart: bottom sheet on phones, centred dialog on wider screens. */
export function Sheet({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
    >
      <div className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-[24px] bg-surface p-6 sm:rounded-[24px]">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-title-md font-semibold">{title}</h2>
          <Button variant="text" onClick={onClose} aria-label="Close">
            Close
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** pill_tabs.dart: a row of filter pills. */
export function PillTabs<K extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: readonly { id: K; label: string }[];
  value: K;
  onChange: (k: K) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            "min-h-10 shrink-0 rounded-[20px] px-4 text-body-md font-semibold",
            value === t.id ? "bg-primary text-white" : "border border-border bg-surface text-text",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** A multi-line text field with the same label/error layout as TextField. */
export function TextArea({
  label,
  value,
  onChange,
  error,
  hint,
  rows = 4,
  maxLength = 500,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  hint?: string;
  rows?: number;
  maxLength?: number;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-body-md font-medium text-text-secondary">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        maxLength={maxLength}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined}
        className={cx(
          "w-full rounded-input border bg-surface px-4 py-3 text-body-lg outline-none focus:outline-[1.6px] focus:outline-primary",
          error ? "border-error" : "border-border",
        )}
      />
      {error ? (
        <p id={`${id}-err`} className="mt-1 text-body-sm text-error">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-body-sm text-text-secondary">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** cards.dart KeyValueRow. */
export function KeyValue({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="text-body-md text-text-secondary">{k}</span>
      <span className="text-right text-body-md font-medium text-text">{v}</span>
    </div>
  );
}
