/**
 * Layout report (PB-1007) for UHD bundles: each level's layout metrics as
 * drawn now, with the old default (one row), with the new default, and tidied.
 *
 *   npx vite-node scripts/layout-report.ts -- <bundle.json>... [--json]
 */
import { readFileSync } from "node:fs";
import type { UhdBundle } from "@uhd/types/bundle.js";
import { diagramLevels, measureLevel, proposeLevel, type LayoutMetrics } from "../src/headless";

const args = process.argv.slice(2).filter((a) => a !== "--");
const json = args.includes("--json");
const files = args.filter((a) => !a.startsWith("--"));
const short = (m: LayoutMetrics) => `cards ${m.cards} links ${m.links} cross ${m.crossings} overlap ${m.overlaps} strip ${m.strip} aspect ${m.aspect} under ${m.underCards} len ${m.length}`;
const rows: unknown[] = [];
for (const file of files) {
  const bundle = JSON.parse(readFileSync(file, "utf8")) as UhdBundle;
  for (const lv of diagramLevels(bundle)) {
    const t0 = performance.now();
    const now = measureLevel(bundle, lv.level);
    const legacy = measureLevel(bundle, lv.level, { layout: null, legacy: true });
    const fresh = measureLevel(bundle, lv.level, { layout: null });
    const tidy = now.saved ? proposeLevel(bundle, lv.level, { mode: "tidy" }).after.metrics : undefined;
    const ms = Math.round(performance.now() - t0);
    rows.push({ file, level: lv.level, board: lv.board, saved: now.saved, now: now.metrics, legacy: legacy.metrics, fresh: fresh.metrics, tidy: tidy?.metrics, ms });
    if (!json) {
      console.log(`\n${file} [${lv.level || "top"}]${lv.board ? " (board)" : ""} ${ms} ms`);
      console.log(`  now (${now.saved ? "saved" : "auto"}): ${short(now.metrics)}  ${now.findings.map((f) => f.code).join(",")}`);
      console.log(`  old default:  ${short(legacy.metrics)}`);
      console.log(`  new default:  ${short(fresh.metrics)}  ${measureLevel(bundle, lv.level, { layout: null }).findings.map((f) => f.code).join(",")}`);
      if (tidy) console.log(`  tidy:         ${short(tidy)}`);
    }
  }
}
if (json) console.log(JSON.stringify(rows, null, 2));
