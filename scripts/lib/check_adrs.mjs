#!/usr/bin/env node
/**
 * ADR hygiene check (Phase 0+). Verifies:
 *   - docs/adr/ contains ADR-0001..ADR-0012 (the Phase 0 required set)
 *   - each file matches NNNN-kebab-slug.md naming
 *   - each ADR has Status/Date/Context/Decision/Consequences sections
 *   - status is one of proposed|accepted|deprecated|superseded
 * Exits 1 on any failure.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADR_DIR = join(ROOT, 'docs', 'adr');
const REQUIRED = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(4, '0'));

let bad = 0;
const fail = msg => { bad++; console.error(`  ✗ ${msg}`); };

if (!existsSync(ADR_DIR)) {
  console.error(`✗ ADR directory missing: ${ADR_DIR}`);
  process.exit(1);
}

const files = readdirSync(ADR_DIR).filter(f => f.endsWith('.md')).sort();
const byNumber = new Map();
for (const f of files) {
  const m = /^(\d{4})-[a-z0-9-]+\.md$/.exec(f);
  if (!m) { fail(`file name does not match NNNN-kebab-slug.md: ${f}`); continue; }
  byNumber.set(m[1], f);
}

for (const num of REQUIRED) {
  const f = byNumber.get(num);
  if (!f) { fail(`missing ADR-${num}`); continue; }
  const body = readFileSync(join(ADR_DIR, f), 'utf8');
  const requiredSections = ['## Status', '## Date', '## Context', '## Decision', '## Consequences'];
  for (const section of requiredSections) {
    if (!body.includes(section)) fail(`ADR-${num} (${f}) missing section "${section}"`);
  }
  const status = /## Status\s*\n+\s*([^\n]+)/.exec(body)?.[1]?.trim().toLowerCase() ?? '';
  if (!['proposed', 'accepted', 'deprecated', 'superseded'].some(s => status.startsWith(s))) {
    fail(`ADR-${num} (${f}) has invalid or missing status: "${status}"`);
  }
}

if (bad === 0) {
  console.log(`✓ all ${REQUIRED.length} required ADRs present and well-formed (${files.length} files checked)`);
  process.exit(0);
}
console.error(`✗ ${bad} ADR problem(s) found`);
process.exit(1);
