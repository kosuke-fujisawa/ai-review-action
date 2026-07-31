import { writeFileSync } from "node:fs";
import {
  buildReviewMarkdown,
  commentPath,
  computeBuildSucceeded,
  diagnosticsPath,
  extractResponseText,
  inputPath,
  parseReviewJson,
  readJson,
  resultPath,
  reviewResponseSchema,
  shouldSkipReview,
  writeJson,
} from "./lib.mjs";

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.AI_REVIEW_MODEL || "gpt-5-mini";
const input = readJson(inputPath);

function writeEmptyDiagnostics(reason) {
  writeJson(diagnosticsPath, {
    model,
    requestedAt: new Date().toISOString(),
    skippedReason: reason,
    openai: null,
    diff: {
      truncated: Boolean(input.diffTruncated),
      fileCount: (input.changedFiles || []).length,
      files: input.diffStats || [],
    },
    review: { candidateCount: 0, adoptedCount: 0, candidates: [] },
  });
}

if (shouldSkipReview(input)) {
  const result = {
    status: "skipped",
    reason: "レビュー対象のコードまたは設定差分がありません。",
    findings: [],
  };
  writeJson(resultPath, result);
  writeFileSync(commentPath, buildReviewMarkdown(result));
  writeEmptyDiagnostics(result.reason);
  process.exit(0);
}

if (!apiKey) {
  const result = {
    status: "skipped",
    reason: "OPENAI_API_KEY が設定されていません。Repository secrets に OPENAI_API_KEY を追加してください。",
    findings: [],
  };
  writeJson(resultPath, result);
  writeFileSync(commentPath, buildReviewMarkdown(result));
  writeEmptyDiagnostics(result.reason);
  process.exit(0);
}

const systemPrompt = `あなたはGitHub Pull Requestの自動レビュアーです。
日本語で回答してください。
PR差分に直接関係する、再現性のある指摘だけを返してください。
重大なバグ、セキュリティ、データ破壊、テスト不足を優先してください。
各指摘には、問題を起こす具体的な入力または実行経路と、観測可能な影響が必要です。
指摘を返す前に反証を試み、正常に動作する合理的な可能性が残る場合は指摘しないでください。
設定、権限、外部API、ライブラリの仕様を差分だけで確認できない場合は推測せず、指摘を省略してください。
CLI、Git、ライブラリのオプションの意味を名称から推測することは禁止します。公式仕様または入力済みの実行結果で確認できない場合は指摘しないでください。
suggestedVerificationCommandは未実行の提案であり、その結果を観測した、確認した、再現したとは書かないでください。
verificationは任意です。差分だけから確信度high・具体的な実行経路・観測可能な影響・反証結果を示せる指摘は、verification:nullのまま返して構いません。verificationを付与する場合は、Actionが実行できる構造化プローブ(現在はgit_ls_filesのみ)に限り、未実行の任意コマンドを実行済みであるかのように書かないでください。
git ls-files --cachedはステージ済み変更だけでなく、インデックスに登録された全追跡ファイルを列挙します。
git_ls_filesプローブは、gitが追跡・列挙するファイル集合そのものに関する指摘にのみ根拠として使ってください。それ以外の種類の指摘(実行時バグ、セキュリティ、データ損失、テスト不足など)に、無関係な根拠としてgit_ls_filesを付けないでください。
意図的な入力上限、タイムアウト、レビュー範囲の縮小は運用上の制約であり、それ自体を不具合として指摘しないでください。
「問題が起きる可能性がある」というリスクだけでは指摘せず、対応する具体的な入力で不正な結果が確実に発生する場合だけ指摘してください。
「参照が残っている場合」のような条件付きコンパイルエラー指摘は禁止します。実在する参照ファイルと行番号を提示できない場合は返さないでください。
Build成功時、残存参照が機械検索で確認されていないコンパイルエラー指摘は返さないでください。
確信度が低い指摘、低重要度の指摘、好みのスタイル指摘、差分外の設計論は返さないでください。`;

const userPrompt = `以下のPR差分をレビューしてください。

## レビュー方針
${input.reviewInstructions}

## AGENTS.md
${input.agentInstructions.map((item) => `### ${item.file}\n${item.content}`).join("\n\n")}

## PR情報
${JSON.stringify(input.pullRequest, null, 2)}

## 注意
diffTruncated=${input.diffTruncated}
verificationは任意です。差分から直接確認できる指摘はverification:nullで返してください。
指摘は最大3件です。タイトルと本文は簡潔にしてください。
省略されたファイル(上位10件): ${JSON.stringify((input.diffStats || []).filter((file) => file.omittedChars > 0).slice(0, 10))}

## Deterministic checks
${JSON.stringify(input.deterministicChecks || [], null, 2)}

## 削除シンボルのHEAD検索結果
${JSON.stringify(input.deletedSymbolReferences || [], null, 2)}

## Diff
\`\`\`diff
${input.diff}
\`\`\``;

const response = await fetch("https://api.openai.com/v1/responses", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  signal: AbortSignal.timeout(90_000),
  body: JSON.stringify({
    model,
    input: [
      { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
      { role: "user", content: [{ type: "input_text", text: userPrompt }] },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "review_result",
        schema: reviewResponseSchema,
        strict: true,
      },
    },
  }),
});

const data = await response.json();
if (!response.ok) {
  throw new Error(`OpenAI API error: ${response.status} ${JSON.stringify(data)}`);
}

const buildSucceeded = computeBuildSucceeded(input.deterministicChecks);
const parsed = parseReviewJson(extractResponseText(data), {
  buildSucceeded,
  deletedSymbolReferences: input.deletedSymbolReferences || [],
  changedFiles: input.changedFiles || [],
});
const { diagnostics, ...result } = parsed;

writeJson(resultPath, result);
writeFileSync(commentPath, buildReviewMarkdown(result));
writeJson(diagnosticsPath, {
  model,
  requestedAt: new Date().toISOString(),
  openai: { status: response.status, id: data.id || null, usage: data.usage || null },
  diff: {
    truncated: Boolean(input.diffTruncated),
    fileCount: (input.changedFiles || []).length,
    files: input.diffStats || [],
  },
  review: diagnostics,
});
