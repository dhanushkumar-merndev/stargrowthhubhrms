// Menus for the Action and Explore tabs (action_screen.dart, explore_screen.dart).
// Pure data so role visibility is unit-tested.

import type { Caps } from "./roles";

export interface ActionItem {
  label: string;
  subtitle: string;
  href: string;
  art: string;
  /** Tailwind bg class of the icon tile. */
  tile: string;
}

const lav = "bg-attendance-card";
const cyan = "bg-leave-card";
const peach = "bg-salary-card";
const teal = "bg-approvals-card";
const pink = "bg-people-card";
const docs = "bg-documents-card";

export type Scope = "user" | "hr" | "admin";

export function actionScopes(c: Caps): { scope: Scope; label: string; art: string; items: ActionItem[] }[] {
  const user: ActionItem[] = [
    { label: "My attendance", subtitle: "Your days, hours and late marks", href: "/attendance", art: "tile_my_attendance", tile: lav },
    { label: "Fix a check-in or check-out", subtitle: "Forgot to punch, or the time is wrong", href: "/corrections/new", art: "tile_fix_punch", tile: lav },
    { label: "Work from home", subtitle: "Ask HR to work from home on some days", href: "/requests/new/wfh", art: "home", tile: lav },
    { label: "Excuse a late arrival", subtitle: "Late for a reason? Ask HR not to count it", href: "/requests/new/late", art: "schedule", tile: lav },
    { label: "Apply for leave", subtitle: "Casual, paid or unpaid leave", href: "/leave/apply", art: "tile_apply_leave", tile: cyan },
    { label: "Leave balance & history", subtitle: "What you have used and have left", href: "/leave", art: "tile_leave_balance", tile: cyan },
    { label: "Holiday calendar", subtitle: "Office holidays this year", href: "/holidays", art: "holiday_calendar", tile: cyan },
    { label: "My salary", subtitle: "Monthly salary, bank and total received", href: "/salary", art: "tile_my_salary", tile: peach },
    { label: "Payslips", subtitle: "Download your monthly payslips", href: "/payslips", art: "tile_payslips", tile: peach },
    { label: "My requests", subtitle: "Track everything you sent", href: "/requests", art: "tile_my_requests", tile: teal },
  ];
  const hr: ActionItem[] = [];
  if (c.canDraftPolicy) hr.push({ label: "Leave & holidays", subtitle: "Leave types, balances and holidays", href: "/admin/leave-policies", art: "beach", tile: cyan });
  if (c.canReview) hr.push({ label: "Review requests", subtitle: "Leave, fixes, WFH and late excuses", href: "/approvals", art: "tile_review_requests", tile: teal });
  if (c.canTeamReports) hr.push({ label: "Team hours", subtitle: "Who is in and hours worked", href: "/reports/hours", art: "tile_team_hours", tile: lav });
  if (c.canManageDevices) hr.push({ label: "Attendance machines", subtitle: "eSSL devices, live punches and PINs", href: "/devices", art: "fingerprint", tile: lav });
  if (c.canManagePayroll) hr.push({ label: "Payroll uploads", subtitle: "Publish payslips and paid amounts", href: "/payroll/uploads", art: "tile_payslips", tile: peach });
  if (c.canViewEmployees) hr.push({ label: "Employees", subtitle: "Directory and employee records", href: "/employees", art: "groups", tile: pink });
  if (c.isHrOrAdmin) {
    hr.push({ label: "Outside work", subtitle: "Send people out: client, site, event", href: "/admin/outside-work", art: "alt_route", tile: lav });
    hr.push({ label: "Working from home", subtitle: "Approved work from home days", href: "/admin/outside-work?kind=wfh", art: "home", tile: lav });
  }
  if (c.canManageAccess) hr.push({ label: "Roles", subtitle: "Who is Employee, HR or Admin", href: "/admin/roles", art: "admin_panel_settings", tile: lav });
  if (c.canMasterData) {
    hr.push({ label: "Departments", subtitle: "Create and manage departments", href: "/admin/teams?section=departments", art: "location_city", tile: pink });
    hr.push({ label: "Teams", subtitle: "Teams, members and managers", href: "/admin/teams", art: "groups", tile: pink });
  }
  if (c.canDraftPolicy) hr.push({ label: "Company policies", subtitle: "Publish and manage company policies", href: "/policies", art: "policy", tile: docs });
  const admin: ActionItem[] = [];
  if (c.isAdmin) {
    admin.push({ label: "Organization", subtitle: "Name, time zone and support contact", href: "/admin/organization", art: "location_city", tile: lav });
    admin.push({ label: "Offices", subtitle: "Locations, radius and office network", href: "/admin/offices", art: "location", tile: lav });
    admin.push({ label: "Weekly off (Saturdays)", subtitle: "Which Saturdays are off", href: "/admin/leave-policies?tab=holidays", art: "weekend", tile: cyan });
    admin.push({ label: "Background jobs", subtitle: "Health of scheduled maintenance", href: "/admin/jobs", art: "build_circle", tile: lav });
  }
  const scopes: { scope: Scope; label: string; art: string; items: ActionItem[] }[] = [{ scope: "user", label: "User", art: "person", items: user }];
  if (hr.length) scopes.push({ scope: "hr", label: "HR", art: "groups", items: hr });
  if (admin.length) scopes.push({ scope: "admin", label: "Admin", art: "admin_panel_settings", items: admin });
  return scopes;
}

