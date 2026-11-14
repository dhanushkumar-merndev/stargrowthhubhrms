import { Teams } from "@/components/screens/admin-org";

export const metadata = { title: "Teams · HRMS" };

export default async function Page({ searchParams }: { searchParams: Promise<{ section?: string }> }) {
  const { section } = await searchParams;
  return <Teams initialSection={section === "departments" ? "departments" : "teams"} />;
}
