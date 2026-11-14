import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, authApi, onSessionProblem, rpc } from "@/lib/api";
import { fail, mockFetch, ok } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

describe("api client", () => {
  it("rpc posts JSON with the CSRF header and returns data", async () => {
    const calls = mockFetch({ "/rpc/get_my_profile": () => ok({ name: "A" }) });
    await expect(rpc("get_my_profile")).resolves.toEqual({ name: "A" });
    const h = calls[0].init.headers as Record<string, string>;
    expect(h["x-requested-with"]).toBe("hrms-web");
    expect(h["content-type"]).toBe("application/json");
    expect(calls[0].init.credentials).toBe("same-origin");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].body).toEqual({});
  });

  it("maps the error envelope", async () => {
    mockFetch({ "/rpc/x": () => fail(422, "VALIDATION_FAILED", "Bad.", { p_a: "required" }) });
    const e = (await rpc("x").catch((x) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect([e.code, e.status, e.message, e.fieldErrors.p_a, e.requestId]).toEqual(["VALIDATION_FAILED", 422, "Bad.", "required", "r2"]);
  });

  it("falls back to safe codes when the body is not ours", async () => {
    mockFetch({ "/rpc/a": () => [502, "<html>bad gateway</html>"], "/rpc/b": () => [429, ""], "/rpc/c": () => [500, "{}"] });
    const a = (await rpc("a").catch((x) => x)) as ApiError;
    expect([a.code, a.retryable]).toEqual(["UNAVAILABLE", true]);
    expect(a.message).not.toMatch(/html/);
    const b = (await rpc("b").catch((x) => x)) as ApiError;
    expect([b.code, b.retryable]).toEqual(["RATE_LIMITED", true]);
    const c = (await rpc("c").catch((x) => x)) as ApiError;
    expect(c.code).toBe("INTERNAL");
  });

  it("a bare code from SQL gets friendly text; unknown codes get the generic one", async () => {
    mockFetch({ "/rpc/a": () => fail(403, "PASSWORD_CHANGE_REQUIRED"), "/rpc/b": () => fail(422, "SOMETHING_NEW") });
    expect(((await rpc("a").catch((x) => x)) as ApiError).message).toBe("Change your temporary password to continue.");
    expect(((await rpc("b").catch((x) => x)) as ApiError).message).toBe("Something went wrong. Please try again.");
  });

  it("network failure is NETWORK and retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const e = (await rpc("x").catch((x) => x)) as ApiError;
    expect([e.code, e.isNetwork, e.retryable]).toEqual(["NETWORK", true, true]);
  });

  it("refuses internal_* and malformed names without calling the server", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    for (const n of ["internal_login_lookup", "../auth/login", "Get", "a;b", "", "x".repeat(64)]) {
      await expect(rpc(n)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("notifies the session provider about dead sessions only", async () => {
    const seen: string[] = [];
    const off = onSessionProblem((e) => seen.push(e.code));
    mockFetch({
      "/rpc/a": () => fail(401, "AUTH_REQUIRED"),
      "/rpc/b": () => fail(403, "PASSWORD_CHANGE_REQUIRED"),
      "/rpc/c": () => fail(403, "ACCESS_DENIED"),
      "/rpc/d": () => fail(403, "ACCOUNT_INACTIVE"),
    });
    for (const n of ["a", "b", "c", "d"]) await rpc(n).catch(() => {});
    off();
    await rpc("a").catch(() => {});
    expect(seen).toEqual(["AUTH_REQUIRED", "PASSWORD_CHANGE_REQUIRED", "ACCOUNT_INACTIVE"]);
  });

  it("auth calls use the documented bodies", async () => {
    const calls = mockFetch({
      "/auth/login": () => ok({ must_change_password: false, credential_hold: false }),
      "/auth/password": () => ok({ status: "completed" }),
      "/auth/reauth": () => ok({ grant_id: "g", expires_at: "t" }),
      "/auth/logout": () => ok({ signed_out: true }),
    });
    await authApi.login("EMP001", "pw");
    await authApi.changePassword("op", "a", "b");
    await authApi.reauth("pw", "export.annual");
    await authApi.logout();
    expect(calls.map((c) => [c.path, c.body])).toEqual([
      ["/auth/login", { employee_code: "EMP001", password: "pw" }],
      ["/auth/password", { operation_id: "op", current_password: "a", new_password: "b" }],
      ["/auth/reauth", { password: "pw", action: "export.annual" }],
      ["/auth/logout", {}],
    ]);
  });
});
