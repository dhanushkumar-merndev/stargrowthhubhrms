import { HolidayCalendar } from "@/components/screens/leave";

export const metadata = { title: "Holiday calendar · HRMS" };

export default async function HolidaysPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const { year } = await searchParams;
  const y = year && /^\d{4}$/.test(year) ? Number(year) : undefined;
  return <HolidayCalendar initialYear={y && y >= 2000 && y <= 2100 ? y : undefined} />;
}
