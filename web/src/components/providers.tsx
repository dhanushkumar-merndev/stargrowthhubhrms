"use client";

import { SWRConfig } from "swr";
import { SessionProvider } from "@/lib/session";
import { Gate } from "./gate";
import { ReauthHost } from "./reauth";
import { CommandPalette } from "./command-palette";

export function Providers({ children }: { children: React.ReactNode }) {
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
