"use client";

import { useEffect } from "react";

/** Registers /sw.js (app-shell cache + Web Push). No-op where unsupported. */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return; // avoid stale caches while developing
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch(() => {
        /* the app works without it */
      });
  }, []);
  return null;
}
