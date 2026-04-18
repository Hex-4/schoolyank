// ── nces.ts — look up verified school info from the federal NCES database ──

import type { Address, NCESSchoolRecord } from "./types";

const API_BASE = "https://educationdata.urban.org/api/v1/schools/ccd/directory/2023";

// ── public api ──────────────────────────────────────────────────────────────────

/**
 * queries the urban institute education data portal for a school by name.
 * optionally filters by 2-letter state code. returns the best fuzzy match,
 * or null if nothing reasonable comes back.
 */
export async function lookupSchool(
  schoolName: string,
  state?: string,
): Promise<NCESSchoolRecord | null> {
  const params = new URLSearchParams({ school_name: schoolName });
  if (state) params.set("state_location", state.toLowerCase());

  const url = `${API_BASE}/?${params}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[nces] api returned ${res.status} for ${url}`);
      return null;
    }

    const data = (await res.json()) as { results: NCESSchoolRecord[] };
    if (!data.results?.length) return null;

    // single result — just return it
    if (data.results.length === 1) return data.results[0] ?? null;

    // multiple results — pick the best fuzzy match
    return bestMatch(schoolName, data.results);
  } catch (err) {
    console.error(`[nces] failed to fetch school data:`, err);
    return null;
  }
}

/**
 * lists every school in a district by its NCES LEA id. walks paginated results
 * until the api reports no more pages. the LEA roster is the authoritative list
 * for per-teacher school resolution in district mode.
 */
export async function lookupSchoolsInDistrict(
  leaid: string,
): Promise<NCESSchoolRecord[]> {
  const records: NCESSchoolRecord[] = [];
  let page = 1;

  while (true) {
    const params = new URLSearchParams({ leaid, page: String(page) });
    const url = `${API_BASE}/?${params}`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`[nces] api returned ${res.status} for ${url}`);
        break;
      }

      const data = (await res.json()) as {
        results: NCESSchoolRecord[];
        next?: string | null;
      };

      if (!data.results?.length) break;
      records.push(...data.results);

      if (!data.next) break;
      page++;
    } catch (err) {
      console.error(`[nces] failed to fetch district schools:`, err);
      break;
    }
  }

  return records;
}

/**
 * given a list of schools in a district and a scraped school name, return the
 * nces record that best matches. uses word-overlap + levenshtein on normalized
 * names. returns null if no candidate is reasonably close.
 */
export function matchSchoolInDistrict(
  scrapedName: string,
  schools: NCESSchoolRecord[],
): NCESSchoolRecord | null {
  if (!scrapedName.trim() || schools.length === 0) return null;

  // extract any uppercase initialism from the scraped name (e.g. "CVU" from
  // "CVU High School"). we'll boost roster candidates whose first-letter
  // acronym matches this — catches cases like "CVU High School" vs
  // "Champlain Valley Union High School" that pure word-overlap misses.
  const initialism = extractInitialism(scrapedName);

  // tokenize the scraped name (excluding generic fillers) for word overlap
  const qWords = tokenize(scrapedName);

  let best: NCESSchoolRecord | null = null;
  let bestScore = -Infinity;

  for (const s of schools) {
    const nWords = tokenize(s.school_name);
    const overlap = setOverlap(qWords, nWords);

    const dist = levenshtein(
      normalize(scrapedName),
      normalize(s.school_name),
    );
    const maxLen = Math.max(scrapedName.length, s.school_name.length, 1);
    const lev = 1 - dist / maxLen;

    // initialism boost: if the scraped name has an all-caps word like "CVU"
    // and the candidate's first-letters-of-words match it, give a big bump.
    const initialsMatch =
      initialism && acronymOf(s.school_name).includes(initialism);
    const boost = initialsMatch ? 0.4 : 0;

    const score = overlap * 0.6 + lev * 0.2 + boost;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }

  return bestScore >= 0.35 ? best : null;
}

/** pull out any all-caps word of 2-5 letters — typical school acronym shape */
function extractInitialism(s: string): string | null {
  const match = s.match(/\b([A-Z]{2,5})\b/);
  return match ? match[1]!.toLowerCase() : null;
}

/** build a first-letter acronym from a multi-word name */
function acronymOf(s: string): string {
  return (s.match(/\b[a-zA-Z]/g) ?? []).join("").toLowerCase();
}

