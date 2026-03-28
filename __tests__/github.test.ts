import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CompanyListFile, ProspectListFile } from "@/lib/types";

// --- Mock data -----------------------------------------------------------

const exclusionsData: CompanyListFile = {
  categories: {
    vendor: { label: "Vendor", action: "exclude" },
  },
  companies: [
    {
      name: "Acme Corp",
      aliases: ["acme"],
      category: "vendor",
      added: "2026-01-01",
      source: "manual",
    },
  ],
};

const tagsData: CompanyListFile = {
  categories: {
    partner: { label: "Partner", action: "tag" },
  },
  companies: [
    {
      name: "PartnerCo",
      aliases: [],
      category: "partner",
      added: "2026-02-01",
      source: "manual",
    },
  ],
};

const prospectsData: ProspectListFile = {
  companies: [
    {
      name: "ProspectInc",
      aliases: ["prospect"],
      added: "2026-03-01",
      source: "manual",
      note: "Interesting lead",
    },
  ],
};

function toBase64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

// --- Mock Octokit --------------------------------------------------------

const mockGetContent = vi.fn();
const mockCreateOrUpdateFileContents = vi.fn();

vi.mock("@octokit/rest", () => {
  const OctokitClass = function () {
    return {
      repos: {
        getContent: mockGetContent,
        createOrUpdateFileContents: mockCreateOrUpdateFileContents,
      },
    };
  };
  // Make it work with `new` keyword
  OctokitClass.prototype = {};
  return { Octokit: OctokitClass };
});

// --- Tests ---------------------------------------------------------------

