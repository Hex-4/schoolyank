// ── validate, enrich, and deduplicate raw teacher data ──

import type {
  RawTeacherData,
  Teacher,
  ConfidenceScore,
  DataSource,
} from "./types";
import { parseName, normalizeEmail } from "./utils";

// ── stem keyword lists ──

const MATH_KEYWORDS = [
  "algebra", "geometry", "calculus", "precalculus", "trigonometry",
  "statistics", "probability", "math", "mathematics",
];

const SCIENCE_KEYWORDS = [
  "physics", "chemistry", "biology", "environmental science", "earth science",
  "geology", "anatomy", "physiology", "forensic science", "marine biology",
  "astronomy", "physical science", "life science", "science",
];

const TECH_KEYWORDS = [
  "computer science", "engineering", "stem", "technology", "robotics",
  "coding", "programming", "information technology",
];

const STEM_KEYWORDS = [...TECH_KEYWORDS, ...SCIENCE_KEYWORDS, ...MATH_KEYWORDS];

// phrases that look like STEM but aren't
const FALSE_POSITIVE_PATTERNS = [
  /\bpolitical\s+science\b/i,
  /\bsocial\s+science\b/i,
  /\blibrary\s+science\b/i,
  /\bexercise\s+science\b/i,
  /\bsports?\s+science\b/i,
  /\bscience\s+of\b(?!\s+(?:physics|chemistry|biology|engineering|computing|mathematics))/i,
  /\baftermath\b/i,
];

// ── public api ──

/**
 * checks if a role/department string indicates a STEM teacher.
 * matches against known stem keywords while filtering out false positives.
 */
export function isStemRole(role: string, department?: string | null): boolean {
  const combined = [role, department].filter(Boolean).join(" ").toLowerCase();

  if (!combined) return false;

  // reject false positives first
  for (const pattern of FALSE_POSITIVE_PATTERNS) {
    if (pattern.test(combined)) {
      // if the false positive consumes the only "science" or "math" in the string,
      // strip it and continue checking what's left
      const stripped = combined.replace(pattern, " ").trim();
      if (stripped === combined) continue; // pattern didn't match (shouldn't happen)

      // check if the stripped version still has stem keywords
      return hasStemKeyword(stripped);
    }
  }

  return hasStemKeyword(combined);
}

