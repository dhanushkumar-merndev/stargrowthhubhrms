import { CorrectionForm } from "@/components/screens/request-forms";

export const metadata = { title: "Request a correction · HRMS" };

export default async function NewCorrectionPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const { date } = await searchParams;
  return <CorrectionForm initialDate={date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined} />;
}
