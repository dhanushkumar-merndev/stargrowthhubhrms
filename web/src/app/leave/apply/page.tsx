import { LeaveApply } from "@/components/screens/leave";

export const metadata = { title: "Apply for leave · HRMS" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function LeaveApplyPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  const { edit } = await searchParams;
  return <LeaveApply editId={edit && UUID.test(edit) ? edit : undefined} />;
}
