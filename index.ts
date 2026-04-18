#!/usr/bin/env bun

// ── schoolyank: extract STEM teacher data from any school website ──

import * as p from "@clack/prompts";
import color from "picocolors";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { run, PHASE_LABELS, type PhaseId } from "./src/orchestrator";
import { slugify } from "./src/utils";
import type { ScrapeConfig, ScrapeResult, Teacher } from "./src/types";

const ENV_FILE = resolve(".env");
const EXA_SIGNUP_URL = "https://dashboard.exa.ai/";

// ── theme ────────────────────────────────────────────────────────────────────
// coherent palette used across the whole cli. cyan is the brand color; magenta
// is reserved for numbers/counts so the eye lands on them first; dim is used
// for all secondary info.
const t = {
	brand: color.cyan,
	accent: color.magenta,
	ok: color.green,
	warn: color.yellow,
	bad: color.red,
	muted: color.dim,
	bold: color.bold,
};

const BRAND_TAG = t.bold(t.brand("◆ schoolyank"));
const TAGLINE = t.muted("stem teacher data extractor");

// ── formatting helpers ───────────────────────────────────────────────────────

function confidenceStr(n: number): string {
	const rounded = Math.round(n);
	const text = `${n.toFixed(rounded === n ? 0 : 1)}/5`;
	if (rounded >= 5) return t.bold(t.ok(text));
	if (rounded >= 4) return t.ok(text);
	if (rounded >= 3) return t.warn(text);
	return t.bad(text);
}

function bar(ratio: number, width = 18): string {
	const clamped = Math.max(0, Math.min(1, ratio));
	const filled = Math.round(clamped * width);
	return t.brand("█".repeat(filled)) + t.muted("░".repeat(width - filled));
}

function countOf(count: number, total: number): string {
	const pct = total === 0 ? 0 : Math.round((count / total) * 100);
	return `${t.accent(String(count))}${t.muted(`/${total}`)}  ${t.muted(`(${pct}%)`)}`;
}

function padRight(s: string, w: number): string {
	const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
	const pad = Math.max(0, w - plain.length);
	return s + " ".repeat(pad);
}

// ── result rendering ─────────────────────────────────────────────────────────

function renderHeadline(result: ScrapeResult, duration: string): string {
	const { district, schools, teachers } = result;
	const name = district?.name ?? schools[0]?.name ?? "(unknown)";
	const addr = district?.officeAddress ?? schools[0]?.address ?? null;

	const lines: string[] = [];
	lines.push(t.bold(name));

	const stats: string[] = [
		`${t.accent(String(teachers.length))} ${t.muted("stem teachers")}`,
	];
	if (district) {
		stats.push(`${t.accent(String(schools.length))} ${t.muted("schools")}`);
	}
	stats.push(`${t.muted(`${duration}s`)}`);
	lines.push(stats.join(t.muted("  ·  ")));

	if (addr) {
		lines.push(
			t.muted(
				`${addr.street}, ${addr.city}, ${addr.state} ${addr.zip}  (${addr.source})`,
			),
		);
	}
	return lines.join("\n");
}

