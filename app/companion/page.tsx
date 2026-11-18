import CompanionAgent from "@/components/CompanionAgent";

export default async function CompanionPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const params = await searchParams;
  return <CompanionAgent initialCode={params.code ?? ""} />;
}
