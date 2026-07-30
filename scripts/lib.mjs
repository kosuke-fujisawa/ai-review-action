import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const outputDir = "tmp/ai-review";
export const inputPath = `${outputDir}/input.json`;
export const resultPath = `${outputDir}/result.json`;
export const commentPath = `${outputDir}/comment.md`;
export const diagnosticsPath = `${outputDir}/diagnostics.json`;

const MAX_BUFFER_BYTES = 20 * 1024 * 1024;

const excludedDiffPathspecs = [
  ":(exclude,glob)**/*.md",
  ":(exclude,glob)**/*.txt",
  ":(exclude,glob)**/*.lock",
  ":(exclude,glob)**/package-lock.json",
  ":(exclude,glob)**/yarn.lock",
  ":(exclude,glob)**/pnpm-lock.yaml",
  ":(exclude,glob)**/Package.resolved",
  ":(exclude,glob)**/dist/**",
  ":(exclude,glob)**/build/**",
  ":(exclude,glob)**/DerivedData/**",
  ":(exclude,glob)**/*.min.js",
  ":(exclude,glob)**/*.map",
  ":(exclude,glob)**/*.png",
  ":(exclude,glob)**/*.jpg",
  ":(exclude,glob)**/*.jpeg",
  ":(exclude,glob)**/*.gif",
  ":(exclude,glob)**/*.webp",
  ":(exclude,glob)**/*.svg",
  ":(exclude,glob)**/*.pdf",
  ":(exclude,glob)**/*.zip",
  ":(exclude,glob)**/*.uid",
  ":(exclude,glob).github/workflows/ai-review.yml",
  ":(exclude,glob)scripts/ai-review/**",
];

export function ensureParentDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

export function readTextIfExists(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function writeJson(path, value) {
  ensureParentDir(path);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function truncateText(text, maxChars) {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  return {
    text: `${text.slice(0, maxChars)}\n\n[truncated: ${text.length - maxChars} chars omitted]`,
    truncated: true,
  };
}

const LOW_VALUE_DIFF_EXTENSIONS = new Set([
  ".json", ".yaml", ".yml", ".xml", ".plist", ".strings", ".xcstrings", ".resx", ".csv",
]);
const MIN_FILE_BUDGET = 200;

function extensionOf(fileName) {
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
}

function tierOf(fileName) {
  return LOW_VALUE_DIFF_EXTENSIONS.has(extensionOf(fileName)) ? "low_value" : "code";
}

function weightOf(fileName) {
  return tierOf(fileName) === "low_value" ? 1 : 3;
}

export function budgetDiffByFile(diff, maxChars) {
  const sections = diff.split(/(?=^diff --git )/m).filter((section) => section.trim());
  if (sections.length === 0 || diff.length <= maxChars) {
    return {
      text: diff,
      truncated: false,
      files: sections.map(diffFileName),
      fileStats: sections.map((section) => {
        const file = diffFileName(section);
        return { file, originalChars: section.length, keptChars: section.length, omittedChars: 0, tier: tierOf(file) };
      }),
    };
  }

  const files = sections.map(diffFileName);
  const weights = files.map(weightOf);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const fileStats = [];

  const rendered = sections.map((section, index) => {
    const file = files[index];
    const perFileBudget = Math.max(MIN_FILE_BUDGET, Math.floor((maxChars * weights[index]) / totalWeight));
    if (section.length <= perFileBudget) {
      fileStats.push({ file, originalChars: section.length, keptChars: section.length, omittedChars: 0, tier: tierOf(file) });
      return section;
    }
    const headerEnd = section.indexOf("\n");
    const header = headerEnd >= 0 ? section.slice(0, headerEnd + 1) : section;
    const bodyBudget = Math.max(0, perFileBudget - header.length - 40);
    const kept = `${header}${section.slice(header.length, header.length + bodyBudget)}`;
    const omittedChars = section.length - kept.length;
    fileStats.push({ file, originalChars: section.length, keptChars: kept.length, omittedChars, tier: tierOf(file) });
    return `${kept}\n[truncated within file: ${omittedChars} chars omitted]\n`;
  });
  return { text: rendered.join("\n"), truncated: true, files, fileStats };
}

function diffFileName(section) {
  return section.match(/^diff --git a\/(.+?) b\/(.+)$/m)?.[2] || "unknown";
}

export function extractDeletedSymbols(diff) {
  const symbols = new Set();
  const declaration = /^(?:[-]\s*)(?:(?:public|private|internal|protected|open|static|final|async|export)\s+)*(?:class|struct|enum|protocol|actor|trait|interface|type|typealias|func|fn|function)\s+([A-Za-z_$][\w$]*)/;
  for (const line of diff.split("\n")) {
    if (line.startsWith("---")) continue;
    const match = line.match(declaration);
    if (match) symbols.add(match[1]);
  }
  return [...symbols];
}

export function findDeletedSymbolReferences(diff, grep = runGit) {
  return extractDeletedSymbols(diff).flatMap((symbol) => {
    try {
      const output = grep(["grep", "-n", "-w", "--", symbol, "HEAD"]);
      return output ? [{ symbol, command: `git grep -n -w -- ${symbol} HEAD`, matches: output.split("\n").slice(0, 20) }] : [];
    } catch {
      return [];
    }
  });
}

export function runGit(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: MAX_BUFFER_BYTES,
  }).trim();
}

