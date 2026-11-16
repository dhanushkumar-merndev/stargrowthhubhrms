"use client";

// punch_screen.dart for the browser: shift card, passkey setup, live
// distance estimate and the signed check-in / check-out.

import Link from "next/link";
import { useState } from "react";
import { blockedText, clock, duration, type Shift } from "@/lib/attendance";
import { browserDeps, distanceMeters, punchErrorText, registerPasskey, submitPunch, type PunchDeps, type PunchResult, type Sample } from "@/lib/punch";
import { useSession } from "@/lib/session";
import { useRpc } from "@/lib/use-rpc";
import { Banner, Button, ErrorState, LoadingState, PageTitle, SectionCard, StatusChip } from "../ui";

interface Summary {
  shift: Shift | null;
  device: { device_id: string } | null;
}
interface WebDevice {
  device_id: string;
  platform: string;
  credential_id: string | null;
  label: string | null;
}

type Step = "idle" | "locating" | "registering" | "verifying";

export function Punch({ deps }: { deps?: PunchDeps }) {
  const { context } = useSession();
  const summary = useRpc<Summary>("get_home_summary");
  const device = useRpc<WebDevice | null>("get_my_web_device");
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<PunchResult["data"] | null>(null);
  const [preview, setPreview] = useState<Sample | null>(null);

  if (summary.error || device.error) {
    return (
      <>
        <PageTitle title="Check in / out" back="/home" />
        <ErrorState
          message={(summary.error ?? device.error)!.message}
          onRetry={() => {
            void summary.mutate();
            void device.mutate();
          }}
        />
      </>
    );
  }
  if (!summary.data || device.data === undefined || !context) {
    return (
      <>
        <PageTitle title="Check in / out" back="/home" />
        <LoadingState />
      </>
    );
  }

  const d = () => deps ?? browserDeps();
  const me = { id: context.employee.id, code: context.employee.code, name: context.employee.name };
  const shift = summary.data.shift;
  const web = device.data && device.data.platform === "web" ? device.data : null;
  const action = shift?.next_action ?? null;
  const target = action === "IN" ? shift?.instance_id : shift?.session_id;
  const blocked = blockedText(shift?.blocked_reason, shift);
  const busy = step !== "idle";

  const register = async () => {
    setError(null);
    setStep("registering");
    try {
      await registerPasskey(d(), me, browserLabel());
      await Promise.all([device.mutate(), summary.mutate()]);
    } catch (e) {
      setError(punchErrorText(e));
    } finally {
      setStep("idle");
    }
  };

  const check = async () => {
    setError(null);
    setStep("locating");
    try {
      setPreview(await d().locate());
    } catch (e) {
      setError(punchErrorText(e));
    } finally {
      setStep("idle");
    }
  };

  const punch = async () => {
    if (!shift || !action || !target || !web || !shift.office) return;
    setError(null);
    setStep("verifying");
    try {
      const r = await submitPunch(d(), me, {
        action,
        targetId: target,
        officeId: shift.office.id,
        deviceId: web.device_id,
        credentialId: web.credential_id,
      });
      setDone(r.data);
      void summary.mutate();
    } catch (e) {
      setError(punchErrorText(e));
      void summary.mutate();
    } finally {
      setStep("idle");
    }
  };

  const distance =
    preview && shift?.office ? Math.round(distanceMeters(preview.latitude, preview.longitude, shift.office.latitude, shift.office.longitude)) : null;

  return (
    <>
      <PageTitle title="Check in / out" back="/home" />
      <div className="mx-auto flex max-w-xl md:max-w-2xl flex-col gap-4 p-page">
        {done ? (
          <SectionCard className="bg-success-soft">
            <div role="status" className="flex flex-col gap-1">
              <p className="text-title-md font-semibold text-success">{done.action === "IN" ? "Checked in" : "Checked out"}</p>
              <p className="text-body-md text-text">
                at {clock(done.server_time, shift?.timezone ?? context.org.timezone)}
                {done.distance_m != null && ` · ${Math.round(done.distance_m)} m from the office`}
              </p>
              {done.is_late && <p className="text-body-md text-warning">Late by {duration(done.late_seconds)}</p>}
              {done.is_early_departure && <p className="text-body-md text-warning">Left before the shift ended</p>}
            </div>
            <Link href="/home" className="mt-3 inline-flex min-h-12 items-center font-semibold text-primary">
              Back to home
            </Link>
          </SectionCard>
        ) : !shift ? (
          <SectionCard>
            <p className="text-title-sm font-semibold">No shift today</p>
            <p className="text-body-md text-text-secondary">You have no shift scheduled right now.</p>
          </SectionCard>
        ) : (
          <SectionCard>
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-title-sm font-semibold">{shift.office?.name ?? "No office"}</p>
                <p className="text-body-md text-text-secondary">
                  {clock(shift.start_at, shift.timezone)} – {clock(shift.end_at, shift.timezone)}
                </p>
                {shift.effective_in_at && (
                  <p className="text-body-md text-text-secondary">Checked in at {clock(shift.effective_in_at, shift.timezone)}</p>
                )}
              </div>
              {action && <StatusChip label={action === "IN" ? "Ready to check in" : "Ready to check out"} tone="info" />}
            </div>
          </SectionCard>
        )}

        {!done && blocked && !action && <Banner tone="info">{blocked}</Banner>}
        {error && <Banner>{error}</Banner>}

        {!done && action && !web && (
          <SectionCard>
            <p className="text-title-sm font-semibold">Set up this device for punching</p>
            <p className="mt-1 text-body-md text-text-secondary">
              A passkey links punching to this device and your fingerprint, face or screen lock. Setting it up on a new device
              stops punching from the old one.
            </p>
            <Button className="mt-4 w-full" busy={step === "registering"} disabled={busy} onClick={register}>
              Set up passkey
            </Button>
          </SectionCard>
        )}

        {!done && action && web && (
          <>
            {distance != null && shift?.office && (
              <p className="text-body-md text-text-secondary" aria-live="polite">
                About {distance} m from {shift.office.name} (±{Math.round(preview!.accuracy)} m).{" "}
                {distance > shift.office.radius_m ? "You may be outside the office area." : "You are inside the office area."}
              </p>
            )}
            <Button variant="outlined" busy={step === "locating"} disabled={busy} onClick={check}>
              Check my location
            </Button>
            <Button busy={step === "verifying"} disabled={busy || !shift?.office} onClick={punch}>
              {action === "IN" ? "Check in" : "Check out"}
            </Button>
            <p className="text-center text-body-sm text-text-secondary">
              You will confirm with your fingerprint, face or screen lock. Your location is sent once, with the punch.
            </p>
            <Button variant="text" busy={step === "registering"} disabled={busy} onClick={register}>
              New device or browser? Set up this device again
            </Button>
          </>
        )}
      </div>
    </>
  );
}

function browserLabel(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}
