"use client";

// Session gate (router.dart redirect): splash while loading, retry when the
// API is unreachable, and phase-based redirects everywhere else.

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useSession } from "@/lib/session";
import { redirectFor } from "@/lib/routing";
import { Art, Button, Spinner } from "./ui";

export function Gate({ children }: { children: React.ReactNode }) {
  const { phase, refresh } = useSession();
  const path = usePathname();
  const router = useRouter();
  const target = redirectFor(phase, path);

  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);

  if (path === "/offline") return <>{children}</>;
  if (phase === "loading" || target) return <Splash />;
  if (phase === "unreachable") {
    return (
      <main className="grid min-h-dvh place-items-center bg-surface p-8 text-center">
        <div className="grid max-w-sm place-items-center gap-4">
          <Art name="cloud_off" size={96} />
          <h1 className="text-headline-sm font-medium">Can&apos;t reach HRMS</h1>
          <p className="text-body-md text-text-secondary">Check your connection. The server may also be waking up — try again in a few seconds.</p>
          <Button onClick={() => void refresh()}>Try again</Button>
        </div>
      </main>
    );
  }
  return <>{children}</>;
}

export function Splash() {
  return (
    <main className="grid min-h-dvh place-items-center bg-surface" aria-busy="true">
      <div className="grid place-items-center gap-6 text-primary">
        <Art name="attendance" size={110} big />
        <Spinner size={28} />
        <span className="sr-only">Loading HRMS</span>
      </div>
    </main>
  );
}
