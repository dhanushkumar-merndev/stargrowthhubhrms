import { notFound } from "next/navigation";
import { TaskDetail } from "@/components/screens/tasks";

export const metadata = { title: "Task · HRMS" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return <TaskDetail id={id} />;
}