function runFile(file, args) {
  return execFileSync(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: MAX_BUFFER_BYTES,
  }).trim();
}

export function runVerificationProbe(verification, runner = runFile) {
  if (!verification || verification.probe !== "git_ls_files") {
    return { verified: false, outcome: "inconclusive", summary: "未許可の検証プローブです。" };
  }

  const args = verification.arguments;
  const allowedExpected = new Set(["unstaged_tracked_file_is_included", "unstaged_tracked_file_is_excluded"]);
  const validArguments = Array.isArray(args) && args.length <= 10 && args.every((arg) =>
    typeof arg === "string" && arg.length > 0 && arg.length <= 256 &&
    !/[\0\r\n]/.test(arg) && (!arg.startsWith("-") || arg === "--cached"));
  if (!validArguments || !allowedExpected.has(verification.expected)) {
    return { verified: false, outcome: "inconclusive", summary: "検証引数または期待値が許可されていません。" };
  }

  try {
    const output = runner("git", ["ls-files", ...args]);
    const listed = lineSet(output);
    const patterns = args.filter((arg) => !arg.startsWith("-"));
    const relevantUnstaged = [...lineSet(runner("git", ["diff", "--name-only", "--", ...patterns]))];
    if (relevantUnstaged.length === 0) {
      return { verified: false, outcome: "inconclusive", summary: "期待値を確認できる未ステージ追跡ファイルがありません。" };
    }
    const includedFiles = relevantUnstaged.filter((file) => listed.has(file));
    const actualIncluded = includedFiles.length === relevantUnstaged.length;
    const expectedIncluded = verification.expected === "unstaged_tracked_file_is_included";
    const verified = actualIncluded === expectedIncluded;
    return {
      verified,
      outcome: verified ? "confirmed" : "contradicted",
      summary: actualIncluded
        ? `未ステージ追跡ファイルが列挙されました: ${includedFiles.slice(0, 5).join(", ")}`
        : "未ステージ追跡ファイルは列挙されませんでした。",
    };
  } catch (error) {
    return { verified: false, outcome: "inconclusive", summary: `検証プローブの実行に失敗しました: ${error.message}` };
  }
}

function lineSet(text) {
  return new Set(String(text).split("\n").map((line) => line.trim()).filter(Boolean));
}

export function buildDiffArgs(range) {
  return [
    "diff",
    "--unified=20",
    "--find-renames",
    "--diff-filter=ACDMRT",
    range,
    "--",
    ".",
    ...excludedDiffPathspecs,
  ];
}

