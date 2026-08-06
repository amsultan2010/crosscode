#!/usr/bin/env node
// One command: node spike/run.mjs
import { COUNTEREXAMPLES } from "./literal-plan.mjs";
import { ALL } from "./scenarios.mjs";

const only = process.argv[2];
let failed = 0;
let total = 0;

for (const fn of [...ALL, ...COUNTEREXAMPLES]) {
  let result;
  try {
    result = fn();
  } catch (err) {
    console.log(`FAIL  ${fn.name}: threw ${err.message}`);
    failed++;
    total++;
    continue;
  }
  if (only && !result.name.startsWith(only)) continue;
  const bad = result.checks.filter((c) => !c.ok);
  total++;
  if (bad.length) failed++;
  console.log(`${bad.length ? "FAIL" : "PASS"}  ${result.name}  (${result.checks.length - bad.length}/${result.checks.length} checks)`);
  for (const c of result.checks) {
    if (!c.ok) console.log(`        ✗ ${c.label}${c.detail ? `: ${c.detail}` : ""}`);
    else if (process.env.VERBOSE) console.log(`        ✓ ${c.label}${c.detail ? `: ${c.detail}` : ""}`);
  }
}

console.log(`\n${total - failed}/${total} scenarios passed`);
process.exit(failed ? 1 : 0);
