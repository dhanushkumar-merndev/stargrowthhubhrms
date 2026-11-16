import { WorkHome } from "@/components/screens/tasks";

export const metadata = { title: "Daily work report · HRMS" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string; task?: string }> }) {
  const { tab, task } = await searchParams;
  return <WorkHome initialTab={tab === "team" ? "team" : "mine"} taskId={task && UUID.test(task) ? task : ""} />;
}
