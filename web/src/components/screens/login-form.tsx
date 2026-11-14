"use client";

import { useState, type FormEvent } from "react";
import { ApiError } from "@/lib/api";
import { employeeCodeError } from "@/lib/routing";
import { useSession } from "@/lib/session";
import { Art, Banner, Button, TextField } from "../ui";

export function LoginForm() {
  const { login, message } = useSession();
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
      await login(code.trim().toUpperCase(), password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign in. Please try again.");
      setPassword("");
    } finally {
      setBusy(false);
    }
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
