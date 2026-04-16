// ── orchestrator: coordinates the 4-phase scraping pipeline ──

import type { ScrapeConfig, ScrapeResult, SchoolInfo, Address } from "./types";
import { scrapeSchool } from "./scraper";
import { lookupSchool, ncesRecordToAddress, extractSchoolNameFromUrl } from "./nces";
import { validateTeachers, inferEmails } from "./validator";
import { enrichWithLinkedin } from "./linkedin";
import { generateCsv, writeCsv } from "./csv";
import { extractDomain } from "./utils";

/**
 * runs the full pipeline: scrape → nces verify → linkedin enrich → csv export.
 * the onStatus callback receives human-readable progress messages.
 */
export async function run(
  config: ScrapeConfig,
  onStatus?: (msg: string) => void,
  onLiveUrl?: (url: string) => void,
): Promise<ScrapeResult> {
  const log = onStatus ?? (() => {});
  const startTime = Date.now();
  const warnings: string[] = [];

  // ── phase 1: scrape the school website ──
  log("phase 1: crawling school website...");
  const scrapeResult = await scrapeSchool(config.schoolUrl, onStatus, onLiveUrl);

  const schoolDomain = extractDomain(config.schoolUrl);
  const rawTeacherCount = scrapeResult.teachers.length;
  log(`found ${rawTeacherCount} potential STEM teachers on the site`);

  // ── phase 2: verify school info with nces ──
  log("phase 2: verifying with NCES...");
  const schoolInfo = await resolveSchoolInfo(
    scrapeResult.schoolName,
    scrapeResult.schoolAddress,
    config.schoolUrl,
    log,
    warnings,
  );

  // ── validate and clean teacher data ──
  log("validating and cleaning teacher data...");
  let teachers = validateTeachers(scrapeResult.teachers, schoolDomain);
  log(`filtered to ${teachers.length} verified STEM teachers`);

  if (teachers.length === 0) {
    warnings.push("no STEM teachers found — the school site may not have a staff directory, or the directory may not list subjects/departments");
  }

  // ── phase 3: linkedin enrichment (optional) ──
  if (config.enableLinkedin && config.linkedinProfileId && teachers.length > 0) {
    log("phase 3: enriching with LinkedIn...");
    teachers = await enrichWithLinkedin(
      teachers,
      schoolInfo.name,
      config.linkedinProfileId,
      onStatus,
    );

    // add "nces" to sources for teachers whose address came from nces
    if (schoolInfo.address?.source === "nces") {
      for (const t of teachers) {
        if (!t.sources.includes("nces")) t.sources.push("nces");
      }
    }
  } else {
    log("phase 3: linkedin enrichment skipped");

    if (schoolInfo.address?.source === "nces") {
      for (const t of teachers) {
        if (!t.sources.includes("nces")) t.sources.push("nces");
      }
    }
  }

  // ── assemble the final result ──
  const result: ScrapeResult = {
    school: schoolInfo,
    teachers,
    metadata: {
      scrapedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      pagesVisited: 0, // browser-use doesn't expose this directly
      browserUseSessionId: scrapeResult.sessionId,
      warnings,
    },
  };

  // ── phase 4: export csv ──
  log("phase 4: exporting CSV...");
  const csv = generateCsv(result);
  await writeCsv(config.outputPath, csv);
  log(`wrote ${teachers.length} teachers to ${config.outputPath}`);

  return result;
}

// ── helpers ──

/**
 * resolves the most accurate school info by combining data
 * from the website scrape and the NCES database.
 */
async function resolveSchoolInfo(
  scrapedName: string | null,
  scrapedAddress: string | null,
  schoolUrl: string,
  log: (msg: string) => void,
  warnings: string[],
): Promise<SchoolInfo> {
  // determine the school name to search nces with
  const nameForSearch =
    scrapedName ?? extractSchoolNameFromUrl(schoolUrl) ?? "";

  let ncesAddress: Address | null = null;
  let ncesDistrict: string | null = null;
  let ncesPhone: string | null = null;
  let ncesId: string | null = null;
  let officialName = scrapedName ?? "";

  if (nameForSearch) {
    // try to extract state from the scraped address or url
    const state = extractState(scrapedAddress, schoolUrl);
    const record = await lookupSchool(nameForSearch, state ?? undefined);

    if (record) {
      log(`matched NCES record: ${record.school_name} (${record.ncessch})`);
      ncesAddress = ncesRecordToAddress(record);
      ncesDistrict = record.lea_name !== "-1" ? record.lea_name : null;
      ncesPhone = record.phone !== "-1" ? record.phone : null;
      ncesId = record.ncessch;
      officialName = record.school_name; // prefer the federal name
    } else {
      log("no NCES match found — using school website data");
      warnings.push("school not found in NCES database — address from school website only");
    }
  }

  // fall back to the scraped address if nces didn't match
  const address: Address | null = ncesAddress ?? parseAddress(scrapedAddress);

  return {
    name: officialName || "Unknown School",
    url: schoolUrl,
    address,
    phone: ncesPhone,
    district: ncesDistrict,
    ncesId,
  };
}

/** tries to pull a 2-letter state code from an address string or url */
function extractState(
  address: string | null,
  url: string,
): string | null {
  const states = [
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
    "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
    "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
    "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
    "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
    "DC",
  ];

  // check address string for "STATE" or ", STATE ZIP" pattern
  if (address) {
    for (const st of states) {
      const pattern = new RegExp(`\\b${st}\\b`, "i");
      if (pattern.test(address)) return st;
    }
  }

  // check url for .k12.XX.us pattern
  const k12Match = url.match(/\.k12\.(\w{2})\.us/i);
  if (k12Match) return k12Match[1]!.toUpperCase();

  return null;
}

/** parses a freeform address string into our Address type */
function parseAddress(raw: string | null): Address | null {
  if (!raw?.trim()) return null;

  // try to split "123 Main St, City, ST 12345" format
  const parts = raw.split(",").map((s) => s.trim());

  if (parts.length >= 3) {
    const lastPart = parts[parts.length - 1]!;
    const stateZip = lastPart.match(/^([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);

    return {
      street: parts.slice(0, -2).join(", "),
      city: parts[parts.length - 2]!,
      state: stateZip?.[1] ?? "",
      zip: stateZip?.[2] ?? lastPart,
      source: "school_website",
    };
  }

  // can't parse reliably — stuff it all in street
  return {
    street: raw,
    city: "",
    state: "",
    zip: "",
    source: "school_website",
  };
}
