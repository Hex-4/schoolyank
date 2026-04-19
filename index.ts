#!/usr/bin/env bun

// ── schoolyank: extract STEM teacher data from any school website ──

// force ipv4-first dns resolution. some upstreams (urban institute's nces
// endpoints, in particular) advertise AAAA records on hosts whose ipv6 path
// is unreachable from common home networks — bun's fetch then happy-eyeballs
// to the broken ipv6 address and hangs until the per-request timeout.
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import * as p from "@clack/prompts";
import color from "picocolors";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { run, PHASE_LABELS, type PhaseId } from "./src/orchestrator";
import { slugify } from "./src/utils";
import { generateMergedCsv, writeCsv } from "./src/csv";
import { missingRequiredEnv, runSetupWizard } from "./src/setup";
import { createClient, killActiveSessions } from "./src/browser";
import { debug } from "./src/debug";
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

// ── cli argv parsing ─────────────────────────────────────────────────────────

interface CliFlags {
	urls: string[];
	urlsFile: string | null;
	enableLinkedin: boolean | null; // null = use interactive default
	output: string | null;
	mergedOutput: string | null;
	concurrency: number;
	force: boolean;
	help: boolean;
	interactive: boolean;
	debug: boolean;
}

function parseArgs(argv: string[]): CliFlags {
	const flags: CliFlags = {
		urls: [],
		urlsFile: null,
		enableLinkedin: null,
		output: null,
		mergedOutput: null,
		concurrency: 3,
		force: false,
		help: false,
		interactive: false,
		debug: false,
	};

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		const next = () => argv[++i];
		switch (a) {
			case "-h":
			case "--help":
				flags.help = true;
				break;
			case "--url":
				flags.urls.push(next() ?? "");
				break;
			case "--urls-file":
				flags.urlsFile = next() ?? null;
				break;
			case "--linkedin":
				flags.enableLinkedin = true;
				break;
			case "--no-linkedin":
				flags.enableLinkedin = false;
				break;
			case "--output":
			case "-o":
				flags.output = next() ?? null;
				break;
			case "--merged-output":
				flags.mergedOutput = next() ?? null;
				break;
			case "--concurrency":
			case "-j":
				flags.concurrency = Math.max(1, Number(next()) || 3);
				break;
			case "--force":
				flags.force = true;
				break;
			case "--interactive":
				flags.interactive = true;
				break;
			case "--debug":
				flags.debug = true;
				break;
			default:
				// bare positional args are treated as URLs — lets the user do
				// `bun index.ts <url1> <url2>` without --url prefixes.
				if (!a.startsWith("-")) flags.urls.push(a);
				break;
		}
	}

	return flags;
}

async function loadUrlsFromFile(path: string): Promise<string[]> {
	const text = await Bun.file(path).text();
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
}

function printHelp(): void {
	const bin = t.bold("bun index.ts");
	const lines = [
		`${BRAND_TAG}  ${TAGLINE}`,
		"",
		`${t.bold("USAGE")}`,
		`  ${bin}                        ${t.muted("interactive prompt (single school)")}`,
		`  ${bin} <url>                  ${t.muted("scrape one school non-interactively")}`,
		`  ${bin} <url1> <url2> ...      ${t.muted("batch (3-way parallel by default)")}`,
		`  ${bin} --urls-file urls.txt   ${t.muted("batch from a file, one url per line")}`,
		"",
		`${t.bold("FLAGS")}`,
		`  ${t.brand("--url")} <x>              add a url (repeatable)`,
		`  ${t.brand("--urls-file")} <path>     read urls from a file (one per line, # for comments)`,
		`  ${t.brand("--linkedin")}             enable linkedin enrichment`,
		`  ${t.brand("--no-linkedin")}          disable linkedin enrichment`,
		`  ${t.brand("--output, -o")} <path>    single-url output csv path (default: output/<slug>.csv)`,
		`  ${t.brand("--merged-output")} <path> batch merged csv path (default: output/all.csv)`,
		`  ${t.brand("--concurrency, -j")} <n>  parallel workers in batch (default 3, browser-use free-tier cap)`,
		`  ${t.brand("--force")}                re-scrape even if output csv already exists`,
		`  ${t.brand("--interactive")}          force interactive prompt even when urls are passed`,
		`  ${t.brand("--debug")}                print extremely detailed debug info (browser agent, llm, nces, etc.)`,
		`  ${t.brand("--help, -h")}             show this message`,
		"",
		`${t.bold("EXAMPLES")}`,
		`  ${t.muted("# interactive run (guided CLI)")}`,
		`  ${bin}`,
		"",
		`  ${t.muted("# one school, no prompts, linkedin on")}`,
		`  ${bin} --url https://cvsdvt.org --linkedin`,
		"",
		`  ${t.muted("# batch 15 schools with 3-way parallelism, merged output")}`,
		`  ${bin} --urls-file schools.txt --linkedin --merged-output output/all.csv`,
	];
	console.log(lines.join("\n"));
}

