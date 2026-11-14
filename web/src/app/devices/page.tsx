import { DevicesConsole } from "@/components/screens/devices";
import { deviceTab } from "@/lib/devices";

export const metadata = { title: "Attendance machines · HRMS" };

export default async function DevicesPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  return <DevicesConsole initialTab={deviceTab(tab)} />;
}
