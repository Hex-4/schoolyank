// ── phase 1: school website scraping via browser-use ──

import { z } from "zod";
import { debug } from "./debug";
import type { RawTeacherData, RawSiteInfo } from "./types";
import {
  createClient,
  createSession,
  runTask,
  runTaskStructured,
  stopSession,
} from "./browser";

// comprehensive stem subject keywords fed into the browser-use prompts
const STEM_SUBJECTS = [
  "algebra", "geometry", "calculus", "precalculus", "pre-calculus",
  "trigonometry", "statistics", "probability", "ap calculus",
  "ap statistics", "integrated math", "math", "mathematics",
  "finite math", "discrete math", "multivariable calculus",
  "linear algebra", "math analysis",
  "physics", "chemistry", "biology", "ap physics", "ap chemistry",
  "ap biology", "environmental science", "apes", "earth science",
  "geology", "anatomy", "physiology", "forensic science",
  "marine biology", "astronomy", "ap environmental science",
  "physical science", "life science", "general science", "science",
  "computer science", "ap computer science", "cs", "engineering",
  "stem", "technology", "robotics", "coding", "programming",
  "information technology", "it", "digital electronics",
  "principles of engineering", "maker space",
].join(", ");

// subjects that sound like stem but aren't — the agent needs to skip these
const EXCLUSIONS = [
  "political science", "social science", "library science",
  "exercise science", "sports science", "science of cooking",
].join(", ");

// ── zod schemas for structured agent output ────────────────────────────────

const SiteInfoSchema = z.object({
  siteType: z.enum(["district", "school"]),
  name: z.string().nullable(),
  address: z.string().nullable(),
  schools: z.array(z.string()).default([]),
  // optional: umbrella → members map for shared-campus groupings. lets the
  // matcher fall back to the federal umbrella record when a specific member
  // school isn't registered separately in NCES.
  schoolGroups: z
    .array(
      z.object({
        umbrella: z.string(),
        members: z.array(z.string()),
      }),
    )
    .default([]),
});

const TeacherSchema = z.object({
  name: z.string(),
  email: z.string().nullable(),
  role: z.string().nullable(),
  department: z.string().nullable(),
  phone: z.string().nullable(),
  assignedSchool: z.string().nullable(),
});

const TeachersSchema = z.object({
  teachers: z.array(TeacherSchema),
});

// follow-up task when classify returns a plural "X Schools" we can't split
// from the top-level page alone. agent drills into the umbrella's landing page
// and enumerates its member schools.
const UmbrellaMembersSchema = z.object({
  isUmbrella: z.boolean(),
  members: z.array(z.string()).default([]),
});

// ── browser-use task prompts ──

