"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { ApiError, authApi, newOperationId } from "@/lib/api";
import { newPasswordError } from "@/lib/routing";
import { useSession } from "@/lib/session";
import { Banner, Button, PageTitle, TextField } from "../ui";

/** password_change_screen.dart. Forced after a temporary password, or voluntary from Settings. */
export function PasswordForm({ voluntary = false }: { voluntary?: boolean }) {
  const { context, refresh, logout } = useSession();
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  // One operation id per attempt; a network retry reuses it (server is idempotent).
  const op = useRef<string | null>(null);

  const code = context?.employee.code;
  const nextErr = touched ? newPasswordError(next, code) ?? (next && next === current ? "Choose a password different from the current one." : null) : null;
  const confirmErr = touched && confirm !== next ? "Passwords do not match" : null;
  const currentErr = touched && !current ? "Enter your current password" : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    setFieldErrors({});
    if (!current || newPasswordError(next, code) || next === current || confirm !== next || busy) return;
    setBusy(true);
    setError(null);
    op.current ??= newOperationId();
    try {
      await authApi.changePassword(op.current, current, next);
      op.current = null;
      setDone(true);
      await refresh();
      if (voluntary) router.replace("/settings");
    } catch (err) {
      if (err instanceof ApiError) {
        if (!err.isNetwork) op.current = null;
        setFieldErrors(err.fieldErrors);
        setError(err.fieldErrors.current_password || err.fieldErrors.new_password ? null : err.message);
        if (err.fieldErrors.current_password) setCurrent("");
      } else {
        setError("Could not change the password. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh bg-surface">
      <PageTitle title={voluntary ? "Change password" : "Set a new password"} back={voluntary ? "/settings" : undefined} />
      <form onSubmit={submit} noValidate className="mx-auto flex max-w-[440px] flex-col gap-4 px-6 pb-10 pt-2">
        {!voluntary && (
          <Banner tone="info">
            {context?.credential_hold
              ? "A password change was interrupted. Finish it to continue."
              : "You signed in with a temporary password. Choose your own to continue."}
          </Banner>
        )}
        {done && <Banner tone="success">Password changed. Other devices were signed out.</Banner>}
        <TextField
          label="Current password"
          revealable
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          error={fieldErrors.current_password ? "Your current password is incorrect." : currentErr}
        />
        <TextField
          label="New password"
          revealable
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          error={fieldErrors.new_password ? "This password is not accepted." : nextErr}
          hint="12 or more characters. Not your employee ID."
        />
        <TextField
          label="Confirm new password"
          revealable
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={confirmErr}
        />
        {error && <Banner>{error}</Banner>}
        <Button type="submit" busy={busy} className="mt-4">
          Change password
        </Button>
        {!voluntary && (
          <Button type="button" variant="text" onClick={() => void logout()}>
            Sign out
          </Button>
        )}
      </form>
    </div>
  );
}
