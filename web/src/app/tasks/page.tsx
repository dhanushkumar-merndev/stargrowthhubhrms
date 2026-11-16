import { TasksHome } from "@/components/screens/tasks";

export const metadata = { title: "Tasks · HRMS" };

export default async function Page({ searchParams }: { searchParams: Promise<{ scope?: string }> }) {
  const { scope } = await searchParams;
  return <TasksHome initialScope={scope === "given" || scope === "team" ? scope : "mine"} />;
}
