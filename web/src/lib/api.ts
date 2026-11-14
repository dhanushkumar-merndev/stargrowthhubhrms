// Same-origin API client. The browser only ever talks to /api/* on our own
// Vercel origin (PLAN.md K7); proxy.ts forwards to the Rust server. The
// session lives in an HttpOnly cookie, so no token is ever visible to JS.

export const API_BASE = "/api/v1";

export type FieldErrors = Record<string, string>;

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fieldErrors: FieldErrors;
  readonly retryable: boolean;
  readonly requestId?: string;

  constructor(code: string, message: string, status: number, fieldErrors: FieldErrors = {}, retryable = false, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.fieldErrors = fieldErrors;
    this.retryable = retryable;
    this.requestId = requestId;
  }
  get isNetwork() {
    return this.code === "NETWORK";
  }
  /** The session is gone or unusable: the app must return to sign-in. */
  get isSignedOut() {
    return this.code === "AUTH_REQUIRED" || this.code === "ACCOUNT_INACTIVE";
  }
  get needsPasswordChange() {
    return this.code === "PASSWORD_CHANGE_REQUIRED" || this.code === "CREDENTIAL_OPERATION_PENDING";
  }
}

export interface Envelope<T> {
  data: T;
  version: number | null;
  request_id: string;
}

type Listener = (e: ApiError) => void;
const listeners = new Set<Listener>();
/** Session provider subscribes to learn about lost sessions from any call. */
export function onSessionProblem(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const GENERIC = "Something went wrong. Please try again.";

/** Friendly text when the server sent only a code (hrms.raise_error without a message). */
export const MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: "Please sign in again.",
  ACCOUNT_INACTIVE: "Your account is not active. Contact HR.",
  PASSWORD_CHANGE_REQUIRED: "Change your temporary password to continue.",
  CREDENTIAL_OPERATION_PENDING: "A password change is being completed. Try again shortly.",
  REAUTH_REQUIRED: "Confirm your password to continue.",
  ACCESS_DENIED: "You do not have access to this.",
  NOT_FOUND: "This item no longer exists.",
  STALE_VERSION: "Someone else changed this. Reload and try again.",
  CONFLICT: "This clashes with an existing record.",
  VALIDATION_FAILED: "Some values are not valid.",
  RATE_LIMITED: "Too many attempts. Wait a moment and try again.",
  UNAVAILABLE: "The service is busy. Please try again.",
  REQUEST_TOO_LARGE: "That is too large to send.",
  SELF_APPROVAL_FORBIDDEN: "You cannot approve your own request.",
};
const OFFLINE = "You appear to be offline. Check your connection and try again.";

export async function post<T>(path: string, body?: unknown, init?: { signal?: AbortSignal }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "hrms-web" },
      body: JSON.stringify(body ?? {}),
      credentials: "same-origin",
      cache: "no-store",
      signal: init?.signal,
    });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new ApiError("NETWORK", OFFLINE, 0, {}, true);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = (json as { error?: Record<string, unknown> } | null)?.error ?? {};
    const e = new ApiError(
      typeof err.code === "string" ? err.code : fallbackCode(res.status),
      friendly(typeof err.code === "string" ? err.code : fallbackCode(res.status), typeof err.message === "string" ? err.message : ""),
      res.status,
      isRecord(err.field_errors) ? (err.field_errors as FieldErrors) : {},
      typeof err.retryable === "boolean" ? err.retryable : res.status >= 500 || res.status === 429,
      typeof err.request_id === "string" ? err.request_id : undefined,
    );
    if (e.isSignedOut || e.needsPasswordChange) listeners.forEach((l) => l(e));
    throw e;
  }
  return json as T;
}

function friendly(code: string, message: string): string {
  if (message && message !== code) return message;
  return MESSAGES[code] ?? GENERIC;
}

function fallbackCode(status: number): string {
  if (status === 401) return "AUTH_REQUIRED";
  if (status === 403) return "ACCESS_DENIED";
  if (status === 404) return "NOT_FOUND";
  if (status === 413) return "REQUEST_TOO_LARGE";
  if (status === 429) return "RATE_LIMITED";
  if (status === 503 || status === 502 || status === 504) return "UNAVAILABLE";
  return "INTERNAL";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Calls a public SQL function through the RPC gateway; returns `data`. */
export async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name) || name.startsWith("internal_")) {
    throw new ApiError("NOT_FOUND", "Not found.", 404);
  }
  const r = await post<Envelope<T>>(`/rpc/${name}`, args ?? {});
  return r.data;
}

export function newOperationId(): string {
  return crypto.randomUUID();
}

export const authApi = {
  login: (employeeCode: string, password: string) =>
    post<Envelope<{ must_change_password: boolean; credential_hold: boolean }>>("/auth/login", {
      employee_code: employeeCode,
      password,
    }),
  logout: () => post<Envelope<{ signed_out: boolean }>>("/auth/logout"),
  changePassword: (operationId: string, current: string, next: string) =>
    post<Envelope<{ status: string }>>("/auth/password", {
      operation_id: operationId,
      current_password: current,
      new_password: next,
    }),
  reauth: (password: string, action: string, targetId?: string) =>
    post<Envelope<{ grant_id: string; expires_at: string }>>("/auth/reauth", {
      password,
      action,
      target_id: targetId,
    }),
};