function promptClassifySite(schoolUrl: string): string {
  return `Go to ${schoolUrl}.

Your task: determine whether this URL is a SINGLE SCHOOL site or a SCHOOL DISTRICT site covering multiple schools, and extract identifying information about it.

Before classifying: after the page loads, check the final URL in the address bar. If it differs from ${schoolUrl} (a 301/302 cross-domain redirect — e.g. bexleyschools.org → bexley.us — happens when a district has rebranded), treat the FINAL domain as the authoritative source for all subsequent navigation and email-domain inference. If the page loaded at ${schoolUrl} without redirecting, ignore this check and proceed normally — do NOT fabricate a redirect.

━━ CLASSIFICATION ━━

DISTRICT signals (any one is strong evidence):
- Name contains "District", "Unified School District", "Public Schools", "Consolidated Schools", "School Corporation", "ISD", "USD", "Supervisory Union", "Education Service District", "Regional School Unit"
- A "Schools" menu, dropdown, or footer section lists 2+ schools by name
- The site covers multiple grade bands (e.g. elementary AND middle AND high school)
- Multiple principals listed, multiple street addresses, multiple phone numbers

SINGLE SCHOOL signals (all should be true):
- Site is branded around exactly one school (one logo, one mascot, one "About our school" voice)
- One principal, one address, one main phone number
- Staff directory is that school only

━━ NAME EXTRACTION ━━

Use the OFFICIAL, FULL name as it appears in the footer, "Contact Us" page, or "About" page. Do NOT use shorthand from the navigation bar.
- If the nav says "CVU" but the footer says "Champlain Valley Union High School" → return "Champlain Valley Union High School"
- District names: use the full legal name including any number suffix (e.g. "Champlain Valley Unified Union School District #56")

━━ ADDRESS ━━

Full MAILING address: street, city, state, zip. Usually in the footer.
- District site → district OFFICE address (central office / administration building)
- Single school → that school's street address

━━ LISTING SCHOOLS (DISTRICT ONLY) ━━

List EVERY individual school. Sources: the "Schools" or "Our Schools" menu, the staff directory's school filter, footer quick-links.

CRITICAL rules for school names:
- OFFICIAL FULL NAME for each, not abbreviations
- If a campus hosts multiple schools under an umbrella (e.g. "Williston Schools" = "Williston Central School" (5-8) + "Allen Brook School" (K-4)), list them SEPARATELY. Never return a grouped/umbrella name. If in doubt about whether a label is an umbrella, click into it to check.
- Each school is one entry even if they share a building, phone, or website
- Do NOT include grade-level labels as schools ("Elementary", "Middle School", "High School" are not names by themselves)

━━ SHARED-CAMPUS GROUPINGS ━━

If two or more schools share one campus/building under an UMBRELLA LABEL (e.g. "Williston Schools" on the nav = "Williston Central School" + "Allen Brook School" physically), you must separate them:

1. The "schools" array contains ONLY the specific member schools (e.g. "Williston Central School", "Allen Brook School"). DO NOT include the umbrella label here.
2. The "schoolGroups" array records the umbrella→members mapping: { umbrella: "Williston Schools", members: ["Williston Central School", "Allen Brook School"] }

Critical: if you list the umbrella in "schools", downstream teachers will be assigned to the umbrella instead of their specific school, collapsing our data. Umbrella names belong ONLY in schoolGroups[].umbrella, never in schools[].

If no shared-campus groupings exist, leave schoolGroups empty.

━━ OUTPUT ━━

Return your answer as structured JSON matching the required schema:
- siteType: "district" or "school"
- name: the official full name (null only if you genuinely cannot find one)
- address: full mailing address (null only if unavailable)
- schools: array of school names — required and non-empty when siteType is "district"; empty array when siteType is "school"
- schoolGroups: array of {umbrella, members} for shared campuses; empty array if none

Do NOT save output to a file. Do NOT use save_output_json. Return the JSON data as your final response via the structured output format.`;
}

function promptUmbrellaMembers(
  umbrellaLabel: string,
  districtName: string | null,
): string {
  return `The district website lists "${umbrellaLabel}" as a school. The plural "Schools" label strongly suggests this is an UMBRELLA covering multiple real schools that share a campus (e.g. "Williston Schools" covers both "Williston Central School" (5-8) and "Allen Brook School" (K-4)).

Your task: navigate to the "${umbrellaLabel}" page${districtName ? ` on the ${districtName} website` : ""} and determine whether it is a single school or an umbrella for multiple schools, and if an umbrella, list the individual member schools.

━━ INVESTIGATION STEPS ━━
1. Click into "${umbrellaLabel}" from the Schools / Our Schools menu, or navigate to its landing page.
2. Look for sub-pages, tabs, or sections naming individual member schools (e.g. "Williston Central School (5-8)" and "Allen Brook School (K-4)").
3. Check staff directories under this umbrella — distinct school filters reveal member schools.
4. Check the district's main Schools menu — members are often linked there too, as nested items.

━━ OUTPUT ━━
- isUmbrella: true if "${umbrellaLabel}" covers 2+ distinct member schools; false if it is a single school just named in the plural.
- members: the OFFICIAL FULL NAMES of each member school (e.g. "Williston Central School", "Allen Brook School"). Empty array if isUmbrella is false.

Do NOT save output to a file. Return structured JSON.`;
}

