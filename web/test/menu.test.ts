import { describe, expect, it } from "vitest";
import { actionScopes, exploreModules } from "@/lib/menu";
import { caps, roleLabel } from "@/lib/roles";
import { ctx } from "./helpers";

const labels = (role: "employee" | "hr" | "admin") => exploreModules(caps(ctx(role))).flatMap((m) => m.actions.map((a) => a.label));
const modules = (role: "employee" | "hr" | "admin") => exploreModules(caps(ctx(role))).map((m) => m.id);

describe("three-role RBAC in the menus", () => {
  it("employees see only their own modules", () => {
    expect(modules("employee")).toEqual(["attendance", "leave", "salary", "people", "documents"]);
    expect(labels("employee")).not.toContain("Payroll uploads");
    expect(labels("employee")).not.toContain("Employees");
    expect(actionScopes(caps(ctx("employee"))).map((s) => s.scope)).toEqual(["user"]);
  });
  it("HR gets review, workspace and HR admin, but not Admin-only setup", () => {
    expect(modules("hr")).toEqual(["attendance", "leave", "salary", "people", "todo", "documents", "workspace", "admin"]);
    const l = labels("hr");
    for (const x of ["Payroll uploads", "Employees", "Import from Excel", "Teams", "Shifts", "Roles", "Attendance machines"]) expect(l).toContain(x);
    for (const x of ["Organization", "Offices", "Annual archive", "Google Sheet", "Weekly off (Saturdays)", "Audit history"]) expect(l).not.toContain(x);
    expect(actionScopes(caps(ctx("hr"))).map((s) => s.scope)).toEqual(["user", "hr"]);
  });
  it("Admin sees everything", () => {
    const l = labels("admin");
    for (const x of ["Organization", "Offices", "Annual archive", "Google Sheet", "Audit history", "Roles"]) expect(l).toContain(x);
    expect(actionScopes(caps(ctx("admin"))).map((s) => s.scope)).toEqual(["user", "hr", "admin"]);
  });
  it("Admin can open leave type management directly from Action and Explore", () => {
    expect(actionScopes(caps(ctx("admin"))).find((s) => s.scope === "admin")?.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Leave types", href: "/admin/leave-policies?tab=types" })]),
    );
    expect(exploreModules(caps(ctx("admin"))).find((m) => m.id === "admin")?.actions).toContainEqual({ label: "Leave types", href: "/admin/leave-policies?tab=types" });
    expect(labels("employee")).not.toContain("Leave types");
    expect(labels("hr")).not.toContain("Leave types");
  });
  it("audit is visible to HR with the scoped permission", () => {
    expect(caps(ctx("hr", { permissions: ["audit.scoped"] })).canAudit).toBe(true);
  });
  it("Manager is only a label: it grants nothing", () => {
    const c = caps(ctx("employee", { employee: { ...ctx("employee").employee, position_label: "manager" } }));
    expect(c.isManagerLabel).toBe(true);
    expect(c.canReview || c.canViewEmployees || c.hasWorkspace).toBe(false);
  });
  it("an unknown or missing session is treated as Employee", () => {
    expect(caps(null).isHrOrAdmin).toBe(false);
    expect(caps(ctx("superuser" as "admin")).isAdmin).toBe(false);
    expect(roleLabel("weird")).toBe("Employee");
  });
  it("menu links are unique per scope and all internal", () => {
    for (const r of ["employee", "hr", "admin"] as const) {
      for (const s of actionScopes(caps(ctx(r)))) {
        const hrefs = s.items.map((i) => i.href);
        expect(new Set(hrefs).size).toBe(hrefs.length);
        expect(hrefs.every((h) => h.startsWith("/") && !h.startsWith("//"))).toBe(true);
      }
    }
  });
});
