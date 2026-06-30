import { Octokit } from "@octokit/rest";
import type { CompanyListFile, ProspectListFile } from "./types";

function getOctokit() {
  return new Octokit({ auth: process.env.GITHUB_TOKEN });
}

function repoParams() {
  return {
    owner: process.env.GITHUB_OWNER!,
    repo: process.env.GITHUB_REPO!,
  };
}

async function fetchFile(octokit: Octokit, path: string) {
  const { data } = await octokit.repos.getContent({
    ...repoParams(),
    path,
    ref: process.env.GITHUB_BRANCH || "main",
  });
  if ("content" in data && data.content) {
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    return { parsed: JSON.parse(content), sha: data.sha };
  }
  throw new Error(`File ${path} is not a file or has no content`);
}

export interface CompanyListsData {
  exclusions: CompanyListFile;
  tags: CompanyListFile;
  prospects: ProspectListFile;
  shas: { exclusions: string; tags: string; prospects: string };
}

export async function fetchCompanyLists(): Promise<CompanyListsData> {
  const octokit = getOctokit();
  const [exclusionsResult, tagsResult, prospectsResult] = await Promise.all([
    fetchFile(octokit, "company-lists/exclusions.json"),
    fetchFile(octokit, "company-lists/tags.json"),
    fetchFile(octokit, "company-lists/known_prospects.json"),
  ]);
  return {
    exclusions: exclusionsResult.parsed as CompanyListFile,
    tags: tagsResult.parsed as CompanyListFile,
    prospects: prospectsResult.parsed as ProspectListFile,
    shas: {
      exclusions: exclusionsResult.sha,
      tags: tagsResult.sha,
      prospects: prospectsResult.sha,
    },
  };
}

export async function commitCompanyListUpdates(updates: {
  exclusions?: CompanyListFile;
  exclusionsSha?: string;
  tags?: CompanyListFile;
  tagsSha?: string;
  prospects?: ProspectListFile;
  prospectsSha?: string;
  message: string;
}) {
  const octokit = getOctokit();
  const commits: Promise<unknown>[] = [];

  if (updates.exclusions && updates.exclusionsSha) {
    commits.push(
      octokit.repos.createOrUpdateFileContents({
        ...repoParams(),
        path: "company-lists/exclusions.json",
        message: updates.message,
        content: Buffer.from(
          JSON.stringify(updates.exclusions, null, 2) + "\n"
        ).toString("base64"),
        sha: updates.exclusionsSha,
        branch: process.env.GITHUB_BRANCH || "main",
      })
    );
  }

  if (updates.tags && updates.tagsSha) {
    commits.push(
      octokit.repos.createOrUpdateFileContents({
        ...repoParams(),
        path: "company-lists/tags.json",
        message: updates.message,
        content: Buffer.from(
          JSON.stringify(updates.tags, null, 2) + "\n"
        ).toString("base64"),
        sha: updates.tagsSha,
        branch: process.env.GITHUB_BRANCH || "main",
      })
    );
  }

  if (updates.prospects && updates.prospectsSha) {
    commits.push(
      octokit.repos.createOrUpdateFileContents({
        ...repoParams(),
        path: "company-lists/known_prospects.json",
        message: updates.message,
        content: Buffer.from(
          JSON.stringify(updates.prospects, null, 2) + "\n"
        ).toString("base64"),
        sha: updates.prospectsSha,
        branch: process.env.GITHUB_BRANCH || "main",
      })
    );
  }

  await Promise.all(commits);
}
