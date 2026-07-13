import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const outputDir = "tmp/ai-review";
export const inputPath = `${outputDir}/input.json`;
export const resultPath = `${outputDir}/result.json`;
export const commentPath = `${outputDir}/comment.md`;

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

export function budgetDiffByFile(diff, maxChars) {
  const sections = diff.split(/(?=^diff --git )/m).filter((section) => section.trim());
  if (sections.length === 0 || diff.length <= maxChars) {
    return { text: diff, truncated: false, files: sections.map(diffFileName) };
  }

  const perFileBudget = Math.max(120, Math.floor(maxChars / sections.length));
  const rendered = sections.map((section) => {
    if (section.length <= perFileBudget) return section;
    const headerEnd = section.indexOf("\n");
    const header = headerEnd >= 0 ? section.slice(0, headerEnd + 1) : section;
    const bodyBudget = Math.max(0, perFileBudget - header.length - 40);
    return `${header}${section.slice(header.length, header.length + bodyBudget)}\n[truncated within file]\n`;
  });
  return { text: rendered.join("\n"), truncated: true, files: sections.map(diffFileName) };
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
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function runFile(file, args) {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function runVerificationProbe(verification, runner = runFile) {
  if (!verification || verification.probe !== "git_ls_files") {
    return { verified: false, summary: "未許可の検証プローブです。" };
  }

  const args = verification.arguments;
  const allowedExpected = new Set(["unstaged_tracked_file_is_included", "unstaged_tracked_file_is_excluded"]);
  const validArguments = Array.isArray(args) && args.length <= 10 && args.every((arg) =>
    typeof arg === "string" && arg.length > 0 && arg.length <= 256 &&
    !/[\0\r\n]/.test(arg) && (!arg.startsWith("-") || arg === "--cached"));
  if (!validArguments || !allowedExpected.has(verification.expected)) {
    return { verified: false, summary: "検証引数または期待値が許可されていません。" };
  }

  try {
    const output = runner("git", ["ls-files", ...args]);
    const listed = lineSet(output);
    const patterns = args.filter((arg) => !arg.startsWith("-"));
    const relevantUnstaged = [...lineSet(runner("git", ["diff", "--name-only", "--", ...patterns]))];
    if (relevantUnstaged.length === 0) {
      return { verified: false, summary: "期待値を確認できる未ステージ追跡ファイルがありません。" };
    }
    const includedFiles = relevantUnstaged.filter((file) => listed.has(file));
    const actualIncluded = includedFiles.length === relevantUnstaged.length;
    const expectedIncluded = verification.expected === "unstaged_tracked_file_is_included";
    return {
      verified: actualIncluded === expectedIncluded,
      summary: actualIncluded
        ? `未ステージ追跡ファイルが列挙されました: ${includedFiles.slice(0, 5).join(", ")}`
        : "未ステージ追跡ファイルは列挙されませんでした。",
    };
  } catch (error) {
    return { verified: false, summary: `検証プローブの実行に失敗しました: ${error.message}` };
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
   - 機械検証: ${finding.verificationResult?.summary || "確認なし"}
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

export function verificationSupportsFinding(finding) {
  if (!finding?.verification || typeof finding.verification !== "object") {
    return false;
  }

  if (finding.verification.probe === "git_ls_files") {
    const command = finding.suggestedVerificationCommand?.trim() || "";
    const claim = [finding.title, finding.body, finding.executionPath]
      .filter((value) => typeof value === "string")
      .join("\n");

    return /^git\s+ls-files(?:\s|$)/i.test(command) && /git\s+ls-files/i.test(claim);
  }

  return false;
}

export function parseReviewJson(text, context = {}) {
  const parsed = JSON.parse(text);
  const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const allowedSeverities = new Set(["critical", "high", "medium"]);

  return {
    status: parsed.status || "completed",
    findings: findings
      .map((finding) => {
        const verified =
          finding &&
          finding.confidence === "high" &&
          allowedSeverities.has(finding.severity) &&
          typeof finding.file === "string" && finding.file.length > 0 &&
          Number.isInteger(finding.line) && finding.line > 0 &&
          typeof finding.suggestedVerificationCommand === "string" && finding.suggestedVerificationCommand.length > 0 &&
          finding.verification && typeof finding.verification === "object" &&
          typeof finding.executionPath === "string" && finding.executionPath.length > 0 &&
          typeof finding.counterEvidence === "string" && finding.counterEvidence.length > 0;
        if (!verified) return null;
        if (!verificationSupportsFinding(finding)) return null;
        const verificationResult = (context.verifyProbe || runVerificationProbe)(finding.verification);
        if (!verificationResult?.verified) return null;
        if (finding.category === "compilation_error" && context.buildSucceeded) {
          const hasReference = (context.deletedSymbolReferences || []).some(({ symbol }) =>
            finding.body?.includes(symbol) || finding.title?.includes(symbol));
          if (!hasReference) return null;
        }
        return { ...finding, verificationResult };
      })
      .filter(Boolean)
      .slice(0, 3),
  };
}
