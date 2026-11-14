import { describe, expect, it } from "vitest";
import { activeTab, employeeCodeError, newPasswordError, redirectFor } from "@/lib/routing";

describe("redirectFor (router.dart redirect)", () => {
  it("keeps loading/unreachable in place (gate shows splash/retry)", () => {
    expect(redirectFor("loading", "/home")).toBeNull();
    expect(redirectFor("unreachable", "/settings")).toBeNull();
  });
  it("signed-out users can only be on /login", () => {
    expect(redirectFor("signedOut", "/home")).toBe("/login");
    expect(redirectFor("signedOut", "/password-change")).toBe("/login");
    expect(redirectFor("signedOut", "/settings/password")).toBe("/login");
    expect(redirectFor("signedOut", "/login")).toBeNull();
  });
  it("a temporary password locks the app to /password-change", () => {
    expect(redirectFor("mustChangePassword", "/home")).toBe("/password-change");
    expect(redirectFor("mustChangePassword", "/settings/password")).toBe("/password-change");
    expect(redirectFor("mustChangePassword", "/login")).toBe("/password-change");
    expect(redirectFor("mustChangePassword", "/password-change")).toBeNull();
  });
  it("ready users leave the entry screens for /home and stay elsewhere", () => {
    for (const p of ["/", "/login", "/password-change"]) expect(redirectFor("ready", p)).toBe("/home");
    for (const p of ["/home", "/settings", "/settings/password", "/attendance/day"]) expect(redirectFor("ready", p)).toBeNull();
  });
  it("the offline page never redirects", () => {
    for (const ph of ["loading", "signedOut", "mustChangePassword", "ready"] as const) expect(redirectFor(ph, "/offline")).toBeNull();
  });
});

describe("activeTab", () => {
  it("maps paths to the three tabs", () => {
    expect(activeTab("/home")).toBe(0);
    expect(activeTab("/action")).toBe(1);
    expect(activeTab("/explore")).toBe(2);
    expect(activeTab("/explore/x")).toBe(2);
    expect(activeTab("/actionable")).toBe(0);
    expect(activeTab("/settings")).toBe(0);
  });
});

describe("employee ID rule", () => {
  it.each([
    ["", "Enter your employee ID"],
    ["   ", "Enter your employee ID"],
    ["ab", "Use letters, digits or -"],
    ["EMP 01", "Use letters, digits or -"],
    ["emp_01", "Use letters, digits or -"],
    ["A".repeat(33), "Use letters, digits or -"],
  ])("%j -> %s", (input, msg) => expect(employeeCodeError(input)).toBe(msg));
  it.each(["emp001", " EMP-01 ", "A".repeat(32), "123"])("%j is fine", (v) => expect(employeeCodeError(v)).toBeNull());
});

describe("password policy (same as server)", () => {
  it("length 12..128 counted in characters", () => {
    expect(newPasswordError("a".repeat(5) + "b".repeat(6))).not.toBeNull();
    expect(newPasswordError("abcdefghijkl")).toBeNull();
    expect(newPasswordError("ab".repeat(64))).toBeNull();
    expect(newPasswordError("ab".repeat(64) + "c")).not.toBeNull();
    expect(newPasswordError("ünïcödé-pässwörd")).toBeNull();
  });
  it("rejects the employee ID in any case and single repeated characters", () => {
    expect(newPasswordError("my-emp001-password", "EMP001")).toMatch(/employee ID/);
    expect(newPasswordError("my-other-password", "EMP001")).toBeNull();
    expect(newPasswordError("zzzzzzzzzzzzzzzz")).toMatch(/predictable/);
    expect(newPasswordError("😀".repeat(12))).toMatch(/predictable/);
  });
});