function promptFindStaffDirectory(siteType: "district" | "school"): string {
  const commonLabels = `"Staff", "Faculty", "Our Team", "Our Staff", "Directory", "Teachers", "Staff Directory", "Faculty & Staff", "Meet Our Staff", "Employee Directory", "Who's Who", "Our People"`;

  if (siteType === "district") {
    return `Find every staff directory page on this district website. A district typically has MULTIPLE directories — one per school, plus possibly a district-wide one.

━━ SEARCH STRATEGY ━━

1. Top navigation: look for ${commonLabels}. District-wide directories often live here.
2. The "Schools" menu/section: for EACH school, visit its landing page and find its OWN staff directory.
3. Look for "Select a School" or school-picker widgets — these filter a district-wide table by school.
4. Footer quick-links — directories are often duplicated there.
5. Department-specific pages (Math, Science, STEM) sometimes list cross-school teachers.
6. **Subdomain directories**: many districts host the canonical staff list on a SEPARATE subdomain like \`directory.<district>.org\`, \`staff.<district>.org\`, or \`people.<district>.org\`. If the main site has a top-nav "Directory" link that points to a different hostname (even same root domain), that IS the staff directory — follow it. Don't get stuck on the main www page when a dedicated subdomain exists.

━━ WHAT TO REPORT ━━

For every staff page you found, report:
- The URL
- Which school it covers (full official name), OR "district-wide" for cross-school pages
- Structure notes (paginated, filterable by department/school, cards vs table)

If you find nothing, say so and list the district's schools by name.

Do NOT save your output to a file. This is a navigation-reporting step — just describe what you found in plain text.`;
  }

  return `Find the staff directory, faculty page, or teacher listing on this school website.

━━ SEARCH STRATEGY ━━

1. Top nav: ${commonLabels}
2. Hover/expand every top-level menu — staff pages are commonly nested under "About", "Our School", "Community", or "Parents".
3. Footer quick-links.
4. Department-specific pages for Science, Math, STEM, Computer Science, Engineering.

━━ WHAT TO REPORT ━━

- URL(s) of every staff/faculty directory page
- URL(s) of any STEM department-specific teacher listings
- Structure notes (paginated? filterable? tabs?)
- If no directory, say so clearly.

Do NOT save output to a file — describe what you found as your response.`;
}

