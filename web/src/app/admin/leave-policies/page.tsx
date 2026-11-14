import { LeavePolicies } from "@/components/screens/admin-policy";

export const metadata = { title: "Leave and holidays · HRMS" };

export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  return <LeavePolicies initialTab={tab === "holidays" || tab === "types" ? tab : "policies"} />;
}