export function shouldSkipReview(input) {
  return typeof input?.diff !== "string" || input.diff.trim().length === 0;
}

export async function collectPaginatedItems(loadPage) {
  const perPage = 100;
  const items = [];

  for (let page = 1; ; page += 1) {
    const batch = await loadPage(page, perPage);
    if (!Array.isArray(batch)) {
      throw new TypeError("ページ取得結果は配列である必要があります。");
    }

    items.push(...batch);
    if (batch.length < perPage) {
      return items;
    }
  }
}

export function listTrackedFiles(patterns) {
  try {
    return runGit(["ls-files", ...patterns])
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function renderVerificationLine(finding) {
  const summary = finding.verificationResult?.summary;
  switch (finding.verificationRelevance) {
    case "supports":
      return `確認済み: ${summary}`;
    case "contradicts":
      return `矛盾あり(通常は採用前に棄却されます): ${summary}`;
    case "inconclusive":
      return `実行不能(構造的理由のため未確認): ${summary}`;
    case "irrelevant":
      return `本指摘とは無関係のため未使用${summary ? `(参考: ${summary})` : ""}`;
    default:
      return "機械検証なし";
  }
}

export function buildReviewMarkdown(result) {
  const marker = "<!-- ai-review-bot -->";
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const skipped = result.status === "skipped";

  if (skipped) {
    return `${marker}
## AIレビュー

レビューはスキップされました。

理由: ${result.reason || "不明"}
`;
  }

  if (findings.length === 0) {
    return `${marker}
## AIレビュー

重大な指摘は見つかりませんでした。

対象: PR差分のみ
`;
  }

  const body = findings
    .map((finding, index) => {
      const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "場所未指定";
      return `${index + 1}. **${finding.severity}** ${finding.title}
   - 場所: \`${location}\`
   - 内容: ${finding.body}
   - 検証コマンド案: \`${finding.suggestedVerificationCommand || "なし"}\`
   - 機械検証: ${renderVerificationLine(finding)}
   - 実行経路: ${finding.executionPath}
   - 反証結果: ${finding.counterEvidence}`;
    })
    .join("\n\n");

  return `${marker}
## AIレビュー

${body}
`;
}

export function extractResponseText(data) {
  if (typeof data.output_text === "string") {
    return data.output_text;
  }

  const chunks = [];
  for (const output of data.output || []) {
    for (const content of output.content || []) {
      if (typeof content.text === "string") {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("\n");
}

const allowedSeverities = new Set(["critical", "high", "medium"]);

export function meetsEvidenceGate(finding) {
  return Boolean(
    finding &&
    finding.confidence === "high" &&
    allowedSeverities.has(finding.severity) &&
    typeof finding.file === "string" && finding.file.trim() &&
    Number.isInteger(finding.line) && finding.line > 0 &&
    typeof finding.title === "string" && finding.title.trim() &&
    typeof finding.body === "string" && finding.body.trim() &&
    typeof finding.suggestedVerificationCommand === "string" && finding.suggestedVerificationCommand.trim() &&
    typeof finding.executionPath === "string" && finding.executionPath.trim() &&
    typeof finding.counterEvidence === "string" && finding.counterEvidence.trim(),
  );
}

const GIT_TRACKING_RELEVANCE_PATTERN =
  /git\s*ls-files|追跡ファイル|未ステージ|ステージ済み|tracked file|untracked file|pathspec|\.gitignore|インデックスに登録/i;

export function verificationSupportsFinding(finding, verificationResult) {
  if (!verificationResult) return "no_verification";
  if (!finding.verification || finding.verification.probe !== "git_ls_files") return "irrelevant";
  const text = [finding.title, finding.body, finding.executionPath, finding.suggestedVerificationCommand]
    .filter(Boolean)
    .join(" ");
  if (!GIT_TRACKING_RELEVANCE_PATTERN.test(text)) return "irrelevant";
  if (verificationResult.outcome === "confirmed") return "supports";
  if (verificationResult.outcome === "contradicted") return "contradicts";
  return "inconclusive";
}

export function computeBuildSucceeded(deterministicChecks, { ownCheckNamePattern = /ai[\s_-]?review/i } = {}) {
  return (deterministicChecks || []).some((check) =>
    /build/i.test(check.name || "") &&
    check.conclusion === "success" &&
    !ownCheckNamePattern.test(check.name || ""));
}

export function parseReviewJson(text, context = {}) {
  const parsed = JSON.parse(text);
  const findings = Array.isArray(parsed.findings) ? parsed.findings : [];

  const evaluated = findings.map((finding) => {
    if (!meetsEvidenceGate(finding)) {
      return { finding, eligible: false, reason: "insufficient_evidence" };
    }

    let verificationResult = null;
    let verificationRelevance = "no_verification";
    if (finding.verification) {
      verificationResult = (context.verifyProbe || runVerificationProbe)(finding.verification);
      verificationRelevance = verificationSupportsFinding(finding, verificationResult);
    }

    if (verificationRelevance === "contradicts") {
      return { finding, eligible: false, reason: "verification_contradicted", verificationResult, verificationRelevance };
    }

    if (finding.category === "compilation_error" && context.buildSucceeded) {
      const hasReference = (context.deletedSymbolReferences || []).some(({ symbol }) =>
        finding.body?.includes(symbol) || finding.title?.includes(symbol));
      if (!hasReference) {
        return { finding, eligible: false, reason: "compilation_error_unconfirmed", verificationResult, verificationRelevance };
      }
    }

    return { finding, eligible: true, verificationResult, verificationRelevance };
  });

  let adoptedSoFar = 0;
  const candidates = evaluated.map((item) => {
    if (!item.eligible) {
      return {
        adopted: false,
        reason: item.reason,
        verificationRelevance: item.verificationRelevance || "no_verification",
        verificationResult: item.verificationResult || null,
        finding: item.finding,
      };
    }
    adoptedSoFar += 1;
    const adopted = adoptedSoFar <= 3;
    return {
      adopted,
      reason: adopted ? "adopted" : "adopted_but_capped_at_3",
      verificationRelevance: item.verificationRelevance,
      verificationResult: item.verificationResult,
      finding: item.finding,
    };
  });

  const findingsOut = candidates
    .filter((candidate) => candidate.reason === "adopted")
    .map((candidate) => ({
      ...candidate.finding,
      verificationResult: candidate.verificationResult,
      verificationRelevance: candidate.verificationRelevance,
    }));

  return {
    status: parsed.status || "completed",
    findings: findingsOut,
    diagnostics: {
      candidateCount: findings.length,
      adoptedCount: findingsOut.length,
      candidates: candidates.map((candidate, index) => ({ index, ...candidate })),
    },
  };
}

export const reviewResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "findings"],
  properties: {
    status: { type: "string", enum: ["completed"] },
    findings: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "confidence", "category", "file", "line", "title", "body", "suggestedVerificationCommand", "verification", "executionPath", "counterEvidence"],
        properties: {
          severity: { type: "string", enum: ["critical", "high", "medium"] },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          category: { type: "string", enum: ["compilation_error", "runtime_bug", "security", "data_loss", "test_gap"] },
          file: { type: "string" },
          line: { type: "integer", minimum: 1 },
          title: { type: "string" },
          body: { type: "string" },
          suggestedVerificationCommand: { type: "string" },
          verification: {
            type: ["object", "null"],
            additionalProperties: false,
            required: ["probe", "arguments", "expected"],
            properties: {
              probe: { type: "string", enum: ["git_ls_files"] },
              arguments: {
                type: "array",
                items: { type: "string" },
                maxItems: 10,
              },
              expected: {
                type: "string",
                enum: ["unstaged_tracked_file_is_included", "unstaged_tracked_file_is_excluded"],
              },
            },
          },
          executionPath: { type: "string" },
          counterEvidence: { type: "string" },
        },
      },
    },
  },
};
