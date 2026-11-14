"use client";

import { useState, type FormEvent } from "react";
import { ApiError } from "@/lib/api";
import { employeeCodeError } from "@/lib/routing";
import { useSession } from "@/lib/session";
import { Art, Banner, Button, TextField } from "../ui";

export function LoginForm() {
  const { login, loginTwoStep, message } = useSession();
  const [challenge, setChallenge] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const codeErr = touched ? employeeCodeError(code) : null;
  const pwErr = touched && !password ? "Enter your password" : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (employeeCodeError(code) || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await login(code.trim().toUpperCase(), password);
      if (next?.challenge) {
        setChallenge(next.challenge);
        setOtp("");
        setPassword("");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign in. Please try again.");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    const clean = otp.replace(/[\s-]/g, "");
    if (busy || !challenge) return;
    if (recovery ? !/^[A-Za-z0-9]{8}$/.test(clean) : !/^\d{6}$/.test(clean)) {
      setError(recovery ? "Enter one of your recovery codes, like K7QM-2XRP." : "Enter the 6-digit code from your authenticator app.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await loginTwoStep(challenge, otp);
    } catch (err) {
      if (err instanceof ApiError && err.code === "CHALLENGE_EXPIRED") {
        setChallenge(null);
        setError(err.message);
      } else setError(err instanceof ApiError ? err.message : "Could not sign in. Please try again.");
      setOtp("");
    } finally {
      setBusy(false);
    }
  }

  if (challenge) {
    return (
      <main className="grid min-h-dvh place-items-center bg-surface px-8 py-8">
        <form onSubmit={submitCode} noValidate className="flex w-full max-w-[440px] flex-col">
          <div className="mx-auto">
            <Art name="lock" size={88} />
          </div>
          <h1 className="mt-4 text-center text-headline-md font-medium">Two-step sign-in</h1>
          <p className="mt-2 text-center text-body-md text-text-secondary">
            {recovery ? "Enter one of the recovery codes you saved. Each code works once." : "Open your authenticator app and enter the 6-digit code for HRMS."}
          </p>
          <div className="mt-8 flex flex-col gap-4">
            <TextField
              label={recovery ? "Recovery code" : "6-digit code"}
              autoComplete="one-time-code"
              inputMode={recovery ? "text" : "numeric"}
              autoCapitalize={recovery ? "characters" : "off"}
              autoCorrect="off"
              spellCheck={false}
              maxLength={recovery ? 12 : 9}
              autoFocus
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
            />
            {error && <Banner>{error}</Banner>}
          </div>
          <Button type="submit" busy={busy} className="mt-8">
            Verify
          </Button>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button
              variant="text"
              onClick={() => {
                setRecovery(!recovery);
                setOtp("");
                setError(null);
              }}
            >
              {recovery ? "Use the app code instead" : "Use a recovery code"}
            </Button>
            <Button
              variant="text"
              onClick={() => {
                setChallenge(null);
                setRecovery(false);
                setError(null);
              }}
            >
              Start over
            </Button>
          </div>
          <p className="mt-2 text-center text-body-sm text-text-secondary">Lost your phone and codes? Ask your Admin to turn off two-step sign-in for you.</p>
        </form>
      </main>
    );
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-surface px-8 py-8">
      <form onSubmit={submit} noValidate className="flex w-full max-w-[440px] flex-col">
        <div className="mx-auto">
          <Art name="attendance" size={110} big />
        </div>
        <h1 className="mt-4 text-center text-headline-md font-medium">Welcome</h1>
        <p className="mt-2 text-center text-body-md text-text-secondary">Sign in with your employee ID</p>
        <div className="mt-8 flex flex-col gap-4">
          {message && !error && <Banner tone="warning">{message}</Banner>}
          <TextField
            label="Employee ID"
            placeholder="e.g. EMP001"
            icon="badge"
            autoComplete="username"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={32}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            error={codeErr}
          />
          <TextField
            label="Password"
            icon="lock"
            revealable
            autoComplete="current-password"
            autoCorrect="off"
            spellCheck={false}
            maxLength={256}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={pwErr}
          />
          {error && <Banner>{error}</Banner>}
        </div>
        <Button type="submit" busy={busy} className="mt-8">
          Sign in
        </Button>
        <p className="mt-4 text-center text-body-md text-text-secondary">
          Forgot your password? Ask HR or your Admin to reset it.
        </p>
      </form>
    </main>
  );
}
