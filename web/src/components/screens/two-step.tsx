"use client";

// Two-step sign-in (authenticator app): turn on with a QR code, keep
// recovery codes, turn off, or get new codes.

import Link from "next/link";
import { useState } from "react";
import { post } from "@/lib/api";
import { useRpc } from "@/lib/use-rpc";
import { useAction } from "../forms";
import { Banner, Button, ErrorState, LoadingState, PageTitle, SectionCard, TextField } from "../ui";

interface Status {
  enabled: boolean;
  enabled_at: string | null;
  recovery_left: number;
  recommended: boolean;
}
interface Setup {
  secret: string;
  uri: string;
  qr_svg: string | null;
}

/** "ABCD EFGH …" for typing the key by hand. */
export const groupKey = (s: string) => s.replace(/(.{4})(?=.)/g, "$1 ");
export const svgDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
export const codesText = (codes: string[]) =>
  `HRMS two-step sign-in recovery codes\nEach code works once. Keep them somewhere safe.\n\n${codes.join("\n")}\n`;

type Mode = "idle" | "password" | "scan" | "codes" | "disable" | "regenerate";

export function TwoStepSettings() {
  const q = useRpc<Status>("get_two_step_status", {});
  const [mode, setMode] = useState<Mode>("idle");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const a = useAction();
  const reset = (m: Mode = "idle") => {
    setMode(m);
    setPassword("");
    setCode("");
    a.setError(null);
  };

  const body = () => {
    if (!q.data) return null;
    if (mode === "codes" && codes)
      return (
        <div className="flex flex-col gap-3">
          <Banner tone="success">Save these recovery codes now. They are shown only once.</Banner>
          <p className="text-body-md">If you lose your phone, sign in with one of these instead of a code. Each works once.</p>
          <ul aria-label="Recovery codes" className="grid grid-cols-2 gap-2 rounded-row bg-background p-3 font-mono text-body-lg">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outlined"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(codes.join("\n"));
                  setNotice("Copied.");
                } catch {
                  a.setError("Could not copy. Write the codes down instead.");
                }
              }}
            >
              Copy
            </Button>
            <a
              className="inline-flex min-h-12 items-center rounded-full px-4 font-semibold text-primary"
              href={`data:text/plain;charset=utf-8,${encodeURIComponent(codesText(codes))}`}
              download="hrms-recovery-codes.txt"
            >
              Download
            </a>
          </div>
          <label className="flex items-center gap-3">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="size-5 accent-[var(--color-primary)]" />
            <span>I have saved my recovery codes</span>
          </label>
          <Button
            disabled={!saved}
            onClick={() => {
              setCodes(null);
              setSaved(false);
              setNotice(null);
              reset();
            }}
          >
            Done
          </Button>
        </div>
      );
    if (mode === "scan" && setup)
      return (
        <form
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!/^\d{6}$/.test(code.replace(/\s/g, ""))) return a.setError("Enter the 6-digit code shown in the app.");
            a.run(async () => {
              const r = await post<{ data: { recovery_codes: string[] } }>("/auth/two-step/enable", { code });
              setCodes(r.data.recovery_codes);
              setSetup(null);
              reset("codes");
              await q.mutate();
            }, "Could not turn on two-step sign-in.");
          }}
        >
          <p className="text-body-md">1. Scan this with Google Authenticator, Microsoft Authenticator or a similar app.</p>
          {setup.qr_svg && (
            // eslint-disable-next-line @next/next/no-img-element -- inline SVG data URL
            <img src={svgDataUrl(setup.qr_svg)} alt="QR code for your authenticator app" width={200} height={200} className="mx-auto rounded-row bg-white p-2" />
          )}
          <a href={setup.uri} className="text-center text-body-md font-semibold text-primary">
            On this phone? Open in your authenticator app
          </a>
          <p className="text-body-sm text-text-secondary">
            Can&apos;t scan? Enter this key: <span className="font-mono text-text">{groupKey(setup.secret)}</span>
          </p>
          <p className="text-body-md">2. Enter the 6-digit code the app shows.</p>
          <TextField label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} error={a.fields.code} />
          <div className="flex gap-3">
            <Button type="submit" busy={a.busy}>
              Turn on
            </Button>
            <Button variant="text" onClick={() => (setSetup(null), reset())}>
              Cancel
            </Button>
          </div>
        </form>
      );
    if (mode === "password")
      return (
        <form
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            a.run(async () => {
              const r = await post<{ data: Setup }>("/auth/two-step/setup", { password });
              setSetup(r.data);
              reset("scan");
            }, "Could not start the setup.");
          }}
        >
          <p className="text-body-md">Confirm it&apos;s you to start.</p>
          <TextField label="Your password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={a.fields.password} />
          <div className="flex gap-3">
            <Button type="submit" busy={a.busy} disabled={!password}>
              Continue
            </Button>
            <Button variant="text" onClick={() => reset()}>
              Cancel
            </Button>
          </div>
        </form>
      );
    if (mode === "disable" || mode === "regenerate")
      return (
        <form
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            a.run(async () => {
              if (mode === "disable") {
                await post("/auth/two-step/disable", { password, code });
                setNotice("Two-step sign-in is off.");
                reset();
              } else {
                const r = await post<{ data: { recovery_codes: string[] } }>("/auth/two-step/recovery", { password, code });
                setCodes(r.data.recovery_codes);
                reset("codes");
              }
              await q.mutate();
            }, "Could not do that.");
          }}
        >
          <p className="text-body-md">{mode === "disable" ? "Turning it off makes your account easier to break into." : "Your old recovery codes will stop working."}</p>
          <TextField label="Your password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={a.fields.password} />
          <TextField label="Code from your app (or a recovery code)" autoComplete="one-time-code" maxLength={12} value={code} onChange={(e) => setCode(e.target.value)} error={a.fields.code} />
          <div className="flex gap-3">
            <Button type="submit" variant={mode === "disable" ? "danger" : "filled"} busy={a.busy} disabled={!password || !code}>
              {mode === "disable" ? "Turn off" : "Get new codes"}
            </Button>
            <Button variant="text" onClick={() => reset()}>
              Cancel
            </Button>
          </div>
        </form>
      );
    return q.data.enabled ? (
      <div className="flex flex-col gap-3">
        <p className="text-body-md font-semibold text-success">Two-step sign-in is on.</p>
        <p className="text-body-sm text-text-secondary">
          On since {q.data.enabled_at ? new Date(q.data.enabled_at).toLocaleDateString("en-IN", { dateStyle: "medium" }) : "—"} · {q.data.recovery_left} recovery codes left
        </p>
        {q.data.recovery_left <= 3 && <Banner tone="warning">You are running low on recovery codes. Get new ones.</Banner>}
        <div className="flex flex-wrap gap-3">
          <Button variant="outlined" onClick={() => reset("regenerate")}>
            Get new recovery codes
          </Button>
          <Button variant="text" onClick={() => reset("disable")}>
            Turn off
          </Button>
        </div>
      </div>
    ) : (
      <div className="flex flex-col gap-3">
        {q.data.recommended && <Banner tone="warning">You can see and change other people&apos;s records. Turn this on to protect them.</Banner>}
        <p className="text-body-md">Each sign-in will also need a 6-digit code from an authenticator app on your phone, so a stolen password is not enough.</p>
        <Button onClick={() => (setNotice(null), reset("password"))}>Turn on two-step sign-in</Button>
      </div>
    );
  };

  return (
    <>
      <PageTitle title="Two-step sign-in" back="/settings" />
      <div className="mx-auto flex max-w-xl md:max-w-2xl flex-col gap-4 p-page">
        {notice && <Banner tone="success">{notice}</Banner>}
        {a.error && <Banner>{a.error}</Banner>}
        {q.error ? <ErrorState message="Could not load your sign-in settings." onRetry={() => void q.mutate()} /> : !q.data ? <LoadingState /> : <SectionCard>{body()}</SectionCard>}
      </div>
    </>
  );
}

/** Home nudge for HR/Admin who have not turned it on. */
export function TwoStepNudge() {
  const q = useRpc<Status>("get_two_step_status", {});
  if (!q.data || q.data.enabled || !q.data.recommended) return null;
  return (
    <Link href="/settings/two-step" className="block">
      <Banner tone="warning">Protect your account: turn on two-step sign-in. Tap to set it up (2 minutes).</Banner>
    </Link>
  );
}