function hasStemKeyword(text: string): boolean {
  // sort by length descending so multi-word keywords match before sub-words
  for (const kw of STEM_KEYWORDS) {
    const pattern = new RegExp(`\\b${escapeRegex(kw)}\\b`, "i");
    if (pattern.test(text)) return true;
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * detects the email pattern from existing emails and fills in missing ones.
 * requires 3+ matching emails to infer the pattern.
 */
export function inferEmails(teachers: Teacher[]): Teacher[] {
  const withEmail = teachers.filter((t) => t.email);
  if (withEmail.length < 3) return teachers;

  // extract the shared domain from existing emails
  const domains = withEmail.map((t) => t.email!.split("@")[1] ?? "");
  const domainCounts = new Map<string, number>();
  for (const d of domains) {
    if (d) domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
  }

  // pick the most common domain
  let topDomain = "";
  let topCount = 0;
  for (const [d, c] of domainCounts) {
    if (c > topCount) { topDomain = d; topCount = c; }
  }

  if (topCount < 3) return teachers;

  // try each pattern against teachers with that domain
  type PatternFn = (first: string, last: string, domain: string) => string;
  const patterns: { name: string; fn: PatternFn }[] = [
    { name: "first.last", fn: (f, l, d) => `${f}.${l}@${d}` },
    { name: "firstlast", fn: (f, l, d) => `${f}${l}@${d}` },
    { name: "first_last", fn: (f, l, d) => `${f}_${l}@${d}` },
    { name: "flast", fn: (f, l, d) => `${f[0]}${l}@${d}` },
  ];

  const domainTeachers = withEmail.filter((t) => t.email!.endsWith(`@${topDomain}`));

  let bestPattern: PatternFn | null = null;
  let bestMatches = 0;

  for (const { fn } of patterns) {
    let matches = 0;
    for (const t of domainTeachers) {
      const first = t.firstName.toLowerCase();
      const last = t.lastName.toLowerCase();
      if (!first || !last) continue;

      const expected = fn(first, last, topDomain);
      if (expected === t.email) matches++;
    }
    if (matches >= 3 && matches > bestMatches) {
      bestPattern = fn;
      bestMatches = matches;
    }
  }

  if (!bestPattern) return teachers;

  // apply the detected pattern to teachers missing emails
  return teachers.map((t) => {
    if (t.email) return t;

    const first = t.firstName.toLowerCase();
    const last = t.lastName.toLowerCase();
    if (!first || !last) return t;

    return {
      ...t,
      email: bestPattern!(first, last, topDomain),
      sources: [...t.sources.filter((s) => s !== "inferred"), "inferred" as DataSource],
    };
  });
}

/**
 * main validation pipeline — transforms raw extracted data into clean Teacher records.
 */
export function validateTeachers(raw: RawTeacherData[], schoolDomain: string): Teacher[] {
  const domain = schoolDomain.toLowerCase().replace(/^www\./, "");

  // step a + b: parse names and normalize emails
  let teachers: Teacher[] = raw
    .filter((r) => r.name?.trim())
    .map((r) => {
      const { firstName, lastName } = parseName(r.name);
      const email = r.email ? normalizeEmail(r.email) : null;

      // step c: flag domain mismatches (keep the email, but note it)
      let emailDomainMatch = false;
      if (email) {
        const emailDomain = email.split("@")[1];
        emailDomainMatch = emailDomain === domain;
      }

      return {
        firstName,
        lastName,
        email,
        role: r.role?.trim() ?? "",
        department: r.department?.trim() || null,
        phoneExtension: r.phone?.trim() || null,
        linkedinUrl: null,
        sources: ["school_website"] as DataSource[],
        confidence: 1 as ConfidenceScore,
        _emailDomainMatch: emailDomainMatch,
      };
    });

  // step d: infer missing emails from detected patterns
  teachers = inferEmails(teachers);

  // step e: filter out non-STEM teachers
  teachers = teachers.filter((t) => {
    if (!t.role && !t.department) return false;
    return isStemRole(t.role, t.department);
  });

  // step f: deduplicate by first + last name
  const seen = new Map<string, Teacher>();
  for (const t of teachers) {
    const key = `${t.firstName.toLowerCase()}|${t.lastName.toLowerCase()}`;
    const existing = seen.get(key);
    if (!existing || scoreTeacher(t) > scoreTeacher(existing)) {
      seen.set(key, t);
    }
  }
  teachers = [...seen.values()];

  // step g: assign confidence scores
  teachers = teachers.map((t) => {
    const emailDomain = t.email?.split("@")[1];
    const domainMatches = emailDomain === domain;
    const hasEmail = !!t.email;
    const isInferred = t.sources.includes("inferred");
    const stemRole = isStemRole(t.role, t.department);
    const ambiguousRole = stemRole && isAmbiguousRole(t.role);

    let confidence: ConfidenceScore;
    if (hasEmail && domainMatches && stemRole && !ambiguousRole) {
      confidence = 5;
    } else if (hasEmail && domainMatches && stemRole && ambiguousRole) {
      confidence = 4;
    } else if (stemRole && (!hasEmail || isInferred)) {
      confidence = 3;
    } else if (hasEmail && !stemRole) {
      confidence = 2;
    } else {
      confidence = 1;
    }

    // strip internal metadata
    const { _emailDomainMatch, ...clean } = t as Teacher & { _emailDomainMatch?: boolean };
    return { ...clean, confidence };
  });

  // step h: sources already set to ["school_website"] (+ "inferred" where applicable)

  // sort by confidence desc, then last name asc
  teachers.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.lastName.localeCompare(b.lastName);
  });

  return teachers;
}

// ── internal helpers ──

/** quick confidence proxy for dedup — prefer records with more data */
function scoreTeacher(t: Teacher): number {
  let s = 0;
  if (t.email) s += 3;
  if (t.role) s += 2;
  if (t.department) s += 1;
  if (t.phoneExtension) s += 1;
  return s;
}

/** roles that mention stem-adjacent terms but aren't clearly a stem teaching role */
function isAmbiguousRole(role: string): boolean {
  const lower = role.toLowerCase();
  const ambiguous = [
    /\btechnology\s+coordinator\b/,
    /\btechnology\s+director\b/,
    /\bstem\s+coordinator\b/,
    /\bdepartment\s+(head|chair)\b/,
    /\bassistant\b/,
    /\baide\b/,
    /\bsubstitute\b/,
    /\btutor\b/,
  ];
  return ambiguous.some((p) => p.test(lower));
}
