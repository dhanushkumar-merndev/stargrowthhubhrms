import { AttendancePrint } from "@/components/screens/attendance-print";
import { monthParam } from "@/lib/xlsx";

export const metadata = { title: "Print attendance · HRMS" };

export default async function AttendancePrintPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const { month } = await searchParams;
  return <AttendancePrint month={monthParam(month)} />;
}
