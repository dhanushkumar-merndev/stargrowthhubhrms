import { notFound } from "next/navigation";
import { AttendanceRequestForm } from "@/components/screens/request-forms";

export const metadata = { title: "New request · HRMS" };

const KINDS = { wfh: "wfh", late: "late_excuse", late_excuse: "late_excuse", "comp-off": "comp_off", comp_off: "comp_off" } as const;

export default async function NewRequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ kind: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const [{ kind }, { date }] = await Promise.all([params, searchParams]);
  const k = KINDS[kind as keyof typeof KINDS];
  if (!k) notFound();
  return <AttendanceRequestForm kind={k} initialDate={date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined} />;
}
