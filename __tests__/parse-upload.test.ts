import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { detectColumns, parseUploadedFile } from "@/lib/parse-upload";

function createTestXlsx(data: string[][]): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

describe("detectColumns", () => {
  it("detects 'Company' and 'Job Title' columns", () => {
    const result = detectColumns(["Company", "Job Title", "Email"]);
    expect(result.companyCol).toBe(0);
    expect(result.titleCol).toBe(1);
  });

  it("detects columns case-insensitively", () => {
    const result = detectColumns(["COMPANY NAME", "EMAIL", "JOB TITLE"]);
    expect(result.companyCol).toBe(0);
    expect(result.titleCol).toBe(2);
  });

  it("falls back to first two columns when no match", () => {
    const result = detectColumns(["Name", "Role", "Email"]);
    expect(result.companyCol).toBe(0);
    expect(result.titleCol).toBe(1);
  });

  it("handles single column gracefully", () => {
    const result = detectColumns(["Company"]);
    // companyCol = 0, titleCol falls back to 1 (no title keyword found, companyCol === 0)
    expect(result.companyCol).toBe(0);
    // titleCol = 1 (fallback when companyCol === 0 and no title match)
    // Note: titleCol may be out of bounds for single-column input,
    // but the function still returns a valid index pair
    expect(result.titleCol).toBe(1);
  });

  it("detects 'title' keyword in column header", () => {
    const result = detectColumns(["ID", "Title", "Company Name"]);
    expect(result.companyCol).toBe(2);
    expect(result.titleCol).toBe(1);
  });

  it("handles whitespace in headers", () => {
    const result = detectColumns(["  Company  ", "  Job Title  "]);
    expect(result.companyCol).toBe(0);
    expect(result.titleCol).toBe(1);
  });
});

describe("parseUploadedFile", () => {
  it("parses an XLSX buffer with company and title columns", async () => {
    const data = [
      ["Company", "Job Title"],
      ["Acme Corp", "Engineer"],
      ["Beta Inc", "Manager"],
    ];
    const buffer = createTestXlsx(data);
    const result = await parseUploadedFile(buffer, "test.xlsx");

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ name: "Acme Corp", titles: ["Engineer"] });
    expect(result[1]).toEqual({ name: "Beta Inc", titles: ["Manager"] });
  });

  it("groups multiple rows from the same company", async () => {
    const data = [
      ["Company", "Job Title"],
      ["Acme Corp", "Engineer"],
      ["Acme Corp", "Designer"],
      ["Acme Corp", "PM"],
      ["Beta Inc", "Manager"],
    ];
    const buffer = createTestXlsx(data);
    const result = await parseUploadedFile(buffer, "test.xlsx");

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      name: "Acme Corp",
      titles: ["Engineer", "Designer", "PM"],
    });
    expect(result[1]).toEqual({ name: "Beta Inc", titles: ["Manager"] });
  });

  it("skips empty company names", async () => {
    const data = [
      ["Company", "Job Title"],
      ["Acme Corp", "Engineer"],
      ["", "Designer"],
      ["  ", "PM"],
      ["Beta Inc", "Manager"],
    ];
    const buffer = createTestXlsx(data);
    const result = await parseUploadedFile(buffer, "test.xlsx");

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("Acme Corp");
    expect(result[1].name).toBe("Beta Inc");
  });

  it("returns empty array for files with only headers", async () => {
    const data = [["Company", "Job Title"]];
    const buffer = createTestXlsx(data);
    const result = await parseUploadedFile(buffer, "test.xlsx");

    expect(result).toEqual([]);
  });

  it("returns empty array for empty files", async () => {
    const data: string[][] = [];
    const buffer = createTestXlsx(data);
    const result = await parseUploadedFile(buffer, "test.xlsx");

    expect(result).toEqual([]);
  });

  it("handles rows with empty titles", async () => {
    const data = [
      ["Company", "Job Title"],
      ["Acme Corp", ""],
      ["Acme Corp", "Engineer"],
    ];
    const buffer = createTestXlsx(data);
    const result = await parseUploadedFile(buffer, "test.xlsx");

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: "Acme Corp",
      titles: ["Engineer"],
    });
  });

  it("auto-detects columns when headers differ", async () => {
    const data = [
      ["ID", "COMPANY NAME", "JOB TITLE", "Email"],
      ["1", "Acme Corp", "Engineer", "a@acme.com"],
      ["2", "Beta Inc", "Manager", "b@beta.com"],
    ];
    const buffer = createTestXlsx(data);
    const result = await parseUploadedFile(buffer, "test.xlsx");

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ name: "Acme Corp", titles: ["Engineer"] });
    expect(result[1]).toEqual({ name: "Beta Inc", titles: ["Manager"] });
  });
});
