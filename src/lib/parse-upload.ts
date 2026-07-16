import * as XLSX from "xlsx";
import type { CompanyWithTitles } from "./types";

export interface RawUploadData {
  headers: string[];
  rows: Record<string, string>[];
}

export function detectColumns(headers: string[]): {
  companyCol: number;
  titleCol: number;
} {
  const lower = headers.map((h) => h.toLowerCase().trim());

  let companyCol = lower.findIndex((h) => h.includes("company"));
  let titleCol = lower.findIndex((h) => h.includes("title") || h.includes("job"));

  if (companyCol === -1) companyCol = 0;
  if (titleCol === -1) titleCol = companyCol === 0 ? 1 : 0;
  if (titleCol === companyCol) titleCol = Math.min(companyCol + 1, headers.length - 1);

  return { companyCol, titleCol };
}

export async function parseUploadedFile(
  buffer: Buffer,
  filename: string
): Promise<CompanyWithTitles[]> {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows: string[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
  });

  if (rows.length < 2) return [];

  const headers = rows[0].map(String);
  const { companyCol, titleCol } = detectColumns(headers);

  const grouped = new Map<string, string[]>();

  for (let i = 1; i < rows.length; i++) {
    const company = String(rows[i][companyCol] || "").trim();
    const title = String(rows[i][titleCol] || "").trim();
    if (!company) continue;

    if (!grouped.has(company)) {
      grouped.set(company, []);
    }
    if (title) {
      grouped.get(company)!.push(title);
    }
  }

  return Array.from(grouped.entries()).map(([name, titles]) => ({
    name,
    titles,
  }));
}

/**
 * Parse uploaded file and return ALL raw column data as key-value records.
 * Used by the Claude extraction agent to intelligently map messy columns.
 */
export async function parseUploadedFileRaw(
  buffer: Buffer,
  filename: string
): Promise<RawUploadData> {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows: string[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
  });

  if (rows.length < 2) return { headers: [], rows: [] };

  const headers = rows[0].map(String);
  const records: Record<string, string>[] = [];

  for (let i = 1; i < rows.length; i++) {
    const record: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      const val = String(rows[i][j] || "").trim();
      if (val) record[headers[j]] = val;
    }
    if (Object.keys(record).length > 0) records.push(record);
  }

  return { headers, rows: records };
}
