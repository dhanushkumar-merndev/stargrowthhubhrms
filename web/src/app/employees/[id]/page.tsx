import { notFound } from "next/navigation";
import { EmployeeDetail } from "@/components/screens/employees";

export const metadata = { title: "Employee · HRMS" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return <EmployeeDetail id={id} />;
}