function promptExtractTeachers(
  siteType: "district" | "school",
  knownSchools: string[],
): string {
  const districtGuidance = siteType === "district"
    ? `
━━ DISTRICT MODE — PER-TEACHER SCHOOL IS MANDATORY ━━

For EVERY teacher you extract, assignedSchool must be set to the teacher's specific school.

Known schools in this district:
${knownSchools.map((s) => `  - ${s}`).join("\n")}

How to determine the assigned school:
1. If the directory is organized by school (headers, tabs, filters), that's the school.
2. If there's a "Building"/"Location"/"School" column or field, use it.
3. If a profile page lists "School: X", use X.
4. Fallback: grade-level or role hints.

Naming rules:
- assignedSchool MUST match one of the known schools EXACTLY (copy/paste the name)
- If the site shows an abbreviation (e.g. "CVU") and the known list has the full name, return the FULL name
- If the site shows an umbrella (e.g. "Williston Schools") and the known list has separate entries ("Williston Central School" + "Allen Brook School"), pick the specific school using grade range / role / section. Never return the umbrella.
- Never put a district name, department name, or grade level into assignedSchool
`
    : `
━━ SINGLE SCHOOL MODE ━━

All teachers belong to the one school. Set assignedSchool to null for every teacher.
`;

  return `Visit the staff directory pages you found. Extract EVERY teacher whose subject, role, title, or department relates to STEM.

━━ INCLUDE ━━

STEM subjects: ${STEM_SUBJECTS}

Also include even without "teacher" in the title:
- Department chairs/heads/leads in STEM departments
- STEM coordinators, coaches, specialists, interventionists
- Digital learning leaders, tech integrators (if they teach students)
- Long-term substitutes for STEM subjects
- Applied/vocational STEM (robotics, design technology, CAD, maker labs)

━━ EXCLUDE ━━

Not STEM: ${EXCLUSIONS}

Also exclude:
- Support staff who don't teach (custodians, secretaries, bus drivers, food services)
- Administrators with no subject teaching role (principals, vice principals, counselors)
- General K-5 classroom teachers who don't have a STEM specialization
- Librarians (unless explicitly a "library technology integrator")
${districtGuidance}
━━ FIELD RULES ━━

- name: full name (first + last). Strip titles (Dr., Mr., Mrs., Ms.) and postnominals (Jr., PhD, MEd).
- email: exact email address — mailto: links, on-page text, contact sections. Normalize obfuscated forms ("a [at] b [dot] edu" → "a@b.edu"). If no email is visible anywhere, set null — never guess. **Returning teachers with email=null is always better than returning an empty teacher array** — downstream validation infers emails from the district's naming pattern when ≥3 real emails are seen, but it needs SOME teachers to work with. Never skip extracting a teacher just because their email isn't visible.
- role: their job title as written ("AP Physics Teacher", "Math Department Chair"). What they DO.
- department: SUBJECT only — "Science", "Mathematics", "STEM", "Computer Science", "Engineering", "Technology". NEVER a school name. NEVER a grade level. Infer from role if the site doesn't name a department.
- phone: extension if listed next to the teacher. Don't invent.
- assignedSchool: ${siteType === "district" ? "REQUIRED (per district-mode rules above)" : "null"}

━━ CRITICAL ANTI-PATTERNS ━━

❌ Never put a school name in the department field
❌ Never put a grade level in the department field
❌ Never put a district name in assignedSchool
❌ Never combine two real schools into one assignedSchool
❌ Never fabricate an email

━━ IF THE PAGE LOOKS EMPTY — DON'T GIVE UP ━━

Cheap HTTP fetches only return the raw HTML the server ships. Modern districts (Apptegy, React/Vue SPAs, etc.) ship a near-empty shell — something like \`<div id="app"></div>\` plus a few \`<script>\` tags — and the actual directory is rendered by JavaScript AFTER the page loads. If your first fetch returns:

- a body that's mostly empty, or
- an app shell with \`<div id="app">\`, \`<div id="root">\`, or similar single-div mount points, or
- script tags pointing to \`/js/app.*.js\`, \`/static/js/main.*.js\`, chunk bundles, etc., or
- a \`<noscript>\` tag saying "please enable JavaScript"

…**do NOT conclude the page has no content.** Switch to the browser/navigate tool and wait for JS to hydrate the DOM before reading. The directory data is there, just not in the initial HTML.

One extra try is cheap and often succeeds where the fetch tool fails. Returning 0 teachers because the raw HTML looked empty is almost always wrong — the correct response is "retry this URL in the browser".

━━ PLATFORM SHORTCUTS (save yourself iteration rounds) ━━

If the directory page HTML contains \`class="fsConstituentItem"\`, it's a Finalsite directory (common for K-12 districts). Key facts:
- the listing shows generic titles like "Teacher" without subjects — DO NOT rely on the listing view
- use \`?const_search_keyword=<term>\` to reveal subject-specific titles (this searches both name AND title/profile fields)
- sweep with ALL of these terms (do not skip any — each surfaces a different cohort): "math", "mathematics", "algebra", "geometry", "calculus", "statistics", "science", "biology", "chemistry", "physics", "environmental", "earth", "anatomy", "astronomy", "forensic", "computer", "computer science", "CS", "coding", "programming", "software", "tech ed", "technology", "IT", "digital", "stem", "engineering", "pre-engineering", "design technology", "maker", "robotics", "CAD", "drafting", "woodworking" — merge results by constituent ID. Missing ANY of these sweeps causes teachers to be silently dropped.
- emails are JS-obfuscated: \`FS.util.insertEmail("elId", "<reversed domain>", "<reversed username>", true)\` — REVERSE BOTH to decode. This is MANDATORY — do not leave emails blank on a Finalsite directory. Read the raw HTML (or the profile's detail page) and find the FS.util.insertEmail call for each teacher; the 2nd arg is the reversed domain, the 3rd is the reversed username. Reconstruct as \`<reversed(username)>@<reversed(domain)>\`. Example: \`FS.util.insertEmail("x","gro.elpmaxe","enaj.eod")\` → \`jane.doe@example.org\`. If you find teachers on a Finalsite site without also finding their FS.util.insertEmail calls, you're extracting from the wrong page — inspect the HTML source, not the rendered text.
- paginate by CLICKING the "next page" anchor in the widget (some sites, e.g. newtrier.k12.il.us, ignore the \`?const_page=N\` query param on direct load — they only advance via the JS click handler). the anchor will have \`disabled="disabled"\` when there are no more pages. total count is in \`.fsPaginationLabel\`
- do NOT paginate all pages if the directory has 500+ entries — targeted keyword searches are 10× faster than scanning 29 pages of generic titles

━━ COVERAGE ━━

- Handle pagination: click "Next"/"Load More"/page numbers to visit ALL pages.
- If organized by school or department, visit EVERY relevant section.
- Click into individual profiles when emails or titles aren't on the listing page.
- When in doubt about STEM, include — we'll filter later.
- For districts with many per-school subsites (10+), prioritize BREADTH: hit 2-3 keyword sweeps (e.g. \`math\`, \`science\`, \`stem\`) across ALL schools before exhausting subject-by-subject sweeps on any one school. A district that ships 5 teachers per school × 30 schools beats 40 teachers from one school + 0 from the other 29. Do NOT stop after 3-5 schools and report "most had generic titles" — that's a coverage failure, not a finding.

━━ OUTPUT ━━

Return the data using structured output — an object with a "teachers" array where each entry matches the required fields above. Do NOT save to a file. Do NOT call save_output_json. Do NOT summarize in prose. Return the literal structured data.`;
}

