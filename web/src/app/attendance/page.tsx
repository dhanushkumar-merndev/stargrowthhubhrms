import { Attendance } from "@/components/screens/attendance";

export const metadata = { title: "My attendance · HRMS" };

export default async function AttendancePage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const { filter } = await searchParams;
  return <Attendance filter={filter === "needs_correction" ? filter : null} />;
}
