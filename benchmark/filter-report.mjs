import { readFileSync } from "node:fs";

import {
  formatFilterEffectivenessReport,
  scoreFilterEffectiveness,
} from "./lib.mjs";

const manifestPath = process.argv[2] || "benchmark/manifest.json";
const resultsPath = process.argv[3] || "benchmark/filter-results.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const results = JSON.parse(readFileSync(resultsPath, "utf8"));

process.stdout.write(
  formatFilterEffectivenessReport(scoreFilterEffectiveness(manifest, results)),
);
