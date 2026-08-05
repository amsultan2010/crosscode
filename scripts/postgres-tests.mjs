#!/usr/bin/env node
// Runs every PostgreSQL-gated test suite, serialized, and fails if one skips.
//
// Selection is mechanical on purpose. A test file is PostgreSQL-gated exactly when it reads
// CROSSCODE_TEST_DATABASE_URL, because that read is what makes it skip itself. Discovering the
// suites from that gate, rather than from a filename convention or a literal list in
// package.json, means a new gated suite is picked up with nothing to remember to edit. The
// literal list is what left prune.test.ts and live-handoff-intent.integration.test.ts running
// in no job at all. A `*.integration.test.ts` convention would not work either: publish,
// semantic-review, and uninstall carry that name and need no database.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GATE = "CROSSCODE_TEST_DATABASE_URL";
const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const SEARCH_ROOTS = ["apps", "packages"];
const IGNORED_DIRS = new Set(["node_modules", "dist", "coverage", ".git"]);

function fail(message) {
  console.error(`test:postgres: ${message}`);
  process.exit(1);
}

function findTestFiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) findTestFiles(path, found);
    } else if (entry.name.endsWith(".test.ts")) {
      found.push(path);
    }
  }
  return found;
}

if (!process.env[GATE]) fail(`${GATE} is required`);

const gated = SEARCH_ROOTS.flatMap((root) => findTestFiles(join(ROOT, root)))
  .filter((path) => readFileSync(path, "utf8").includes(GATE))
  .map((path) => relative(ROOT, path))
  .sort();

if (gated.length === 0) fail(`found no test files referencing ${GATE} under ${SEARCH_ROOTS.join(", ")}`);

console.log(`test:postgres: running ${gated.length} PostgreSQL-gated suites\n${gated.map((f) => `  ${f}`).join("\n")}\n`);

const report = join(tmpdir(), `crosscode-postgres-report-${process.pid}.json`);
const vitest = spawnSync(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "--no-file-parallelism",
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${report}`,
    ...gated
  ],
  { cwd: ROOT, stdio: "inherit" }
);

// The report is the only way to tell "passed" apart from "silently skipped": a gated suite that
// skips itself exits 0 and prints a checkmark-adjacent down-arrow that is easy to miss in CI logs.
let results;
try {
  results = JSON.parse(readFileSync(report, "utf8"));
} catch {
  fail(`vitest produced no JSON report at ${report}`);
} finally {
  rmSync(report, { force: true });
}

if (vitest.status !== 0) process.exit(vitest.status ?? 1);

const ran = new Set(results.testResults.map((suite) => relative(ROOT, suite.name)));
const missing = gated.filter((file) => !ran.has(file));
if (missing.length > 0) fail(`selected but never reported by vitest:\n${missing.map((f) => `  ${f}`).join("\n")}`);

const skipped = results.testResults.flatMap((suite) =>
  suite.assertionResults
    .filter((test) => test.status !== "passed" && test.status !== "failed")
    .map((test) => `  ${relative(ROOT, suite.name)} > ${test.fullName} (${test.status})`)
);
if (skipped.length > 0) {
  fail(`${skipped.length} PostgreSQL-gated test(s) skipped in the job meant to run them:\n${skipped.join("\n")}`);
}

console.log(`\ntest:postgres: ${results.numPassedTests} tests passed across ${gated.length} files, none skipped`);