function renderSchoolBreakdown(teachers: Teacher[]): string | null {
	const counts = new Map<string, number>();
	for (const t of teachers) {
		const name = t.schoolName?.trim() || "(unassigned)";
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	if (counts.size <= 1) return null;

	const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
	const max = Math.max(...entries.map(([, n]) => n));
	const nameWidth = Math.min(40, Math.max(...entries.map(([n]) => n.length)));

	const lines = [t.bold("teachers by school")];
	for (const [name, count] of entries) {
		lines.push(
			`  ${padRight(name, nameWidth)}  ${bar(count / max, 14)}  ${t.accent(String(count))}`,
		);
	}
	return lines.join("\n");
}

function renderQualityBlock(teachers: Teacher[]): string {
	const total = teachers.length;
	const withEmail = teachers.filter((x) => !!x.email).length;
	const withLinkedin = teachers.filter((x) => !!x.linkedinUrl).length;
	const inferred = teachers.filter((x) =>
		x.sources.includes("inferred"),
	).length;
	const avgConfidence =
		total === 0
			? 0
			: teachers.reduce((sum, x) => sum + x.confidence, 0) / total;

	const line = (label: string, filled: number, suffix: string): string =>
		`  ${padRight(label, 18)}  ${bar(total ? filled / total : 0, 14)}  ${suffix}`;

	const lines = [t.bold("data quality")];
	lines.push(line("with email", withEmail, countOf(withEmail, total)));
	if (inferred > 0) {
		lines.push(
			`  ${padRight(t.muted("  └ inferred"), 18)}  ${padRight("", 14)}  ${t.muted(String(inferred))}`,
		);
	}
	lines.push(line("with linkedin", withLinkedin, countOf(withLinkedin, total)));
	lines.push(
		`  ${padRight("avg confidence", 18)}  ${padRight("", 14)}  ${confidenceStr(Number(avgConfidence.toFixed(1)))}`,
	);
	return lines.join("\n");
}

function renderTeacherPreview(teachers: Teacher[], limit = 5): string {
	const top = [...teachers]
		.sort((a, b) => b.confidence - a.confidence)
		.slice(0, limit);

	const lines = [t.bold("preview")];
	for (const x of top) {
		const header = `${t.bold(`${x.firstName} ${x.lastName}`)}  ${t.muted("·")}  ${x.role || t.muted("(no role)")}  ${confidenceStr(x.confidence)}`;
		lines.push(`  ${header}`);

		const meta: string[] = [];
		if (x.department) meta.push(t.muted(x.department));
		if (x.schoolName) meta.push(t.muted(x.schoolName));
		if (meta.length) lines.push(`    ${meta.join(t.muted(" · "))}`);

		if (x.email) lines.push(`    ${t.brand(x.email)}`);
		if (x.linkedinUrl) lines.push(`    ${t.muted(x.linkedinUrl)}`);
		lines.push("");
	}
	while (lines.at(-1) === "") lines.pop();

	const remaining = teachers.length - top.length;
	if (remaining > 0) {
		lines.push(t.muted(`  + ${remaining} more in the csv`));
	}
	return lines.join("\n");
}

// ── exa key setup ────────────────────────────────────────────────────────────

/** write or update EXA_API_KEY in .env, preserving other entries */
async function saveExaKeyToEnv(key: string): Promise<void> {
	let existing = "";
	if (existsSync(ENV_FILE)) {
		existing = await Bun.file(ENV_FILE).text();
	}

	const line = `EXA_API_KEY=${key}`;
	const hasKey = /^EXA_API_KEY\s*=.*$/m.test(existing);
	const updated = hasKey
		? existing.replace(/^EXA_API_KEY\s*=.*$/m, line)
		: existing.endsWith("\n") || existing === ""
			? existing + line + "\n"
			: existing + "\n" + line + "\n";

	await Bun.write(ENV_FILE, updated);
}

/** open a URL in the user's default browser — best effort, non-fatal */
async function openBrowser(url: string): Promise<boolean> {
	// try platform-specific openers; if none work, the user can still copy the URL
	const cmds: string[][] = [
		["xdg-open", url],
		["open", url],
		["cmd", "/c", "start", "", url],
	];
	for (const [bin, ...args] of cmds) {
		try {
			const proc = Bun.spawn([bin!, ...args], {
				stdout: "ignore",
				stderr: "ignore",
			});
			await proc.exited;
			if (proc.exitCode === 0) return true;
		} catch {
			// command not found on this OS, try next
		}
	}
	return false;
}

/**
 * walk the user through Exa signup if they don't have a key yet. returns the
 * key (from env or freshly set up), or null if they opted to use the DDG
 * fallback instead.
 */
async function ensureExaKey(): Promise<string | null> {
	const existing = process.env.EXA_API_KEY?.trim();
	if (existing) return existing;

	const shouldSetup = await p.confirm({
		message: `set up Exa for better linkedin hit rate? ${t.muted("(or use the free DDG fallback)")}`,
		initialValue: true,
	});
	if (!shouldSetup || typeof shouldSetup !== "boolean") return null;

	p.note(
		[
			`${t.bold("1.")} we'll open ${t.brand(EXA_SIGNUP_URL)} in your browser`,
			`${t.bold("2.")} sign up with email or google (no credit card needed)`,
			`${t.bold("3.")} the free plan gives 1000 queries/month recurring`,
			`${t.bold("4.")} go to ${t.muted("API Keys")} → ${t.muted("Create API Key")} → copy it`,
			`${t.bold("5.")} come back here and paste it in`,
		].join("\n"),
		"exa search setup",
	);

	const opened = await openBrowser(EXA_SIGNUP_URL);
	if (!opened) {
		p.log.warn(
			`couldn't auto-open browser — please visit ${t.brand(EXA_SIGNUP_URL)} manually`,
		);
	}

	const key = await p.text({
		message: "paste your Exa API key (or leave empty to skip)",
		placeholder: "(get it from https://dashboard.exa.ai/!)",
		validate: (v) => {
			if (!v) return; // empty = skip
			if (v.length < 20) return "that doesn't look like a valid key";
		},
	});

	if (!key || typeof key !== "string" || !key.trim()) return null;

	const trimmed = key.trim();
	try {
		await saveExaKeyToEnv(trimmed);
		process.env.EXA_API_KEY = trimmed;
		p.log.info(
			`${t.ok("✓")} saved to .env — future runs will use it automatically`,
		);
		return trimmed;
	} catch (err) {
		p.log.warn(
			`couldn't save to .env (${err instanceof Error ? err.message : String(err)}). using key for this run only.`,
		);
		process.env.EXA_API_KEY = trimmed;
		return trimmed;
	}
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
	p.intro(`${BRAND_TAG}  ${TAGLINE}`);

	const config = await p.group(
		{
			schoolUrl: () =>
				p.text({
					message: "school website url",
					placeholder: "https://www.example-school.edu",
					validate: (value) => {
						if (!value) return "url is required";
						try {
							new URL(value);
						} catch {
							return "enter a valid url (include https://)";
						}
					},
				}),

			enableLinkedin: () =>
				p.confirm({
					message: "enable linkedin enrichment?",
					initialValue: true,
				}),
		},
		{
			onCancel: () => {
				p.cancel("cancelled");
				process.exit(0);
			},
		},
	);

	// if linkedin is enabled and we don't have an Exa key yet, walk the user
	// through signup. they can opt out and we'll fall back to the DDG scrape.
	if (config.enableLinkedin) {
		await ensureExaKey();
	}

	const domain = new URL(config.schoolUrl).hostname.replace(/^www\./, "");
	const outputPath = resolve("output", `${slugify(domain)}.csv`);

	p.log.info(`${t.muted("will write")} ${t.brand(outputPath)}`);

	const spinner = p.spinner();
	spinner.start("starting scrape...");

	// progress state: phase + latest substatus, combined into one spinner line
	let phasePrefix = "";
	let lastSubstatus = "";

	/**
	 * truncate an ANSI-colored string to fit within `maxWidth` visible columns.
	 * preserves escape codes but cuts the printable content. without this, long
	 * agent messages wrap across multiple lines and each spinner tick redraws
	 * the whole block, flooding the terminal.
	 */
	function truncateAnsi(s: string, maxWidth: number): string {
		const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
		if (plain.length <= maxWidth) return s;

		let visible = 0;
		let out = "";
		let i = 0;
		while (i < s.length && visible < maxWidth - 1) {
			if (s[i] === "\x1b" && s[i + 1] === "[") {
				const end = s.indexOf("m", i);
				if (end === -1) break;
				out += s.slice(i, end + 1);
				i = end + 1;
			} else {
				out += s[i];
				visible++;
				i++;
			}
		}
		return out + "…\x1b[0m";
	}

	/** render `[i/N] phase — substatus` into a single line for the spinner */
	function refreshSpinner() {
		const parts = [phasePrefix, lastSubstatus].filter(Boolean);
		const combined = parts.join(t.muted(" — "));
		// reserve a few cols for clack's spinner chrome (spinner char + margin)
		const termWidth = process.stdout.columns ?? 80;
		spinner.message(truncateAnsi(combined, Math.max(30, termWidth - 6)));
	}

	/** format the phase indicator: `[3/6] extracting teachers` */
	function formatPhasePrefix(phase: PhaseId, idx: number, total: number): string {
		return `${t.muted(`[${idx}/${total}]`)} ${t.bold(PHASE_LABELS[phase])}`;
	}

	/**
	 * patterns we never want to show in the substatus — agent-internal chatter
	 * that's meaningless or misleading to the user:
	 *   - "Output saved to output.json" refers to the agent's OWN python
	 *     scratchpad, NOT our schoolyank CSV. showing it to the user makes
	 *     them think the scrape is already done.
	 *   - "Running Python code" tells the user nothing.
	 *   - bare "Navigating to <url>" without additional context is noise
	 *     between meaningful actions.
	 */
	const NOISY_PATTERNS = [
		/\boutput(\.json)?\b/i,
		/^running python/i,
		/^python:?\s*$/i,
		/\bsave_output_json\b/i,
	];

	function isNoisy(msg: string): boolean {
		return NOISY_PATTERNS.some((re) => re.test(msg));
	}

	/**
	 * the orchestrator often emits per-phase substatus messages that overlap
	 * with our phase label ("extracting STEM teachers..."). strip the
	 * duplication, collapse whitespace, and drop newlines so the spinner
	 * renders as a single line regardless of the source message shape.
	 */
	function cleanSubstatus(msg: string): string {
		return msg
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.replace(/^extracting STEM teachers\.{0,3}\s*/i, "")
			.replace(/^finding staff directory\.{0,3}\s*/i, "")
			.replace(/^classifying site.*?\.{0,3}\s*/i, "")
			.replace(/^verifying.*?NCES\.{0,3}\s*/i, "")
			.replace(/^searching LinkedIn.*?\.{0,3}\s*/i, "")
			.replace(/^writing CSV\.{0,3}\s*/i, "")
			.trim();
	}

	try {
		const scrapeConfig: ScrapeConfig = {
			schoolUrl: config.schoolUrl,
			enableLinkedin: config.enableLinkedin ?? false,
			outputPath,
		};

		const result = await run(scrapeConfig, {
			onStatus: (msg) => {
				const cleaned = cleanSubstatus(msg);
				// skip noisy agent chatter — keep the previous substatus visible
				// instead of replacing it with uninformative text
				if (cleaned && !isNoisy(cleaned)) {
					lastSubstatus = cleaned;
				}
				refreshSpinner();
			},
			onPhase: (phase, idx, total) => {
				phasePrefix = formatPhasePrefix(phase, idx, total);
				lastSubstatus = ""; // clear per-phase substatus on transition
				refreshSpinner();
			},
			onMilestone: (msg, level) => {
				// clear → log → restart: spinner.clear() stops the interval
				// without emitting the green ◇ "done" frame that spinner.stop()
				// writes. we only want the persistent ● line, not a diamond
				// preamble before every milestone.
				spinner.clear();
				if (level === "warn") p.log.warn(msg);
				else p.log.info(t.muted(msg));
				spinner.start(phasePrefix || "");
				refreshSpinner();
			},
			onLiveUrl: (liveUrl) => {
				spinner.stop("browser session started");
				p.log.info(
					`${t.bold("watch live")}  ${t.brand(color.underline(liveUrl))}`,
				);
				spinner.start(phasePrefix || "crawling...");
			},
		});

		spinner.stop(t.ok("scrape complete"));

		const { teachers, metadata } = result;
		const duration = (metadata.durationMs / 1000).toFixed(1);

		const summary: string[] = [];
		summary.push(renderHeadline(result, duration));

		const breakdown = renderSchoolBreakdown(teachers);
		if (breakdown) {
			summary.push("");
			summary.push(breakdown);
		}

		if (teachers.length > 0) {
			summary.push("");
			summary.push(renderQualityBlock(teachers));
		}

		p.note(summary.join("\n"), "results");

		if (teachers.length > 0) {
			p.note(renderTeacherPreview(teachers, 5), "top matches");
		}

		if (metadata.warnings.length > 0) {
			for (const w of metadata.warnings) p.log.warn(w);
		}

		p.log.info(`${t.muted("csv saved to")} ${t.brand(outputPath)}`);
	} catch (err) {
		spinner.stop(t.bad("scrape failed"));
		const msg = err instanceof Error ? err.message : String(err);
		p.log.error(msg);
		process.exit(1);
	}

	p.outro(t.ok("done"));
}

main();
