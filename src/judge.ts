// ── llm judgment passes ──
//
// keyword heuristics are fast and deterministic but miss ambiguous cases
// ("Innovation Lab Director", "Educator & Tech Consultant", "Upper School
// Integrated Studies"). for data quality parity with human review we ask a
// language model to adjudicate — but BATCHED, one call per pass regardless of
// teacher count, so total overhead stays in the ~5-15s range on top of a
// ~3min pipeline.
//
// both passes are best-effort: on any error the orchestrator falls back to
// the keyword-based result, so a flaky endpoint never blocks the pipeline.

import { askJson } from "./ai";
import type { HackerScore, Teacher } from "./types";

// ── stem + hacker score batch ────────────────────────────────────────────────

export interface StemAndHackerJudgment {
  index: number;
  isStem: boolean;
  hackerScore: HackerScore;
}

interface BatchResponse<T> {
  results: T[];
}

const STEM_HACKER_SYSTEM = `You classify K-12 teacher records for a Hack Club data pipeline. Hack Club is a global nonprofit that nurtures hacker values (curiosity, building, coding, tinkering) in teenagers via project-based learning.

For each teacher, decide TWO things:

1. isStem (boolean): is the teacher currently in a K-12 STEM-adjacent role? BE INCLUSIVE — the pipeline filters out obvious non-STEM. The bar is: if their role name contains "math", "science", "stem", "tech", "computer", "engineering", "robotics", "digital learning", or they coach/support/coordinate those subjects, they are STEM.
   - INCLUDE (these are all STEM even without the word "teacher"):
     * math, science, computer science, engineering, technology, robotics, maker, digital fabrication teachers
     * STEM coordinators, coaches, specialists, interventionists (e.g. "Math Interventionist", "Math Specialist", "Math Coach", "Literacy & Math Coach", "Math Program Assistant", "Science Program Assistant")
     * Digital Learning Leaders, tech integrators, technology integrators (they teach digital skills)
     * Department chairs/heads of math/science/STEM departments
     * Anyone whose role combines a STEM subject with another subject (e.g. "Digital Learning Leader / STEM Teacher", "Literacy & Math Specialist")
   - EXCLUDE:
     * Pure non-STEM: librarians (unless "library technology integrator"), counselors, athletic coaches, food service, custodians, secretaries, bus drivers
     * Political science, social science, library science, sports/exercise science (these SOUND like science but aren't)
     * General elementary teachers with no STEM specialization in their title
     * Administrators with no subject-teaching role (principals, vice principals, superintendents, HR)
     * Pure art/music teachers (but accept hybrids like "Art/STEM Teacher" or "Digital Art & Design Teacher")

2. hackerScore (1-5): affinity for Hack Club's project-based hacker ethos. Score based on what they TEACH, not seniority:
   - 5 = computer science, coding, software development, cybersecurity, web/app/game development, AP CS
   - 4 = engineering, robotics, maker spaces, digital fabrication, electronics, tech integration, IT, STEM (generic)
   - 3 = physics, applied science, CAD/drafting, woodshop, forensic science, astronomy
   - 2 = chemistry, biology, environmental/earth/general science, anatomy
   - 1 = math, statistics, or isStem=false

Respond with valid JSON matching exactly:
{ "results": [ { "index": <int>, "isStem": <bool>, "hackerScore": 1|2|3|4|5 } ] }

Include every teacher in results. No commentary, no markdown.`;

/**
 * batch-classify teachers' STEM status + hacker score in a single LLM call.
 * returns null if the call fails or response is malformed — caller should
 * fall back to keyword-based scoring.
 */