export interface Module {
  id: string;
  title: string;
  subtitle: string;
  card: string;
  action: string;
  art: string;
  actions: { label: string; href: string }[];
}

export function exploreModules(c: Caps): Module[] {
  const m: Module[] = [
    {
      id: "attendance", title: "Attendance", subtitle: "Manage your attendance.", card: "bg-attendance-card", action: "bg-attendance-action", art: "attendance",
      actions: [
        { label: "Check in / out", href: "/punch" },
        { label: "Attendance", href: "/attendance" },
        { label: "Fix a punch", href: "/corrections/new" },
      ],
    },
    {
      id: "leave", title: "Leave", subtitle: "Check and apply for leaves.", card: "bg-leave-card", action: "bg-leave-action", art: "leave",
      actions: [
        { label: "Apply Leave", href: "/leave/apply" },
        { label: "Leave Balance", href: "/leave" },
        { label: "Holiday Calendar", href: "/holidays" },
        { label: "My Requests", href: "/requests" },
      ],
    },
    {
      id: "salary", title: "Salary", subtitle: "Your published payslips.", card: "bg-salary-card", action: "bg-salary-action", art: "salary",
      actions: [
        { label: "My salary", href: "/salary" },
        { label: "Payslips", href: "/payslips" },
        ...(c.canManagePayroll ? [{ label: "Payroll uploads", href: "/payroll/uploads" }] : []),
      ],
    },
    {
      id: "people", title: "People", subtitle: "A data hub for personal info and workmates", card: "bg-people-card", action: "bg-people-action", art: "people",
      actions: [
        { label: "My Profile", href: "/profile" },
        { label: "My Workmates", href: "/people" },
        ...(c.canViewEmployees ? [{ label: "Employees", href: "/employees" }] : []),
        ...(c.canProvision || c.canManagePayroll ? [{ label: "Import from Excel", href: "/employees/import" }] : []),
        { label: "Settings", href: "/settings" },
      ],
    },
  ];
  if (c.canReview) {
    m.push({ id: "todo", title: "To Do", subtitle: "Review pending items.", card: "bg-approvals-card", action: "bg-approvals-action", art: "todo", actions: [{ label: "Review", href: "/approvals" }] });
  }
  m.push({
    id: "documents", title: "Documents", subtitle: "Company policies and your documents.", card: "bg-documents-card", action: "bg-documents-action", art: "documents",
    actions: [
      { label: "Documents", href: "/documents" },
      { label: "Company policies", href: "/policies" },
    ],
  });
  if (c.hasWorkspace) {
    m.push({
      id: "workspace", title: "Workspace", subtitle: "Team status, approvals and hours.", card: "bg-workspace-card", action: "bg-workspace-action", art: "workspace",
      actions: [
        { label: "Workspace", href: "/workspace" },
        { label: "Who's in", href: "/devices/live" },
        ...(c.canTeamReports ? [{ label: "Hours report", href: "/reports/hours" }] : []),
        ...(c.canAudit ? [{ label: "Audit history", href: "/admin/audit" }] : []),
        ...(c.canAnnounce ? [{ label: "Announcement", href: "/announcements/new" }] : []),
      ],
    });
  }
  if (c.isAdmin || c.canMasterData || c.canDraftPolicy) {
    const a: { label: string; href: string }[] = [];
    if (c.isAdmin) a.push({ label: "Organization", href: "/admin/organization" });
    if (c.canMasterData) a.push({ label: "Teams", href: "/admin/teams" });
    if (c.isAdmin) a.push({ label: "Offices", href: "/admin/offices" });
    if (c.canManageDevices) a.push({ label: "Attendance machines", href: "/devices" });
    if (c.isHrOrAdmin) a.push({ label: "Outside work & WFH", href: "/admin/outside-work" });
    if (c.canMasterData || c.canDraftPolicy) a.push({ label: "Shifts", href: "/admin/shifts" });
    if (c.canDraftPolicy) a.push({ label: "Leave & holidays", href: "/admin/leave-policies" });
    if (c.isAdmin) a.push({ label: "Weekly off (Saturdays)", href: "/admin/leave-policies?tab=holidays" });
    if (c.canDraftPolicy) a.push({ label: "Company policies", href: "/policies" });
    if (c.canManageAccess) a.push({ label: "Roles", href: "/admin/roles" });
    if (c.isAdmin) a.push({ label: "Annual archive", href: "/admin/archive" });
    if (c.isAdmin) a.push({ label: "Google Sheet", href: "/admin/google-sheet" });
    m.push({ id: "admin", title: "Admin", subtitle: "Organisation setup and controls.", card: "bg-attendance-card", action: "bg-primary", art: "admin", actions: a });
  }
  return m;
}

/** Art names that live in /public/illustrations (big, multi-colour). */
export function isBigArt(name: string): boolean {
  return name.startsWith("tile_") || name === "holiday_calendar";
}
