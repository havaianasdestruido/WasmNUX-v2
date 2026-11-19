#!/usr/bin/env node
/** Benchmark CLI: `npm run bench` — prints a table and writes JSON. */

import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { runSuite } from "./suite.js";

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args[outIdx + 1] : "benchmarks/results/latest.json";
  const quiet = args.includes("--quiet");
  const budgetIdx = args.indexOf("--budget");
  const budgetMs = budgetIdx >= 0 ? Number(args[budgetIdx + 1]) : 120_000;

  const rows = await runSuite({ budgetMs, quiet });

  if (!quiet) {
    console.log(pad("id", 26) + pad("status", 9) + pad("value", 16) + pad("unit", 12) + "kpi");
    console.log("-".repeat(110));
    for (const r of rows) {
      const val = r.status === "ok" ? String(r.value ?? "") : "-";
      console.log(pad(r.id, 26) + pad(r.status, 9) + pad(val, 16) + pad(r.unit ?? "", 12) + r.kpi);
      if (r.detail && !quiet) console.log("    " + r.detail);
    }
    const ok = rows.filter((r) => r.status === "ok").length;
    const skipped = rows.filter((r) => r.status === "skipped").length;
    console.log(`\n${rows.length} rows: ${ok} measured, ${skipped} skipped`);
  }

  const abs = path.resolve(out);
  await mkdir(path.dirname(abs), { recursive: true });
  const payload = {
    commit: process.env.GITHUB_SHA ?? "local",
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    date: new Date().toISOString(),
    rows,
  };
  await writeFile(abs, JSON.stringify(payload, null, 2) + "\n");
  console.log(`wrote ${abs}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
