// ── optional linkedin enrichment for teacher data ──

import type { Teacher, ConfidenceScore } from "./types";
import { createClient, createSession, runTask, stopSession } from "./browser";
import { askJson } from "./ai";
import { sleep } from "./utils";

const MAX_LOOKUPS_PER_SESSION = 50;
const DELAY_BETWEEN_SEARCHES_MS = 2000;

interface LinkedinResult {
  found: boolean;
  title?: string;
  profileUrl?: string;
}

/** sort teachers so those missing emails or with low confidence come first */
function prioritize(teachers: Teacher[]): Teacher[] {
  return [...teachers].sort((a, b) => {
    const scoreA = (a.email ? 0 : 2) + (a.confidence <= 2 ? 1 : 0);
    const scoreB = (b.email ? 0 : 2) + (b.confidence <= 2 ? 1 : 0);
    return scoreB - scoreA;
  });
}

function buildSearchPrompt(teacher: Teacher, schoolName: string): string {
  return [
    `Go to https://www.linkedin.com/search/results/people/`,
    `Search for "${teacher.firstName} ${teacher.lastName}" "${schoolName}"`,
    `Look through the search results for a profile that matches this person.`,
    `A match means the person's current position lists "${schoolName}" (or a very close variant) as their employer.`,
    ``,
    `If you find a matching profile:`,
    `  - Extract their full job title from their current position`,
    `  - Copy their LinkedIn profile URL`,
    `  - Return JSON: { "found": true, "title": "<job title>", "profileUrl": "<url>" }`,
    ``,
    `If no matching profile is found, return JSON: { "found": false }`,
    ``,
    `Return ONLY the JSON object, nothing else.`,
  ].join("\n");
}

/** bump confidence by 1, capped at 5 */
function bumpConfidence(current: ConfidenceScore): ConfidenceScore {
  return Math.min(current + 1, 5) as ConfidenceScore;
}

/**
 * enrich teacher records with linkedin data (profile url, better titles).
 * uses a browser-use session with profile auth to search linkedin.
 * best-effort — individual lookup failures won't stop the batch.
 */
export async function enrichWithLinkedin(
  teachers: Teacher[],
  schoolName: string,
  profileId: string,
  onStatus?: (msg: string) => void,
): Promise<Teacher[]> {
  const log = onStatus ?? (() => {});
  const client = createClient();
  const session = await createSession(client, { profileId });

  log(`linkedin session started: ${session.id}`);

  // index by "first last" so we can update the original array
  const teacherMap = new Map(
    teachers.map((t) => [`${t.firstName} ${t.lastName}`, t]),
  );

  const ordered = prioritize(teachers);
  const lookupBatch = ordered.slice(0, MAX_LOOKUPS_PER_SESSION);

  for (let i = 0; i < lookupBatch.length; i++) {
    const teacher = lookupBatch[i]!;
    const label = `${teacher.firstName} ${teacher.lastName}`;

    if (i > 0) await sleep(DELAY_BETWEEN_SEARCHES_MS);

    log(`[${i + 1}/${lookupBatch.length}] searching linkedin for ${label}`);

    try {
      const raw = await runTask(
        client,
        session.id,
        buildSearchPrompt(teacher, schoolName),
      );

      const result = await askJson<LinkedinResult>(
        "Extract the linkedin lookup result from the browser agent's output.",
        raw,
      );

      if (!result.found) {
        log(`  ↳ no match for ${label}`);
        continue;
      }

      // update the original teacher object in-place
      const original = teacherMap.get(label);
      if (!original) continue;

      if (result.profileUrl) {
        original.linkedinUrl = result.profileUrl;
      }

      // use linkedin title if it's more specific than what we have
      if (result.title && result.title.length > original.role.length) {
        original.role = result.title;
      }

      if (!original.sources.includes("linkedin")) {
        original.sources.push("linkedin");
      }

      original.confidence = bumpConfidence(original.confidence);

      log(`  ↳ found: ${result.title ?? "no title"} — ${result.profileUrl}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ↳ failed for ${label}: ${msg}`);
    }
  }

  await stopSession(client, session.id);
  log("linkedin session stopped");

  return teachers;
}
