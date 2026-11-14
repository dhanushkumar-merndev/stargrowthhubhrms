import { CorrectionForm } from "@/components/screens/request-forms";

export const metadata = { title: "Request a correction · HRMS" };

export default async function NewCorrectionPage({ searchParams }: { searchParams: Promise<{ date?: string; fix?: string }> }) {
  const { date, fix } = await searchParams;
  const valid = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
  return <CorrectionForm initialDate={valid} fix={valid && fix === "out" ? "out" : undefined} />;
}