export async function judgeStemAndHacker(
  teachers: { firstName: string; lastName: string; role: string; department: string | null }[],
): Promise<StemAndHackerJudgment[] | null> {
  if (teachers.length === 0) return [];

  const user = teachers
    .map(
      (t, i) =>
        `[${i}] name="${t.firstName} ${t.lastName}" role="${t.role || "(none)"}" department="${t.department || "(none)"}"`,
    )
    .join("\n");

  try {
    const res = await askJson<BatchResponse<StemAndHackerJudgment>>(
      STEM_HACKER_SYSTEM,
      `Classify these ${teachers.length} teachers:\n\n${user}`,
    );

    if (!res?.results || !Array.isArray(res.results)) return null;

    // validate shape + clamp scores
    const valid: StemAndHackerJudgment[] = [];
    for (const r of res.results) {
      if (typeof r.index !== "number" || r.index < 0 || r.index >= teachers.length) continue;
      if (typeof r.isStem !== "boolean") continue;
      const score = Math.round(Number(r.hackerScore));
      if (!(score >= 1 && score <= 5)) continue;
      valid.push({
        index: r.index,
        isStem: r.isStem,
        hackerScore: score as HackerScore,
      });
    }

    // require one judgment per teacher — partial results would silently drop
    // teachers, worse than just falling back to keyword logic.
    if (valid.length < teachers.length) return null;

    return valid;
  } catch {
    return null;
  }
}

// ── linkedin candidate validation batch ──────────────────────────────────────

export interface LinkedinCandidate {
  teacherIndex: number;
  teacher: {
    firstName: string;
    lastName: string;
    schoolName: string | null;
    districtName: string | null;
    role: string;
  };
  candidate: {
    url: string;
    title: string;
  };
}

export interface LinkedinJudgment {
  index: number;
  isMatch: boolean;
}

const LINKEDIN_SYSTEM = `You decide whether a LinkedIn search result belongs to a specific K-12 teacher.

For each candidate, return isMatch=true ONLY when ALL of:
1. Name on the profile clearly refers to the same person (handle nicknames, hyphenated last names, diacritics; reject same-name different-person).
2. The profile shows a CURRENTLY ACTIVE K-12 educator role — reject "retired", "former", "previously", or non-teaching roles (sales, consulting, nonprofit CEO, university professor) even if the name matches.
3. Employer context in the title, if present, plausibly references the teacher's school or district — handle acronyms (e.g. "CVU" for "Champlain Valley Union High School"), abbreviations, and the district name as a valid match for any school in that district. If no employer appears in the title AND the title has a clear K-12 educator keyword (teacher, educator, interventionist, K-12), accept.

Respond with valid JSON matching exactly:
{ "results": [ { "index": <int>, "isMatch": <bool> } ] }

Include every candidate. No commentary, no markdown.`;

/**
 * batch-validate linkedin candidates. returns null on error (caller falls
 * back to accepting the keyword-passed candidates).
 */
export async function judgeLinkedinCandidates(
  candidates: LinkedinCandidate[],
): Promise<LinkedinJudgment[] | null> {
  if (candidates.length === 0) return [];

  const user = candidates
    .map(
      (c, i) =>
        `[${i}] teacher="${c.teacher.firstName} ${c.teacher.lastName}" school="${c.teacher.schoolName ?? "(unknown)"}" district="${c.teacher.districtName ?? "(unknown)"}" role="${c.teacher.role}" candidate_title="${c.candidate.title}" url="${c.candidate.url}"`,
    )
    .join("\n");

  try {
    const res = await askJson<BatchResponse<LinkedinJudgment>>(
      LINKEDIN_SYSTEM,
      `Validate ${candidates.length} linkedin candidates:\n\n${user}`,
    );

    if (!res?.results || !Array.isArray(res.results)) return null;

    const valid: LinkedinJudgment[] = [];
    for (const r of res.results) {
      if (typeof r.index !== "number" || r.index < 0 || r.index >= candidates.length) continue;
      if (typeof r.isMatch !== "boolean") continue;
      valid.push({ index: r.index, isMatch: r.isMatch });
    }

    if (valid.length < candidates.length) return null;

    return valid;
  } catch {
    return null;
  }
}

// ── helpers for integration callers ──

/**
 * quick summary of a teacher useful in judge input rows. kept here so the
 * format stays consistent across passes.
 */
export function teacherSummary(t: Teacher): string {
  return `${t.firstName} ${t.lastName} — ${t.role}${t.department ? ` (${t.department})` : ""}`;
}
