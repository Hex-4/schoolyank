#!/usr/bin/env bun

// ── schoolyank: extract STEM teacher data from any school website ──

import * as p from "@clack/prompts";
import color from "picocolors";
import { resolve } from "node:path";
import { run } from "./src/orchestrator";
import { slugify } from "./src/utils";
import type { ScrapeConfig } from "./src/types";

async function main() {
  p.intro(color.bgCyan(color.black(" schoolyank ")));

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
          initialValue: false,
        }),

      linkedinProfileId: ({ results }) =>
        results.enableLinkedin
          ? p.text({
              message: "linkedin browser-use profile id",
              placeholder: "profile_xxxxxxxx",
              validate: (v) => (v ? undefined : "profile id is required when linkedin is enabled"),
            })
          : Promise.resolve(undefined),
    },
    {
      onCancel: () => {
        p.cancel("cancelled");
        process.exit(0);
      },
    },
  );

  // generate output path from the school url
  const domain = new URL(config.schoolUrl).hostname.replace(/^www\./, "");
  const outputPath = resolve("output", `${slugify(domain)}.csv`);

  p.log.info(`output: ${color.dim(outputPath)}`);

  const spinner = p.spinner();
  spinner.start("starting scrape...");

  try {
    const scrapeConfig: ScrapeConfig = {
      schoolUrl: config.schoolUrl,
      enableLinkedin: config.enableLinkedin ?? false,
      linkedinProfileId: (config.linkedinProfileId as string | undefined) ?? undefined,
      outputPath,
    };

    const result = await run(
      scrapeConfig,
      (msg) => spinner.message(msg),
      (liveUrl) => {
        spinner.stop("browser session started");
        p.log.info(`${color.bold("watch live:")} ${color.cyan(color.underline(liveUrl))}`);
        spinner.start("crawling...");
      },
    );

    spinner.stop("scrape complete");

    // summary
    const { teachers, school, metadata } = result;
    const duration = (metadata.durationMs / 1000).toFixed(1);

    p.log.success(
      [
        `${color.bold(String(teachers.length))} STEM teachers found at ${color.bold(school.name)}`,
        school.address
          ? `address: ${school.address.street}, ${school.address.city}, ${school.address.state} ${school.address.zip} ${color.dim(`(${school.address.source})`)}`
          : "",
        school.district ? `district: ${school.district}` : "",
        `time: ${duration}s`,
        `output: ${color.underline(outputPath)}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );

    // show warnings if any
    if (metadata.warnings.length > 0) {
      for (const w of metadata.warnings) {
        p.log.warn(w);
      }
    }

    // preview first few teachers
    if (teachers.length > 0) {
      const preview = teachers
        .slice(0, 5)
        .map(
          (t) =>
            `  ${t.firstName} ${t.lastName} — ${t.role}${t.email ? ` (${t.email})` : ""} ${color.dim(`[${t.confidence}/5]`)}`,
        )
        .join("\n");

      p.log.info(
        `${color.bold("preview")}:\n${preview}${teachers.length > 5 ? `\n  ${color.dim(`... and ${teachers.length - 5} more`)}` : ""}`,
      );
    }
  } catch (err) {
    spinner.stop("scrape failed");
    const msg = err instanceof Error ? err.message : String(err);
    p.log.error(msg);
    process.exit(1);
  }

  p.outro(color.green("done!"));
}

main();
