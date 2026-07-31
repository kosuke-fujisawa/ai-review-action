import { readFileSync, writeFileSync } from "node:fs";
import {
  buildDiffArgs,
  budgetDiffByFile,
  findDeletedSymbolReferences,
  inputPath,
  listTrackedFiles,
  readTextIfExists,
  runGit,
  truncateText,
  writeJson,
} from "./lib.mjs";

const maxDiffChars = Number(process.env.AI_REVIEW_MAX_DIFF_CHARS || 30_000);
const baseRef = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "HEAD^";

let diff = "";
let diffUnavailable = false;
try {
  diff = runGit(buildDiffArgs(`${baseRef}...HEAD`));
} catch {
  try {
    diff = runGit(buildDiffArgs("HEAD^...HEAD"));
  } catch {
    // diff取得に失敗した場合(maxBuffer超過等)はジョブを落とさずスキップさせる
    diffUnavailable = true;
  }
}

const agentFiles = listTrackedFiles(["AGENTS.md", "**/AGENTS.md"]).slice(0, 3);
const agentInstructions = agentFiles.map((file) => ({
  file,
  content: truncateText(readFileSync(file, "utf8"), 8_000).text,
}));

const reviewInstructions = truncateText(
  readTextIfExists(".github/ai-review-instructions.md"),
  8_000,
).text;
const budgetedDiff = budgetDiffByFile(diff, maxDiffChars);
const deletedSymbolReferences = findDeletedSymbolReferences(diff);
const deterministicChecks = await loadDeterministicChecks();

writeJson(inputPath, {
  pullRequest: {
    number: process.env.PR_NUMBER || "",
    baseRef: process.env.GITHUB_BASE_REF || "",
    headRef: process.env.GITHUB_HEAD_REF || "",
  },
  reviewInstructions,
  agentInstructions,
  diff: budgetedDiff.text,
  diffTruncated: budgetedDiff.truncated,
  diffUnavailable,
  changedFiles: budgetedDiff.files,
  diffStats: budgetedDiff.fileStats,
  deletedSymbolReferences,
  deterministicChecks,
});

writeFileSync("tmp/ai-review/diff.patch", `${budgetedDiff.text}\n`);

async function loadDeterministicChecks() {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  if (!token || !repository || !sha) return [];
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/commits/${sha}/check-runs?per_page=100`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!response.ok) return [];
    const data = await response.json();
    return (data.check_runs || []).map(({ name, status, conclusion, html_url: url }) => ({ name, status, conclusion, url }));
  } catch {
    return [];
  }
}