describe("github", () => {
  beforeEach(() => {
    mockGetContent.mockReset();
    mockCreateOrUpdateFileContents.mockReset();
    mockCreateOrUpdateFileContents.mockResolvedValue({ data: {} });

    process.env.GITHUB_TOKEN = "test-token";
    process.env.GITHUB_OWNER = "test-owner";
    process.env.GITHUB_REPO = "test-repo";
    delete process.env.GITHUB_BRANCH;
  });

  describe("fetchCompanyLists", () => {
    it("fetches and parses all three JSON files with correct SHAs", async () => {
      mockGetContent
        .mockResolvedValueOnce({
          data: { content: toBase64(exclusionsData), sha: "sha-exclusions" },
        })
        .mockResolvedValueOnce({
          data: { content: toBase64(tagsData), sha: "sha-tags" },
        })
        .mockResolvedValueOnce({
          data: { content: toBase64(prospectsData), sha: "sha-prospects" },
        });

      const { fetchCompanyLists } = await import("@/lib/github");
      const result = await fetchCompanyLists();

      expect(result.exclusions).toEqual(exclusionsData);
      expect(result.tags).toEqual(tagsData);
      expect(result.prospects).toEqual(prospectsData);
      expect(result.shas).toEqual({
        exclusions: "sha-exclusions",
        tags: "sha-tags",
        prospects: "sha-prospects",
      });
    });

    it("calls getContent with correct paths and defaults to main branch", async () => {
      mockGetContent
        .mockResolvedValueOnce({
          data: { content: toBase64(exclusionsData), sha: "sha1" },
        })
        .mockResolvedValueOnce({
          data: { content: toBase64(tagsData), sha: "sha2" },
        })
        .mockResolvedValueOnce({
          data: { content: toBase64(prospectsData), sha: "sha3" },
        });

      const { fetchCompanyLists } = await import("@/lib/github");
      await fetchCompanyLists();

      expect(mockGetContent).toHaveBeenCalledTimes(3);

      const calls = mockGetContent.mock.calls;
      expect(calls[0][0]).toMatchObject({
        owner: "test-owner",
        repo: "test-repo",
        path: "company-lists/exclusions.json",
        ref: "main",
      });
      expect(calls[1][0]).toMatchObject({
        owner: "test-owner",
        repo: "test-repo",
        path: "company-lists/tags.json",
        ref: "main",
      });
      expect(calls[2][0]).toMatchObject({
        owner: "test-owner",
        repo: "test-repo",
        path: "company-lists/known_prospects.json",
        ref: "main",
      });
    });

    it("uses GITHUB_BRANCH env when set", async () => {
      process.env.GITHUB_BRANCH = "develop";

      mockGetContent
        .mockResolvedValueOnce({
          data: { content: toBase64(exclusionsData), sha: "sha1" },
        })
        .mockResolvedValueOnce({
          data: { content: toBase64(tagsData), sha: "sha2" },
        })
        .mockResolvedValueOnce({
          data: { content: toBase64(prospectsData), sha: "sha3" },
        });

      const { fetchCompanyLists } = await import("@/lib/github");
      await fetchCompanyLists();

      for (const call of mockGetContent.mock.calls) {
        expect(call[0].ref).toBe("develop");
      }
    });

    it("throws when file has no content", async () => {
      mockGetContent.mockResolvedValueOnce({
        data: { sha: "sha1" }, // no content field
      });

      const { fetchCompanyLists } = await import("@/lib/github");
      await expect(fetchCompanyLists()).rejects.toThrow(
        /is not a file or has no content/
      );
    });
  });

  describe("commitCompanyListUpdates", () => {
    it("commits all three files when all data and SHAs are provided", async () => {
      const { commitCompanyListUpdates } = await import("@/lib/github");

      await commitCompanyListUpdates({
        exclusions: exclusionsData,
        exclusionsSha: "sha-excl",
        tags: tagsData,
        tagsSha: "sha-tags",
        prospects: prospectsData,
        prospectsSha: "sha-prosp",
        message: "Update company lists",
      });

      expect(mockCreateOrUpdateFileContents).toHaveBeenCalledTimes(3);

      // Verify exclusions call
      const exclCall = mockCreateOrUpdateFileContents.mock.calls.find(
        (c: unknown[]) =>
          (c[0] as { path: string }).path ===
          "company-lists/exclusions.json"
      );
      expect(exclCall).toBeDefined();
      expect(exclCall![0]).toMatchObject({
        owner: "test-owner",
        repo: "test-repo",
        path: "company-lists/exclusions.json",
        message: "Update company lists",
        sha: "sha-excl",
        branch: "main",
      });
      // Verify base64 content decodes to correct JSON
      const exclContent = Buffer.from(
        exclCall![0].content,
        "base64"
      ).toString("utf-8");
      expect(JSON.parse(exclContent)).toEqual(exclusionsData);
      expect(exclContent.endsWith("\n")).toBe(true);

      // Verify tags call
      const tagsCall = mockCreateOrUpdateFileContents.mock.calls.find(
        (c: unknown[]) =>
          (c[0] as { path: string }).path === "company-lists/tags.json"
      );
      expect(tagsCall).toBeDefined();
      expect(tagsCall![0]).toMatchObject({
        path: "company-lists/tags.json",
        sha: "sha-tags",
      });

      // Verify prospects call
      const prospCall = mockCreateOrUpdateFileContents.mock.calls.find(
        (c: unknown[]) =>
          (c[0] as { path: string }).path ===
          "company-lists/known_prospects.json"
      );
      expect(prospCall).toBeDefined();
      expect(prospCall![0]).toMatchObject({
        path: "company-lists/known_prospects.json",
        sha: "sha-prosp",
      });
    });

    it("only commits files that have both data and SHA provided", async () => {
      const { commitCompanyListUpdates } = await import("@/lib/github");

      // Only provide tags — exclusions has no SHA, prospects has no data
      await commitCompanyListUpdates({
        exclusions: exclusionsData,
        // exclusionsSha is missing
        tags: tagsData,
        tagsSha: "sha-tags",
        // prospects data is missing
        prospectsSha: "sha-prosp",
        message: "Partial update",
      });

      expect(mockCreateOrUpdateFileContents).toHaveBeenCalledTimes(1);
      expect(mockCreateOrUpdateFileContents.mock.calls[0][0].path).toBe(
        "company-lists/tags.json"
      );
    });

    it("commits nothing when no data/SHA pairs are complete", async () => {
      const { commitCompanyListUpdates } = await import("@/lib/github");

      await commitCompanyListUpdates({
        exclusions: exclusionsData,
        // no SHA
        message: "No-op update",
      });

      expect(mockCreateOrUpdateFileContents).not.toHaveBeenCalled();
    });

    it("uses GITHUB_BRANCH env for branch parameter", async () => {
      process.env.GITHUB_BRANCH = "staging";

      const { commitCompanyListUpdates } = await import("@/lib/github");

      await commitCompanyListUpdates({
        tags: tagsData,
        tagsSha: "sha-tags",
        message: "Branch test",
      });

      expect(mockCreateOrUpdateFileContents.mock.calls[0][0].branch).toBe(
        "staging"
      );
    });

    it("encodes content as pretty-printed JSON with trailing newline", async () => {
      const { commitCompanyListUpdates } = await import("@/lib/github");

      await commitCompanyListUpdates({
        exclusions: exclusionsData,
        exclusionsSha: "sha1",
        message: "Format test",
      });

      const raw = Buffer.from(
        mockCreateOrUpdateFileContents.mock.calls[0][0].content,
        "base64"
      ).toString("utf-8");

      // Should be pretty-printed (2-space indent)
      expect(raw).toBe(JSON.stringify(exclusionsData, null, 2) + "\n");
    });
  });
});
