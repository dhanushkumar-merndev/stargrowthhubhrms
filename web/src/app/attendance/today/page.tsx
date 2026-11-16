import { MyPunchDay } from "@/components/screens/punch-day";

export const metadata = { title: "My punch · HRMS" };

export default async function Page({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const { date } = await searchParams;
  return <MyPunchDay initialDate={date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined} />;
}
