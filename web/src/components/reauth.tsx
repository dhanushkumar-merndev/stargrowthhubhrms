"use client";

// Step-up password check (auth-reauth). Sensitive actions (Admin elevation,
// annual export, archive cleanup, Admin password reset) fail with
// REAUTH_REQUIRED until the person re-enters their password; the grant is
// bound to this session, the action and the target, and is used once.
//
//   await withReauth("role.elevate", employeeId, () => rpc(...))
//
// runs the call, asks for the password only when the server demands it,
// then retries once. <ReauthHost/> (mounted in Providers) shows the sheet.

import { useEffect, useState } from "react";
import { ApiError, authApi } from "@/lib/api";
import { Banner, Button, Sheet, TextField } from "./ui";

export type ReauthAction = "role.elevate" | "archive.cleanup" | "export.bulk_salary" | "export.annual" | "credentials.reset_admin";

interface Request {
  action: ReauthAction;
  target?: string | null;
  resolve: (ok: boolean) => void;
}

let show: ((r: Request) => void) | null = null;

export const CANCELLED = "REAUTH_CANCELLED";

export const ACTION_LABEL: Record<ReauthAction, string> = {
  "role.elevate": "give someone Admin access",
  "archive.cleanup": "delete archived files from cloud storage",
  "export.bulk_salary": "export everyone's salary",
  "export.annual": "create the annual archive",
  "credentials.reset_admin": "reset an Admin's password",
};

/** Asks for the password directly (for flows that know they need it). */
export function askPassword(action: ReauthAction, target?: string | null): Promise<boolean> {
  if (!show) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => show!({ action, target, resolve }));
}

export async function withReauth<T>(action: ReauthAction, target: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== "REAUTH_REQUIRED") throw e;
    if (!(await askPassword(action, target))) throw new ApiError(CANCELLED, "Cancelled. Nothing was changed.", 0);
    return fn();
  }
}

export function ReauthHost() {
  const [req, setReq] = useState<Request | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    show = (r) => {
      setPassword("");
      setError(null);
      setReq((prev) => {
        prev?.resolve(false);
        return r;
      });
    };
    return () => {
      show = null;
    };
  }, []);

  if (!req) return null;
  const close = (ok: boolean) => {
    req.resolve(ok);
    setReq(null);
    setPassword("");
  };
  return (
    <Sheet title="Confirm your password" onClose={() => close(false)}>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={async (ev) => {
          ev.preventDefault();
          if (!password) return setError("Enter your password.");
          setBusy(true);
          setError(null);
          try {
            await authApi.reauth(password, req.action, req.target ?? undefined);
            close(true);
          } catch (x) {
            setError(x instanceof ApiError && (x.code === "REAUTH_REQUIRED" || x.code === "INVALID_CREDENTIALS") ? "That password is not right." : x instanceof Error ? x.message : "Could not check the password.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="text-body-md text-text-secondary">To {ACTION_LABEL[req.action]}, enter your password again.</p>
        {error && <Banner>{error}</Banner>}
        <TextField label="Password" type="password" revealable autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button type="submit" busy={busy}>
          Confirm
        </Button>
      </form>
    </Sheet>
  );
}
