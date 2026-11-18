// Same capability getters as the Android SessionContext (three-role RBAC:
// Employee, HR, Admin; "Manager" is only a label). The server enforces every
// rule again — these only decide what the UI shows.

export interface SessionContext {
  employee: { id: string; code: string; name: string; designation: string | null; position_label: string | null };
  org: { id: string; code: string; name: string; timezone: string; support_contact: string | null };
  role: "employee" | "hr" | "admin" | string;
  roles: string[];
  permissions: string[];
  must_change_password: boolean;
  credential_hold: boolean;
  /** Null until accepted. Older servers omit this during a rolling deploy. */
  policy_acknowledged_at?: string | null;
  permission_version: string;
}

export function caps(s: SessionContext | null | undefined) {
  const role = s?.role ?? "employee";
  const isAdmin = role === "admin";
  const isHr = role === "hr";
  const isHrOrAdmin = isAdmin || isHr;
  const has = (p: string) => s?.permissions.includes(p) ?? false;
  return {
    isAdmin,
    isHr,
    isHrOrAdmin,
    isManagerLabel: s?.employee.position_label === "manager",
    canReview: isHrOrAdmin,
    canOrgReports: isHrOrAdmin,
    canTeamReports: isHrOrAdmin,
    canViewEmployees: isHrOrAdmin,
    canProvision: isHrOrAdmin,
    canMasterData: isHrOrAdmin,
    canDraftPolicy: isHrOrAdmin,
    canManagePayroll: isHrOrAdmin,
    canManageAccess: isHrOrAdmin,
    canAudit: isAdmin || has("audit.scoped"),
    canAnnounce: isHrOrAdmin,
    hasWorkspace: isHrOrAdmin,
    canManageDevices: isHrOrAdmin,
  };
}
export type Caps = ReturnType<typeof caps>;

export function roleLabel(role: string): string {
  return role === "admin" ? "Admin" : role === "hr" ? "HR" : "Employee";
}
