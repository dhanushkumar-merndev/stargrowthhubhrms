import { ReviewQueue } from "@/components/screens/requests";

export const metadata = { title: "Review requests · HRMS" };

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ scope?: string }> }) {
  const { scope } = await searchParams;
  return <ReviewQueue initialScope={scope === "all" || scope === "unassigned" ? scope : undefined} />;
}