// words we ignore when comparing names — they carry no discriminating info
const GENERIC_TOKENS = new Set([
  "school", "schools", "the", "of", "and", "at",
  "academy", "institute", "center", "centre",
]);

/** tokenize a school name into content words, dropping generic fillers */
function tokenize(name: string): Set<string> {
  const words = normalize(name).match(/[a-z0-9]+/g) ?? [];
  return new Set(words.filter((w) => !GENERIC_TOKENS.has(w) && w.length > 1));
}

/**
 * converts an NCES record into our Address type.
 * prefers mailing address; falls back to location address when mailing
 * fields are "-1" (the api's sentinel for missing data).
 */
export function ncesRecordToAddress(record: NCESSchoolRecord): Address {
  const mailingMissing =
    record.street_mailing === "-1" ||
    record.city_mailing === "-1" ||
    record.zip_mailing === "-1";

  if (mailingMissing) {
    return {
      street: record.street_location,
      city: record.city_location,
      state: record.state_location,
      zip: record.zip_location,
      source: "nces",
    };
  }

  return {
    street: record.street_mailing,
    city: record.city_mailing,
    state: record.state_mailing,
    zip: record.zip_mailing,
    source: "nces",
  };
}

/**
 * tries to pull a human-readable school name out of a url.
 *   "https://www.lincolnhigh.edu"              → "lincoln high"
 *   "https://schools.district.org/jefferson-middle" → "jefferson middle"
 * returns null if nothing useful can be extracted.
 */
export function extractSchoolNameFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  // try the last meaningful path segment first (e.g. /jefferson-middle)
  const segments = parsed.pathname.split("/").filter(Boolean);
  const lastSegment = segments.at(-1);
  if (lastSegment && !looksLikeJunk(lastSegment)) {
    return humanize(lastSegment);
  }

  // fall back to the hostname — strip www/schools subdomains and the tld
  const hostParts = parsed.hostname.split(".");
  // drop common prefixes
  while (hostParts.length > 1 && ["www", "schools", "school", "sites"].includes(hostParts[0]!)) {
    hostParts.shift();
  }
  // drop tld (and second-level tld like .co.uk)
  if (hostParts.length > 1) hostParts.pop();
  if (hostParts.length > 1 && hostParts.at(-1)!.length <= 3) hostParts.pop();

  const candidate = hostParts.join("");
  if (!candidate || looksLikeJunk(candidate)) return null;

  return humanize(candidate);
}

// ── helpers ─────────────────────────────────────────────────────────────────────

/** picks the NCESSchoolRecord whose name best matches the query */
function bestMatch(query: string, records: NCESSchoolRecord[]): NCESSchoolRecord {
  const q = normalize(query);
  let best = records[0]!;
  let bestScore = Infinity;

  for (const record of records) {
    const score = levenshtein(q, normalize(record.school_name));
    if (score < bestScore) {
      bestScore = score;
      best = record;
    }
  }

  return best;
}

/** lowercases and strips non-alphanumeric chars for comparison */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** jaccard overlap between two string sets */
function setOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = new Set([...a, ...b]).size;
  return inter / union;
}

/** classic levenshtein distance — no external deps needed */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  // single-row dp — only need the previous row at any point
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val = Math.min(
        row[j]! + 1,      // deletion
        prev + 1,          // insertion
        row[j - 1]! + cost // substitution
      );
      row[j - 1] = prev;
      prev = val;
    }
    row[b.length] = prev;
  }

  return row[b.length]!;
}

/**
 * splits camelCase / kebab-case / run-together words into a readable name.
 * "lincolnhigh" → "lincoln high", "jefferson-middle" → "jefferson middle"
 */
function humanize(slug: string): string {
  return slug
    .replace(/[-_]/g, " ")          // kebab/snake → spaces
    .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase → spaces
    .replace(/\d+/g, "")            // drop numbers
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ") || null as unknown as string;
}

/** returns true if a url segment is too generic to be a school name */
function looksLikeJunk(s: string): boolean {
  const junk = new Set([
    "index", "home", "about", "main", "default",
    "staff", "directory", "contact", "info", "page",
  ]);
  return s.length < 3 || junk.has(s.toLowerCase());
}
