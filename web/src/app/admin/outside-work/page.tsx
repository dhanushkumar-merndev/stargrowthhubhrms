import { OutsideWork } from "@/components/screens/admin-policy";

export const metadata = { title: "Outside work · HRMS" };

export default async function Page({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const { kind } = await searchParams;
  return <OutsideWork initialKind={kind === "wfh" || kind === "outside" ? kind : ""} />;
}
