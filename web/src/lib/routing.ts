// Where a user may be, given their session phase (Android router.dart redirect).

export type Phase = "loading" | "unreachable" | "signedOut" | "mustChangePassword" | "ready";

/** Paths that render without a session check (static, offline shell). */
const OPEN = ["/offline"];

/** Returns the path to redirect to, or null to stay. */
export function redirectFor(phase: Phase, path: string): string | null {
  if (OPEN.some((p) => path === p || path.startsWith(p + "/"))) return null;
  switch (phase) {
    case "loading":
    case "unreachable":
      return null; // the gate shows the splash / retry screen in place
    case "signedOut":
      return path === "/login" ? null : "/login";
    case "mustChangePassword":
      return path === "/password-change" ? null : "/password-change";
    case "ready":
      return path === "/" || path === "/login" || path === "/password-change" ? "/home" : null;
  }
}

export const TABS = [
  { href: "/home", label: "Home", icon: "home" },
  { href: "/action", label: "Action", icon: "bolt" },
  { href: "/explore", label: "Explore", icon: "grid" },
] as const;

export function activeTab(path: string): number {
  const i = TABS.findIndex((t) => path === t.href || path.startsWith(t.href + "/"));
  return i < 0 ? 0 : i;
}

/** Employee ID rule from the Android login form. */
export function employeeCodeError(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  if (!code) return "Enter your employee ID";
  if (!/^[A-Z0-9-]{3,32}$/.test(code)) return "Use letters, digits or -";
  return null;
}

/** HRMS password policy (mirrors server/src/auth/password.rs). */
export function newPasswordError(pw: string, employeeCode?: string): string | null {
  const len = [...pw].length;
  if (len < 12 || len > 128) return "Use 12 to 128 characters.";
  if (employeeCode && pw.toUpperCase().includes(employeeCode.toUpperCase())) {
    return "Do not include your employee ID in the password.";
  }
  const chars = [...pw];
  if (chars.every((c) => c === chars[0])) return "Choose a less predictable password.";
  return null;
}
