import { NextRequest, NextResponse } from "next/server";
import { CompanyClassifier } from "@/lib/classifier";
import { fetchCompanyLists } from "@/lib/database";
import { classifyWithAgent } from "@/lib/agent";
import { sendQuickClassification } from "@/lib/slack";

export const maxDuration = 60;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ source: string }> }
) {
  const { source } = await params;
  const body = await req.json();

  // Extract company name from webhook payload — different sources send different shapes
  let companyName: string | undefined;
  let titles: string[] = [];

  switch (source) {
    case "common-room":
      companyName = body.company?.name || body.organization?.name;
      titles = body.person?.title ? [body.person.title] : [];
      break;
    case "apollo":
      companyName = body.organization?.name || body.company_name;
      titles = body.title ? [body.title] : [];
      break;
    case "hubspot":
      companyName = body.properties?.company || body.company;
      titles = body.properties?.jobtitle ? [body.properties.jobtitle] : [];
      break;
    default:
      companyName = body.company || body.company_name || body.organization?.name;
      titles = body.title ? [body.title] : body.titles || [];
  }

  if (!companyName) {
    return NextResponse.json(
      { error: "Could not extract company name from webhook payload" },
      { status: 400 }
    );
  }

  // Quick known-match check first
  const lists = await fetchCompanyLists();
  const classifier = new CompanyClassifier(lists.exclusions, lists.tags, lists.prospects);

  const known = classifier.classifyKnown(companyName);
  if (known) {
    await sendQuickClassification({
      companyName,
      action: known.action,
      category: known.category,
      confidence: known.confidence,
    });
    return NextResponse.json({ ...known, source, webhook: true });
  }

  // Unknown — classify with agent
  const { classifications: results } = await classifyWithAgent([{ name: companyName, titles }]);
  const result = results[0] || {
    name: companyName,
    action: "prospect" as const,
    category: null,
    confidence: "claude" as const,
    rationale: "Unclassified",
  };

  await sendQuickClassification({
    companyName,
    action: result.action,
    category: result.category,
    confidence: result.confidence,
  });

  return NextResponse.json({ ...result, source, webhook: true });
}
