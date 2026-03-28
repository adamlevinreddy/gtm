import { NextRequest, NextResponse } from "next/server";
import { CompanyClassifier } from "@/lib/classifier";
import { classifyWithAgent } from "@/lib/agent";
import { fetchCompanyLists } from "@/lib/github";
import { createReview } from "@/lib/kv";
import { parseUploadedFile } from "@/lib/parse-upload";
import { sendReviewNotification, sendQuickClassification } from "@/lib/slack";
import type { ClassificationResult, CompanyWithTitles, ReviewItem } from "@/lib/types";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const body = await req.json();

    if (body.mode === "quick") {
      return handleQuickCheck(body.company, body.slackThreadTs);
    }

    if (body.mode === "batch" && body.companies) {
      return handleBatchFromJson(body.companies, body.source || "API");
    }
  }

  if (contentType.includes("multipart/form-data")) {
    const formData = await req.formData();
    const file = formData.get("file") as File;
    const source = (formData.get("source") as string) || file?.name || "upload";

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const companies = await parseUploadedFile(buffer, file.name);
    return handleBatchFromJson(companies, source);
  }

  return NextResponse.json({ error: "Invalid request" }, { status: 400 });
}

async function handleQuickCheck(companyName: string, slackThreadTs?: string) {
  const lists = await fetchCompanyLists();
  const classifier = new CompanyClassifier(lists.exclusions, lists.tags, lists.prospects);

  const result = classifier.classifyKnown(companyName);

  if (result) {
    if (slackThreadTs) {
      await sendQuickClassification({
        companyName,
        action: result.action,
        category: result.category,
        confidence: result.confidence,
        threadTs: slackThreadTs,
      });
    }
    return NextResponse.json(result);
  }

  const agentResults = await classifyWithAgent([{ name: companyName, titles: [] }]);

  const agentResult = agentResults[0] || {
    name: companyName,
    action: "prospect" as const,
    category: null,
    confidence: "claude" as const,
    rationale: "No classification available",
  };

  if (slackThreadTs) {
    await sendQuickClassification({
      companyName,
      action: agentResult.action,
      category: agentResult.category,
      confidence: agentResult.confidence,
      threadTs: slackThreadTs,
    });
  }

  return NextResponse.json(agentResult);
}

async function handleBatchFromJson(companies: CompanyWithTitles[], source: string) {
  const lists = await fetchCompanyLists();
  const classifier = new CompanyClassifier(lists.exclusions, lists.tags, lists.prospects);

  const knownResults: ClassificationResult[] = [];
  const unknowns: CompanyWithTitles[] = [];

  for (const company of companies) {
    const known = classifier.classifyKnown(company.name);
    if (known) {
      knownResults.push(known);
    } else {
      unknowns.push(company);
    }
  }

  let agentResults: ClassificationResult[] = [];
  if (unknowns.length > 0) {
    agentResults = await classifyWithAgent(unknowns);
  }

  const reviewItems: ReviewItem[] = agentResults.map((r) => {
    const companyData = unknowns.find((u) => u.name === r.name);
    return {
      name: r.name,
      titles: companyData?.titles || [],
      action: r.action,
      category: r.category,
      rationale: r.rationale,
    };
  });

  const reviewId = await createReview({ source, items: reviewItems, knownResults });

  const excludedCount = knownResults.filter((r) => r.action === "exclude").length;
  const taggedCount = knownResults.filter((r) => r.action === "tag").length;
  const prospectCount = knownResults.filter((r) => r.action === "prospect").length;

  await sendReviewNotification({
    reviewId,
    source,
    totalCompanies: companies.length,
    knownMatches: knownResults.length,
    needsReview: reviewItems.length,
    excludedCompanies: excludedCount,
    taggedCompanies: taggedCount,
    prospectCompanies: prospectCount,
  });

  return NextResponse.json({
    reviewId,
    totalCompanies: companies.length,
    knownMatches: knownResults.length,
    needsReview: reviewItems.length,
    reviewUrl: `/review/${reviewId}`,
  });
}
