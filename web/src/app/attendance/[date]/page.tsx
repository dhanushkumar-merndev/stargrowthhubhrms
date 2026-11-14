import { notFound } from "next/navigation";
import { AttendanceDay } from "@/components/screens/attendance-day";

export const metadata = { title: "Attendance day · HRMS" };

export default async function AttendanceDayPage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) notFound();
  return <AttendanceDay date={date} />;
}