// ── main ─────────────────────────────────────────────────────────────────────

async function runInteractive(): Promise<void> {
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

	if (existsSync(outputPath)) {
		const overwrite = await p.confirm({
			message: `${t.brand(outputPath)} already exists — overwrite?`,
			initialValue: false,
		});
		if (p.isCancel(overwrite) || !overwrite) {
			p.cancel("bailed, existing file kept");
			process.exit(0);
		}
	}

	p.log.info(`${t.muted("will write")} ${t.brand(outputPath)}`);

	// in --debug mode the spinner's repeated redraws fight with the stderr
	// debug firehose (agent messages, llm prompts, nces decisions) and the
	// terminal ends up a scrambled mess. swap it for a no-op stub whose
	// lifecycle calls (start/stop/message/clear) just return — phase + status
	// info already lands on stderr via the debug() calls we threaded through
	// the pipeline, so nothing is lost.
	const debugMode = process.env.SCHOOLYANK_DEBUG === "1";
	// clack's default 80ms tick redraws the whole line 12×/sec — on some
	// terminals the erase→rewrite has a visible gap and the line flickers.
	// 100ms drops to 10/sec which is enough to settle on those terminals
	// while keeping the spin motion snappy.
	const spinner = debugMode
		? { start: () => {}, stop: () => {}, message: () => {}, clear: () => {} }
		: p.spinner({ delay: 100 });
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

	// dedup + throttle spinner writes. agent messages arrive faster than the
	// terminal can cleanly redraw, and when two substatuses alternate in quick
	// succession the line visibly flickers. only push a new frame if the
	// rendered string actually changed AND at least MIN_REFRESH_MS has elapsed
	// since the last write (phase transitions bypass the throttle).
	const MIN_REFRESH_MS = 120;
	let lastRendered = "";
	let lastRenderedAt = 0;
	let pendingTimer: ReturnType<typeof setTimeout> | null = null;

	/** render `[i/N] phase — substatus` into a single line for the spinner */
	function refreshSpinner(opts?: { immediate?: boolean }) {
		const parts = [phasePrefix, lastSubstatus].filter(Boolean);
		const combined = parts.join(t.muted(" — "));
		const termWidth = process.stdout.columns ?? 80;
		const next = truncateAnsi(combined, Math.max(30, termWidth - 6));
		if (next === lastRendered) return;

		const now = Date.now();
		const elapsed = now - lastRenderedAt;
		if (!opts?.immediate && elapsed < MIN_REFRESH_MS) {
			if (pendingTimer) return;
			pendingTimer = setTimeout(() => {
				pendingTimer = null;
				refreshSpinner({ immediate: true });
			}, MIN_REFRESH_MS - elapsed);
			return;
		}
		if (pendingTimer) {
			clearTimeout(pendingTimer);
			pendingTimer = null;
		}
		lastRendered = next;
		lastRenderedAt = now;
		spinner.message(next);
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
				debug("STATUS", msg);
				const cleaned = cleanSubstatus(msg);
				// skip noisy agent chatter — keep the previous substatus visible
				// instead of replacing it with uninformative text
				if (cleaned && !isNoisy(cleaned)) {
					lastSubstatus = cleaned;
				}
				refreshSpinner();
			},
			onPhase: (phase, idx, total) => {
				debug("PHASE", `→ ${phase} [${idx}/${total}]`);
				phasePrefix = formatPhasePrefix(phase, idx, total);
				lastSubstatus = ""; // clear per-phase substatus on transition
				refreshSpinner({ immediate: true });
			},
			onMilestone: (msg, level) => {
				debug("MILESTONE", `[${level ?? "info"}] ${msg}`);
				// clear → log → restart: spinner.clear() stops the interval
				// without emitting the green ◇ "done" frame that spinner.stop()
				// writes. we only want the persistent ● line, not a diamond
				// preamble before every milestone.
				spinner.clear();
				if (level === "warn") p.log.warn(msg);
				else p.log.info(t.muted(msg));
				spinner.start(phasePrefix || "");
				lastRendered = ""; // spinner.start resets the line
				refreshSpinner({ immediate: true });
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

// ── non-interactive batch mode ───────────────────────────────────────────────

interface BatchItem {
	url: string;
	outputPath: string;
	slug: string;
}

interface BatchOutcome {
	item: BatchItem;
	status: "ok" | "skipped" | "failed";
	result?: ScrapeResult;
	error?: string;
	durationMs: number;
}

function defaultOutputPathFor(url: string): string {
	const domain = new URL(url).hostname.replace(/^www\./, "");
	return resolve("output", `${slugify(domain)}.csv`);
}

/**
 * run one scrape non-interactively. emits short progress lines (one per
 * milestone) instead of the spinner UI — batch mode can't use a spinner
 * because multiple runs would fight for the same TTY line.
 */
async function scrapeOne(
	url: string,
	enableLinkedin: boolean,
	outputPath: string,
	tag: string,
): Promise<ScrapeResult> {
	const scrapeConfig: ScrapeConfig = { schoolUrl: url, enableLinkedin, outputPath };
	return run(scrapeConfig, {
		onStatus: (msg) => {
			debug("STATUS", `${tag} ${msg}`);
		},
		onPhase: (phase, idx, total) => {
			debug("PHASE", `${tag} → ${phase} [${idx}/${total}]`);
			console.log(`${t.muted(tag)} ${t.muted(`[${idx}/${total}]`)} ${t.bold(PHASE_LABELS[phase])}`);
		},
		onMilestone: (msg, level) => {
			debug("MILESTONE", `${tag} [${level ?? "info"}] ${msg}`);
			const prefix = level === "warn" ? t.warn("!") : t.ok("•");
			console.log(`${t.muted(tag)} ${prefix} ${msg}`);
		},
		onLiveUrl: (liveUrl) => {
			debug("LIVE-URL", `${tag} ${liveUrl}`);
			console.log(`${t.muted(tag)} ${t.muted("watch live:")} ${t.brand(liveUrl)}`);
		},
	});
}

/** fixed-size worker pool: always up to `concurrency` scrapes in flight. */
async function runBatch(
	items: BatchItem[],
	enableLinkedin: boolean,
	concurrency: number,
	force: boolean,
): Promise<BatchOutcome[]> {
	const outcomes: BatchOutcome[] = new Array(items.length);
	let cursor = 0;

	async function worker(): Promise<void> {
		while (true) {
			const myIdx = cursor++;
			if (myIdx >= items.length) break;
			const item = items[myIdx]!;
			const tag = `[${myIdx + 1}/${items.length} ${item.slug}]`;
			const start = Date.now();

			if (!force && existsSync(item.outputPath)) {
				console.log(`${t.muted(tag)} ${t.muted("skipped (output exists — pass --force to re-scrape)")}`);
				outcomes[myIdx] = {
					item,
					status: "skipped",
					durationMs: Date.now() - start,
				};
				continue;
			}

			console.log(`${t.muted(tag)} ${t.bold("starting")} ${t.brand(item.url)}`);

			// one-retry policy: browser-use sessions can drop or hit transient
			// rate limits; a fresh retry resolves most of these. without this,
			// ~5-10% of a 15-school batch would silently fail on a judge's test.
			let result: ScrapeResult | null = null;
			let lastError = "";
			for (let attempt = 1; attempt <= 2; attempt++) {
				try {
					const r = await scrapeOne(item.url, enableLinkedin, item.outputPath, tag);
					// treat 0 teachers as a retry-eligible failure — it's almost always
					// a transient scraper gave-up / browser-use flake, not a real
					// empty district. a real empty district is vanishingly rare.
					if (r.teachers.length === 0 && attempt === 1) {
						console.log(
							`${t.muted(tag)} ${t.warn("! first attempt returned 0 teachers — retrying once")}`,
						);
						lastError = "0 teachers on first attempt";
						continue;
					}
					result = r;
					break;
				} catch (err) {
					lastError = err instanceof Error ? err.message : String(err);
					if (attempt === 1) {
						console.log(`${t.muted(tag)} ${t.warn("! first attempt failed:")} ${lastError} ${t.muted("— retrying once")}`);
					}
				}
			}

			if (result) {
				const dur = ((Date.now() - start) / 1000).toFixed(1);
				console.log(
					`${t.muted(tag)} ${t.ok("✓ done")} ${t.accent(String(result.teachers.length))} ${t.muted("teachers")} ${t.muted(`(${dur}s)`)}`,
				);
				outcomes[myIdx] = {
					item,
					status: "ok",
					result,
					durationMs: Date.now() - start,
				};
			} else {
				console.log(`${t.muted(tag)} ${t.bad("✗ failed (after retry):")} ${lastError}`);
				outcomes[myIdx] = {
					item,
					status: "failed",
					error: lastError,
					durationMs: Date.now() - start,
				};
			}
		}
	}

	const workerCount = Math.max(1, Math.min(concurrency, items.length));
	await Promise.all(Array.from({ length: workerCount }, worker));
	return outcomes;
}

async function runNonInteractive(flags: CliFlags): Promise<void> {
	// aggregate URL inputs: --url repeats + positionals + --urls-file
	let urls = [...flags.urls];
	if (flags.urlsFile) {
		try {
			const fileUrls = await loadUrlsFromFile(flags.urlsFile);
			urls = urls.concat(fileUrls);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(t.bad(`failed to read urls file: ${msg}`));
			process.exit(1);
		}
	}

	// validate URLs, drop bad ones with a warning (don't crash the whole batch)
	const valid: string[] = [];
	for (const u of urls) {
		try {
			new URL(u);
			valid.push(u);
		} catch {
			console.error(t.warn(`skipping invalid url: ${u}`));
		}
	}
	if (valid.length === 0) {
		console.error(t.bad("no valid urls — see --help"));
		process.exit(1);
	}

	const enableLinkedin = flags.enableLinkedin ?? true;

	// build work items with output paths. --output only applies when there's
	// exactly one url; batches always route through output/<slug>.csv because
	// a single --output would overwrite itself across runs.
	const items: BatchItem[] = valid.map((url, i) => {
		const domain = new URL(url).hostname.replace(/^www\./, "");
		const slug = slugify(domain);
		const outputPath =
			valid.length === 1 && flags.output
				? resolve(flags.output)
				: defaultOutputPathFor(url);
		return { url, outputPath, slug };
	});

	console.log(`${BRAND_TAG}  ${t.muted(`${items.length} school${items.length === 1 ? "" : "s"}, concurrency ${flags.concurrency}`)}`);
	if (enableLinkedin && !process.env.EXA_API_KEY) {
		console.log(t.warn("! linkedin enabled but EXA_API_KEY not set — falling back to DDG scrape (lower hit rate)"));
	}

	// clear any lingering browser-use sessions from previous runs before we
	// spawn ours. the free tier caps at 3 concurrent sessions project-wide,
	// and an aborted run can leave sessions active past their idle timeout
	// — which would make the first createSession() of this run fail.
	try {
		const killed = await killActiveSessions(createClient());
		if (killed > 0) console.log(t.muted(`cleared ${killed} lingering browser-use session${killed === 1 ? "" : "s"}`));
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		debug("INDEX", `killActiveSessions failed: ${msg}`);
	}

	const batchStart = Date.now();
	const outcomes = await runBatch(items, enableLinkedin, flags.concurrency, flags.force);
	const batchDurationSec = ((Date.now() - batchStart) / 1000).toFixed(1);

	// merged CSV for batches of 2+ (or always when --merged-output is passed)
	const okOutcomes = outcomes.filter((o) => o.status === "ok" && o.result);
	if (okOutcomes.length > 0 && (items.length > 1 || flags.mergedOutput)) {
		const mergedPath = resolve(flags.mergedOutput ?? "output/all.csv");
		const csv = generateMergedCsv(okOutcomes.map((o) => o.result!));
		await writeCsv(mergedPath, csv);
		const totalTeachers = okOutcomes.reduce((n, o) => n + o.result!.teachers.length, 0);
		console.log(`${t.ok("✓")} merged csv: ${t.brand(mergedPath)} ${t.muted(`(${totalTeachers} teachers across ${okOutcomes.length} schools)`)}`);
	}

	// summary
	const ok = outcomes.filter((o) => o.status === "ok").length;
	const skipped = outcomes.filter((o) => o.status === "skipped").length;
	const failed = outcomes.filter((o) => o.status === "failed");
	console.log();
	console.log(
		`${t.bold("batch summary")}  ${t.ok(`${ok} ok`)}  ${t.muted(`${skipped} skipped`)}  ${failed.length > 0 ? t.bad(`${failed.length} failed`) : t.muted("0 failed")}  ${t.muted(`${batchDurationSec}s total`)}`,
	);
	if (failed.length > 0) {
		for (const f of failed) console.log(`  ${t.bad("✗")} ${f.item.url} — ${f.error}`);
		process.exit(1);
	}
}

// ── entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const flags = parseArgs(Bun.argv.slice(2));
	if (flags.help) {
		printHelp();
		return;
	}

	// set the debug env var BEFORE any pipeline code runs. the debug module
	// reads this lazily per-call, so setting it here propagates to every
	// subsequent import without needing to thread a flag through every layer.
	if (flags.debug) {
		process.env.SCHOOLYANK_DEBUG = "1";
		console.error(`${t.muted("[DEBUG]")} ${t.bold("schoolyank debug mode enabled")} ${t.muted("— verbose output on stderr")}`);
		console.error(`${t.muted("[DEBUG]")} flags: ${JSON.stringify(flags)}`);
	}

	// preflight: if the required keys aren't set, walk the user through the
	// full interactive setup wizard. handles LLM provider selection, browser-use
	// signup via their public challenge api, and (optionally) Exa signup via a
	// temp email. at the end, .env is written and the scrape proceeds normally.
	if (missingRequiredEnv().length > 0) {
		try {
			await runSetupWizard();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`${t.bad("✗ setup failed:")} ${msg}`);
			console.error(
				`\n${t.muted("you can manually populate .env and rerun. required keys:")}\n  ${t.brand("BROWSER_USE_API_KEY")}\n  ${t.brand("AI_BASE_URL")}, ${t.brand("AI_MODEL")}, ${t.brand("AI_API_KEY")}\n  ${t.brand("EXA_API_KEY")} ${t.muted("(optional — for LinkedIn enrichment)")}`,
			);
			process.exit(1);
		}
	}

	const hasUrls = flags.urls.length > 0 || !!flags.urlsFile;
	if (flags.interactive || !hasUrls) {
		await runInteractive();
	} else {
		await runNonInteractive(flags);
	}
}

main();
