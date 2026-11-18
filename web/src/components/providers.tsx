"use client";

import { useEffect } from "react";
import { SWRConfig } from "swr";
import { trackBackNavigation } from "@/lib/back-navigation";
import { SessionProvider } from "@/lib/session";
import { Gate } from "./gate";
import { ReauthHost } from "./reauth";
import { CommandPalette } from "./command-palette";

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    let mounted = true;
    let stopTracking: (() => void) | undefined;
    // Install after the App Router applies its native history wrappers.
    queueMicrotask(() => {
      if (mounted) stopTracking = trackBackNavigation();
    });
    return () => {
      mounted = false;
      stopTracking?.();
    };
  }, []);

  return (
    <SWRConfig value={{ dedupingInterval: 4000, keepPreviousData: true }}>
      <SessionProvider>
        <Gate>{children}</Gate>
        <ReauthHost />
        <CommandPalette />
      </SessionProvider>
    </SWRConfig>
  );
}
