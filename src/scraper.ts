// ── phase 1: school website scraping via browser-use ──

import type { RawTeacherData } from "./types";
import { createClient, createSession, runTask, stopSession } from "./browser";
import { askJson } from "./ai";

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

// ── browser-use task prompts ──

function promptFindStaffDirectory(schoolUrl: string): string {
  return `Go to ${schoolUrl}.

Your goal is to find the staff directory, faculty page, or teacher listing on this school website.

Navigation strategy:
1. Check the main navigation bar for links labeled: "Staff", "Faculty", "Our Team", "Directory", "Teachers", "Staff Directory", "Faculty & Staff", "Meet Our Staff", "About Us" (which often has a sub-link to staff).
2. Hover over or click menu items to reveal sub-menus and dropdowns — staff pages are often nested under "About", "Our School", or "Community".
3. Check the footer for quick-links to a staff directory.
4. If the school site is part of a district website, look for a section specific to this school first.

Also look for department-specific pages for Science, Math, STEM, Technology, or Engineering departments — these sometimes have their own staff listings separate from the main directory.

Report back:
- The URL(s) of any staff/faculty directory pages you found.
- The URL(s) of any STEM department-specific pages.
- If you couldn't find a staff directory, say so clearly.`;
}

function promptExtractTeachers(): string {
  return `Navigate to the staff directory pages you found in the previous step. Extract ALL teachers whose subject, role, title, or department relates to STEM.

STEM subjects to look for: ${STEM_SUBJECTS}.

EXCLUDE anyone whose role matches these non-STEM subjects: ${EXCLUSIONS}.

For each STEM teacher, extract:
- full name (first and last name)
- email address (look for mailto: links, on-page text, or contact info sections)
- role / title / position (e.g. "AP Physics Teacher", "Math Department Chair")
- department (e.g. "Science", "Mathematics", "STEM")
- phone extension (if listed)

Important instructions:
- Handle pagination: if the directory spans multiple pages, click "Next", "Load More", or page number links to visit ALL pages.
- If teachers are organized by department, visit each relevant STEM department page.
- If the directory shows cards or tiles, click into individual teacher profiles if they exist — emails are sometimes only on the detail page.
- If teachers are listed in a table, scan every row.
- Include department chairs, coordinators, and lead teachers if they teach STEM subjects.
- When in doubt about whether someone teaches STEM, include them — we'll filter later.

Return the data as a JSON array of objects with these keys: name, email, role, department, phone.
Example: [{"name": "Jane Smith", "email": "jsmith@school.edu", "role": "AP Chemistry Teacher", "department": "Science", "phone": "x1234"}]`;
}

function promptGetSchoolInfo(): string {
  return `Find this school's official name and mailing address.

Where to look:
1. The page footer — most school websites display the address in the footer on every page.
2. A "Contact Us" or "Contact" page.
3. An "About" or "About Us" page.

Extract:
- The school's full official name (e.g. "Lincoln High School", not just "Lincoln")
- The complete mailing address: street, city, state, and zip code.

Return the data as JSON with keys: name, address.
Example: {"name": "Lincoln High School", "address": "1234 Main St, Springfield, IL 62701"}`;
}

// ── ai extraction helpers ──

const EXTRACTION_SYSTEM =
  "Extract structured data from the following browser agent output. Return valid JSON only.";

async function extractTeachers(rawOutput: string): Promise<RawTeacherData[]> {
  return askJson<RawTeacherData[]>(
    EXTRACTION_SYSTEM,
    `The following is the output from a browser agent that was asked to find STEM teachers on a school website. Extract an array of teacher objects from it.

Each object should have: name (string), email (string or null), role (string or null), department (string or null), phone (string or null).

Browser agent output:
${rawOutput}`,
  );
}

async function extractSchoolInfo(
  rawOutput: string,
): Promise<{ name: string | null; address: string | null }> {
  return askJson<{ name: string | null; address: string | null }>(
    EXTRACTION_SYSTEM,
    `The following is the output from a browser agent that was asked to find a school's name and address. Extract the school name and address from it.

Return JSON with keys: name (string or null), address (string or null).

Browser agent output:
${rawOutput}`,
  );
}

// ── main export ──

export async function scrapeSchool(
  schoolUrl: string,
  onStatus?: (msg: string) => void,
  onLiveUrl?: (url: string) => void,
): Promise<{
  teachers: RawTeacherData[];
  schoolAddress: string | null;
  schoolName: string | null;
  sessionId: string;
}> {
  const status = onStatus ?? (() => {});

  const client = createClient();
  const session = await createSession(client);
  const { id: sessionId, liveUrl } = session;

  if (liveUrl) onLiveUrl?.(liveUrl);

  try {
    // task 1 — discover the staff directory
    status("finding staff directory...");
    const directoryOutput = await runTask(
      client,
      sessionId,
      promptFindStaffDirectory(schoolUrl),
      onStatus,
    );

    // task 2 — extract stem teachers from the directory
    status("extracting STEM teachers...");
    const teachersOutput = await runTask(
      client,
      sessionId,
      promptExtractTeachers(),
      onStatus,
    );

    // task 3 — grab school name and address
    status("grabbing school address...");
    const infoOutput = await runTask(
      client,
      sessionId,
      promptGetSchoolInfo(),
      onStatus,
    );

    // parse the natural language outputs into structured data via ai
    status("structuring extracted data...");
    const [teachers, schoolInfo] = await Promise.all([
      extractTeachers(teachersOutput),
      extractSchoolInfo(infoOutput),
    ]);

    return {
      teachers,
      schoolAddress: schoolInfo.address,
      schoolName: schoolInfo.name,
      sessionId,
    };
  } finally {
    await stopSession(client, sessionId);
  }
}
