import { TaskNew } from "@/components/screens/tasks";

export const metadata = { title: "New task · HRMS" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Page({ searchParams }: { searchParams: Promise<{ for?: string }> }) {
  const { for: who } = await searchParams;
  return <TaskNew initialAssignee={who && UUID.test(who) ? who : ""} />;
}
