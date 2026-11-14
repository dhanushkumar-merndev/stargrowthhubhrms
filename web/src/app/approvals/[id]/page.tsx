import { notFound } from "next/navigation";
import { ApprovalDetail } from "@/components/screens/requests";

export const metadata = { title: "Review request · HRMS" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ApprovalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return <ApprovalDetail id={id} />;
}
