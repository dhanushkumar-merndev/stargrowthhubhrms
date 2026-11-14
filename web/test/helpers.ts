import { vi } from "vitest";
import type { SessionContext } from "@/lib/roles";

export function ctx(role: "employee" | "hr" | "admin", extra: Partial<SessionContext> = {}): SessionContext {
  return {
    employee: { id: "e1", code: "EMP001", name: "Asha Rao", designation: "Engineer", position_label: "member" },
    org: { id: "o1", code: "ORG", name: "Acme", timezone: "Asia/Kolkata", support_contact: null },
    role,
    roles: role === "employee" ? [] : [role],
    permissions: [],
    must_change_password: false,
    credential_hold: false,
    permission_version: "v",
    ...extra,
  };
}

/** Routes fetch calls by URL path; each handler returns [status, body]. */
export function mockFetch(routes: Record<string, (body: unknown) => [number, unknown] | Promise<[number, unknown]>>) {
  const calls: { path: string; query: URLSearchParams; body: unknown; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const [path, qs = ""] = url.replace(/^\/api\/v1/, "").split("?");
    const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : init.body;
    calls.push({ path, query: new URLSearchParams(qs), body, init });
    const h = routes[path];
    if (!h) return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found." } }), { status: 404 });
    const [status, out] = await h(body);
    return new Response(typeof out === "string" || ArrayBuffer.isView(out) ? (out as BodyInit) : JSON.stringify(out), { status });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

export const ok = <T,>(data: T): [number, unknown] => [200, { data, version: null, request_id: "r1" }];
export const fail = (status: number, code: string, message = code, field_errors = {}): [number, unknown] => [
  status,
  { error: { code, message, field_errors, retryable: false, request_id: "r2" } },
];
