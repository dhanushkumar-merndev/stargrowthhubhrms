import { LoginForm } from "@/components/screens/login-form";
import { employeeCodeError } from "@/lib/routing";

export const metadata = { title: "Sign in · HRMS" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ employee_id?: string | string[] }> }) {
  const { employee_id } = await searchParams;
  const code = typeof employee_id === "string" && !employeeCodeError(employee_id) ? employee_id.trim().toUpperCase() : "";
  return <LoginForm key={code} initialCode={code} />;
}