// ── main export ──

export interface ScraperOutput {
  teachers: RawTeacherData[];
  siteInfo: RawSiteInfo;
  sessionId: string;
}

// browser-use model. gpt-5.4-mini is the cheapest tier ($0.90/1M in, $5.40/1M
// out) and handles classify + navigation well. the extract task is where
// recall matters most — missed teachers = silent data loss and per-run
// variance — so we bump extraction to claude-sonnet-4.6 ($3.60/$18.00) for
// stronger coverage on long keyword sweeps.
const SCRAPER_MODEL_DEFAULT = "gpt-5.4-mini" as const;
const SCRAPER_MODEL_EXTRACT = "claude-sonnet-4.6" as const;

export interface ScrapeSchoolOptions {
  onStatus?: (msg: string) => void;
  onMilestone?: (msg: string, level?: "info" | "warn") => void;
  onLiveUrl?: (url: string) => void;
  /**
   * fires at each sub-task boundary inside the scraper. lets the orchestrator
   * advance its phase indicator deterministically without substring-matching
   * browser-agent reasoning (which can spuriously contain phrases like
   * "extracting STEM teachers" mid-task 2 and cause premature transitions).
   */
  onScraperPhase?: (phase: "classify" | "directory" | "extract") => void;
}

export async function scrapeSchool(
  schoolUrl: string,
  options: ScrapeSchoolOptions = {},
): Promise<ScraperOutput> {
  const status = options.onStatus ?? (() => {});
  const milestone = options.onMilestone ?? (() => {});
  const onLiveUrl = options.onLiveUrl;

  // ── Hasura bypass for Apptegy districts ──
  // Apptegy-CMS districts (e.g. Academy District 20) ship a Vue SPA gated by
  // reCAPTCHA, which blocks headless browsers. Their underlying Hasura GraphQL
  // endpoint is unauthenticated and exposes names + emails + schools + subject
  // teams. We auto-discover the endpoint (pattern + HTML-sniff) and hit it
  // directly, skipping browser-use entirely. Pure speedup — any failure in
  // detection falls through to the normal pipeline.
  const { tryHasuraBypass } = await import("./hasuraBypass");
  options.onScraperPhase?.("classify");
  status("checking for Hasura fast-path...");
  const bypassResult = await tryHasuraBypass(schoolUrl, (msg) => milestone(msg));
  if (bypassResult && bypassResult.teachers.length > 0) {
    options.onScraperPhase?.("extract");
    milestone(
      `extracted ${bypassResult.teachers.length} teacher candidates via Hasura GraphQL (bypassed browser agent)`,
    );
    return bypassResult;
  }

  debug("SCRAPER", `scrapeSchool → ${schoolUrl}`);

  const client = createClient();
  const session = await createSession(client);
  const { id: sessionId, liveUrl } = session;
  debug("SCRAPER", `created session · id=${sessionId} liveUrl=${liveUrl || "(none)"}`);

  if (liveUrl) onLiveUrl?.(liveUrl);

  try {
    // task 1 — classify the site (structured output)
    options.onScraperPhase?.("classify");
    status("classifying site (district vs single school)...");
    let rawSite: z.output<typeof SiteInfoSchema>;
    try {
      rawSite = await runTaskStructured(
        client,
        sessionId,
        promptClassifySite(schoolUrl),
        SiteInfoSchema,
        { onMessage: options.onStatus, model: SCRAPER_MODEL_DEFAULT },
      );
    } catch (classifyErr) {
      debug("SCRAPER", `classify failed with ${SCRAPER_MODEL_DEFAULT}, retrying with ${SCRAPER_MODEL_EXTRACT}`, classifyErr);
      status(`classify failed with ${SCRAPER_MODEL_DEFAULT}, retrying with ${SCRAPER_MODEL_EXTRACT}...`);
      rawSite = await runTaskStructured(
        client,
        sessionId,
        promptClassifySite(schoolUrl),
        SiteInfoSchema,
        { onMessage: options.onStatus, model: SCRAPER_MODEL_EXTRACT },
      );
    }
    debug("SCRAPER", `classify result`, rawSite);
    // defensive: strip umbrella labels from the schools list so the extractor
    // doesn't treat them as valid per-teacher assignment targets. two sources
    // of truth:
    //   1. schoolGroups[].umbrella the model reported
    //   2. auto-detection: schools ending in plural "Schools" when another
    //      school shares their first word — real schools are singular "School";
    //      plural almost always means umbrella (e.g. "Williston Schools" paired
    //      with "Williston Central School")
    const reportedUmbrellas = new Set(
      (rawSite.schoolGroups ?? []).map((g) => g.umbrella.trim().toLowerCase()),
    );
    const allSchools = rawSite.schools ?? [];
    const autoDetectedGroups: Array<{ umbrella: string; members: string[] }> = [];

    for (const s of allSchools) {
      const norm = s.trim().toLowerCase();
      if (reportedUmbrellas.has(norm)) continue;
      // must end in plural "Schools" (not "School")
      if (!/\bschools\s*$/i.test(s.trim())) continue;

      const firstWord = s.trim().split(/\s+/)[0]?.toLowerCase();
      if (!firstWord || firstWord.length < 3) continue;

      const members = allSchools.filter((other) => {
        if (other === s) return false;
        // other must start with the same first word AND be singular "School"
        const otherFirst = other.trim().split(/\s+/)[0]?.toLowerCase();
        return otherFirst === firstWord && /\bschool\b(?!s)/i.test(other);
      });

      if (members.length >= 1) {
        debug("SCRAPER", `auto-detected umbrella "${s}" → members=${JSON.stringify(members)}`);
        autoDetectedGroups.push({ umbrella: s, members });
        reportedUmbrellas.add(norm);
      }
    }

    const dedupedSchools = allSchools.filter(
      (s) => !reportedUmbrellas.has(s.trim().toLowerCase()),
    );

    // follow-up probe: any plural "X Schools" label still in dedupedSchools
    // that isn't covered by reportedUmbrellas is a candidate umbrella we
    // couldn't split via the sibling-first-word heuristic (because its members
    // aren't in the top-level school list yet). ask the agent to drill in and
    // enumerate members. cheap second pass, protects the "perfect data" goal.
    const probedGroups: Array<{ umbrella: string; members: string[] }> = [];
    let finalSchools = dedupedSchools;

    if (rawSite.siteType === "district") {
      const candidates = dedupedSchools.filter((s) =>
        /\bschools\s*$/i.test(s.trim()),
      );
      for (const candidate of candidates) {
        status(`checking if "${candidate}" is an umbrella for multiple schools...`);
        try {
          const probe = await runTaskStructured(
            client,
            sessionId,
            promptUmbrellaMembers(candidate, rawSite.name),
            UmbrellaMembersSchema,
            { onMessage: options.onStatus, model: SCRAPER_MODEL_DEFAULT },
          );
          debug("SCRAPER", `umbrella probe "${candidate}"`, probe);
          if (probe.isUmbrella && probe.members.length >= 2) {
            probedGroups.push({ umbrella: candidate, members: probe.members });
            milestone(
              `split "${candidate}" into ${probe.members.length} member schools (${probe.members.join(", ")})`,
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          status(`umbrella probe for "${candidate}" failed: ${msg}`);
        }
      }

      if (probedGroups.length > 0) {
        const umbrellaNames = new Set(
          probedGroups.map((g) => g.umbrella.trim().toLowerCase()),
        );
        const membersToAdd = probedGroups.flatMap((g) => g.members);
        finalSchools = [
          ...dedupedSchools.filter(
            (s) => !umbrellaNames.has(s.trim().toLowerCase()),
          ),
          ...membersToAdd,
        ];
        // dedupe while preserving order
        const seen = new Set<string>();
        finalSchools = finalSchools.filter((s) => {
          const k = s.trim().toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }
    }

    const siteInfo: RawSiteInfo = {
      siteType: rawSite.siteType,
      name: rawSite.name,
      address: rawSite.address,
      schools: finalSchools,
      schoolGroups: [
        ...(rawSite.schoolGroups ?? []),
        ...autoDetectedGroups,
        ...probedGroups,
      ],
    };

    // milestone fires RIGHT NOW, not after all 3 tasks finish. previously the
    // orchestrator emitted this after scrapeSchool returned, so "detected
    // district" only showed up alongside the final "extracted teachers" at
    // the very end of phase 3. firing inline means the user sees it the
    // moment classification completes.
    if (siteInfo.siteType === "district") {
      const n = siteInfo.schools?.length ?? 0;
      milestone(
        `detected district: ${siteInfo.name ?? "(unknown)"} (${n} school${n === 1 ? "" : "s"})`,
      );
    } else {
      milestone(
        `detected single school: ${siteInfo.name ?? "(unknown)"}`,
      );
    }

    // task 2 — discover staff directory/directories (free-form text is fine here;
    // used only as navigation context for the agent on its next task)
    options.onScraperPhase?.("directory");
    status("finding staff directory...");
    try {
      await runTask(client, sessionId, promptFindStaffDirectory(siteInfo.siteType), {
        onMessage: options.onStatus,
        model: SCRAPER_MODEL_DEFAULT,
      });
    } catch (dirErr) {
      debug("SCRAPER", `directory failed with ${SCRAPER_MODEL_DEFAULT}, retrying with ${SCRAPER_MODEL_EXTRACT}`, dirErr);
      status(`directory failed with ${SCRAPER_MODEL_DEFAULT}, retrying with ${SCRAPER_MODEL_EXTRACT}...`);
      await runTask(client, sessionId, promptFindStaffDirectory(siteInfo.siteType), {
        onMessage: options.onStatus,
        model: SCRAPER_MODEL_EXTRACT,
      });
    }

    // task 3 — extract stem teachers (structured output)
    options.onScraperPhase?.("extract");
    status("extracting STEM teachers...");
    const extraction = await runTaskStructured(
      client,
      sessionId,
      promptExtractTeachers(siteInfo.siteType, siteInfo.schools ?? []),
      TeachersSchema,
      { onMessage: options.onStatus, model: SCRAPER_MODEL_EXTRACT },
    );
    debug("SCRAPER", `extract raw result · ${extraction.teachers.length} teachers`, extraction);

    // normalize to our RawTeacherData shape (strip nulls where our type expects undefined)
    const teachers: RawTeacherData[] = extraction.teachers.map((t) => ({
      name: t.name,
      ...(t.email != null && { email: t.email }),
      ...(t.role != null && { role: t.role }),
      ...(t.department != null && { department: t.department }),
      ...(t.phone != null && { phone: t.phone }),
      ...(t.assignedSchool != null && { assignedSchool: t.assignedSchool }),
    }));

    milestone(
      `extracted ${teachers.length} teacher candidate${teachers.length === 1 ? "" : "s"} from the site`,
    );

    return { teachers, siteInfo, sessionId };
  } finally {
    await stopSession(client, sessionId);
  }
}
