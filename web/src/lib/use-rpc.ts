"use client";

import useSWR, { type SWRConfiguration } from "swr";
import { ApiError, rpc } from "./api";

/** Cached read of a public SQL function. `null` name = don't fetch yet. */
export function useRpc<T>(name: string | null, args?: Record<string, unknown>, config?: SWRConfiguration<T, ApiError>) {
  return useSWR<T, ApiError>(name ? [name, args ?? {}] : null, ([n, a]: [string, Record<string, unknown>]) => rpc<T>(n, a), {
    revalidateOnFocus: true,
    shouldRetryOnError: (e: ApiError) => e.retryable && !e.isSignedOut,
    errorRetryCount: 2,
    ...config,
  });
}
