import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ScrapeResult, Teacher } from "./types";

const HEADERS = [
  "first_name",
  "last_name",
  "email",
  "role",
  "department",
  "school_name",
  "school_address",
  "school_city",
  "school_state",
  "school_zip",
  "school_phone",
  "school_district",
  "linkedin_url",
  "data_sources",
  "confidence_score",
] as const;

function escapeField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function teacherToRow(teacher: Teacher, result: ScrapeResult): string {
  const { school } = result;
  const addr = school.address;

  const fields: string[] = [
    teacher.firstName,
    teacher.lastName,
    teacher.email ?? "",
    teacher.role,
    teacher.department ?? "",
    school.name,
    addr?.street ?? "",
    addr?.city ?? "",
    addr?.state ?? "",
    addr?.zip ?? "",
    school.phone ?? "",
    school.district ?? "",
    teacher.linkedinUrl ?? "",
    teacher.sources.join(";"),
    String(teacher.confidence),
  ];

  return fields.map(escapeField).join(",");
}

export function generateCsv(result: ScrapeResult): string {
  const header = HEADERS.join(",");
  const rows = result.teachers.map((t) => teacherToRow(t, result));
  return [header, ...rows].join("\n") + "\n";
}

export async function writeCsv(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await Bun.write(filePath, content);
}
