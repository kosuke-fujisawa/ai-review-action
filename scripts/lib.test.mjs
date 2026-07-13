import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDiffArgs,
  buildReviewMarkdown,
  budgetDiffByFile,
  collectPaginatedItems,
  extractDeletedSymbols,
  parseReviewJson,
  runVerificationProbe,
  shouldSkipReview,
  truncateText,
} from "./lib.mjs";

test("budgetDiffByFileは全変更ファイルを残してファイル単位で切り詰める", () => {
  const diff = [
    "diff --git a/src/first.swift b/src/first.swift\n@@ -1 +1 @@\n-old\n+" + "new".repeat(40),
    "diff --git a/src/second.swift b/src/second.swift\n@@ -1 +1 @@\n-old\n+" + "next".repeat(40),
  ].join("\n");

  const result = budgetDiffByFile(diff, 180);

  assert.equal(result.truncated, true);
  assert.match(result.text, /first\.swift/);
  assert.match(result.text, /second\.swift/);
  assert.equal(result.files.length, 2);
});

test("extractDeletedSymbolsは削除された型とメソッドを抽出する", () => {
  const diff = `diff --git a/A.swift b/A.swift\n--- a/A.swift\n+++ b/A.swift\n-class LegacyStore {\n-  func loadLegacy() {}\n+class Store {}`;

  assert.deepEqual(extractDeletedSymbols(diff), ["LegacyStore", "loadLegacy"]);
});

test("truncateTextは上限を超えた文字列を切り詰める", () => {
  const result = truncateText("abcdef", 3);

  assert.equal(result.truncated, true);
  assert.match(result.text, /^abc/);
  assert.match(result.text, /truncated: 3 chars omitted/);
});

test("buildReviewMarkdownは指摘なしのコメントを生成する", () => {
  const markdown = buildReviewMarkdown({ status: "completed", findings: [] });

  assert.match(markdown, /<!-- ai-review-bot -->/);
  assert.match(markdown, /重大な指摘は見つかりませんでした/);
});

test("parseReviewJsonはfindingsがない場合に空配列へ正規化する", () => {
  const result = parseReviewJson('{"status":"completed"}');

  assert.equal(result.status, "completed");
  assert.deepEqual(result.findings, []);
});

test("parseReviewJsonは高確信度の重大指摘だけを最大3件残す", () => {
  const findings = [
    ...Array.from({ length: 6 }, (_, index) => ({
      severity: "medium",
      confidence: "high",
      file: "src/example.js",
      line: index + 1,
      title: `指摘${index + 1}`,
      body: "git ls-filesが未ステージの追跡ファイルを列挙します。",
      category: "runtime_bug",
      suggestedVerificationCommand: "git ls-files --cached '*.swift'",
      verification: { probe: "git_ls_files", arguments: ["--cached", "*.swift"], expected: "unstaged_tracked_file_is_included" },
      executionPath: "レビュー処理がgit ls-files --cachedの出力をステージ済み変更として扱う",
      counterEvidence: "正常系テストでは反証されない",
    })),
    {
      severity: "high",
      confidence: "medium",
      file: "src/uncertain.js",
      line: 1,
      title: "確信度不足",
      body: "推測を含みます。",
      category: "runtime_bug",
      suggestedVerificationCommand: "node --test",
      verification: { probe: "git_ls_files", arguments: ["--cached"], expected: "unstaged_tracked_file_is_included" },
      executionPath: "実行経路",
      counterEvidence: "反証結果",
    },
    {
      severity: "low",
      confidence: "high",
      file: "src/style.js",
      line: 1,
      title: "軽微な指摘",
      body: "動作には影響しません。",
      category: "runtime_bug",
      suggestedVerificationCommand: "node --test",
      verification: { probe: "git_ls_files", arguments: ["--cached"], expected: "unstaged_tracked_file_is_included" },
      executionPath: "実行経路",
      counterEvidence: "反証結果",
    },
  ];

  const result = parseReviewJson(JSON.stringify({ status: "completed", findings }), {
    verifyProbe: () => ({ verified: true, summary: "期待値と一致" }),
  });

  assert.equal(result.findings.length, 3);
  assert.ok(result.findings.every((finding) => finding.confidence === "high"));
  assert.ok(result.findings.every((finding) => finding.severity === "medium"));
});

test("parseReviewJsonは根拠不足とBuild成功に反するコンパイルエラーを棄却する", () => {
  const base = {
    severity: "high",
    confidence: "high",
    file: "Sources/App.swift",
    line: 10,
    title: "削除型への参照",
    body: "コンパイルできません。",
    category: "compilation_error",
    suggestedVerificationCommand: "git grep -n -w LegacyStore HEAD",
    verification: { probe: "git_ls_files", arguments: ["--cached"], expected: "unstaged_tracked_file_is_included" },
    executionPath: "AppからLegacyStoreを生成する",
    counterEvidence: "Build成功を確認済み",
  };
  const result = parseReviewJson(JSON.stringify({
    status: "completed",
    findings: [base, { ...base, title: "場所なし", line: null }],
  }), { buildSucceeded: true, deletedSymbolReferences: [], verifyProbe: () => ({ verified: true }) });

  assert.deepEqual(result.findings, []);
});

test("parseReviewJsonは未実行の提案コマンドだけの指摘を棄却する", () => {
  const finding = {
    severity: "high", confidence: "high", category: "runtime_bug",
    file: "scripts/review.mjs", line: 1, title: "誤検知", body: "問題です。",
    suggestedVerificationCommand: "git ls-files --cached '*.swift'",
    executionPath: "レビュー実行時", counterEvidence: "反証なし",
  };

  const result = parseReviewJson(JSON.stringify({ status: "completed", findings: [finding] }));

  assert.deepEqual(result.findings, []);
});

test("parseReviewJsonは指摘内容と無関係な検証プローブを棄却する", () => {
  const finding = {
    severity: "high", confidence: "high", category: "runtime_bug",
    file: "Sources/JournalEntry.swift", line: 12,
    title: "SwiftDataの一意制約で保存に失敗する",
    body: "同じ日の記録を保存すると一意制約違反になります。",
    suggestedVerificationCommand: "xcodebuild test -scheme Ambit",
    verification: { probe: "git_ls_files", arguments: ["--cached", "*.swift"], expected: "unstaged_tracked_file_is_included" },
    executionPath: "同じ日付のJournalEntryをModelContextへinsertしてsaveする",
    counterEvidence: "保存テストは未確認",
  };

  const result = parseReviewJson(JSON.stringify({ status: "completed", findings: [finding] }), {
    verifyProbe: () => ({ verified: true, summary: "未ステージ追跡ファイルが列挙された" }),
  });

  assert.deepEqual(result.findings, []);
});

test("parseReviewJsonはプローブ結果が期待と不一致の指摘を棄却する", () => {
  const finding = {
    severity: "high", confidence: "high", category: "runtime_bug",
    file: "scripts/review.mjs", line: 1, title: "誤検知", body: "問題です。",
    suggestedVerificationCommand: "git ls-files --cached '*.swift'",
    verification: { probe: "git_ls_files", arguments: ["--cached", "*.swift"], expected: "unstaged_tracked_file_is_excluded" },
    executionPath: "レビュー実行時", counterEvidence: "反証なし",
  };

  const result = parseReviewJson(JSON.stringify({ status: "completed", findings: [finding] }), {
    verifyProbe: () => ({ verified: false, summary: "未ステージ追跡ファイルも列挙された" }),
  });

  assert.deepEqual(result.findings, []);
});

test("runVerificationProbeはgit_ls_filesをシェルなしで実行して未ステージ追跡ファイルを照合する", () => {
  const calls = [];
  const outputs = ["Sources/App.swift\n", "Sources/App.swift\n"];
  const result = runVerificationProbe(
    { probe: "git_ls_files", arguments: ["--cached", "*.swift"], expected: "unstaged_tracked_file_is_included" },
    (file, args) => { calls.push([file, args]); return outputs.shift(); },
  );

  assert.deepEqual(calls, [
    ["git", ["ls-files", "--cached", "*.swift"]],
    ["git", ["diff", "--name-only", "--", "*.swift"]],
  ]);
  assert.equal(result.verified, true);
});

test("runVerificationProbeはgit_ls_filesの実結果が除外期待に反すれば失敗する", () => {
  const outputs = ["Sources/App.swift\n", "Sources/App.swift\n"];
  const result = runVerificationProbe(
    { probe: "git_ls_files", arguments: ["--cached", "*.swift"], expected: "unstaged_tracked_file_is_excluded" },
    () => outputs.shift(),
  );

  assert.equal(result.verified, false);
  assert.match(result.summary, /列挙されました/);
});

test("runVerificationProbeは未許可オプションや未知の期待値を実行しない", () => {
  let executed = false;
  const runner = () => { executed = true; return ""; };

  assert.equal(runVerificationProbe({ probe: "git_ls_files", arguments: ["--exec=echo"], expected: "unstaged_tracked_file_is_included" }, runner).verified, false);
  assert.equal(runVerificationProbe({ probe: "git_ls_files", arguments: ["--cached"], expected: "arbitrary_claim" }, runner).verified, false);
  assert.equal(runVerificationProbe({ probe: "git_ls_files", arguments: Array(11).fill("*.swift"), expected: "unstaged_tracked_file_is_included" }, runner).verified, false);
  assert.equal(executed, false);
});

test("buildDiffArgsは少ない文脈で自動生成物と文書を除外する", () => {
  const args = buildDiffArgs("origin/main...HEAD");

  assert.ok(args.includes("--unified=20"));
  assert.ok(args.includes("--diff-filter=ACDMRT"));
  assert.ok(args.includes("origin/main...HEAD"));
  assert.ok(args.includes(":(exclude,glob)**/*.md"));
  assert.ok(args.includes(":(exclude,glob)**/package-lock.json"));
  assert.ok(args.includes(":(exclude,glob)**/dist/**"));
  assert.ok(args.includes(":(exclude,glob)**/*.png"));
  assert.ok(args.includes(":(exclude,glob)scripts/ai-review/**"));
});

test("shouldSkipReviewは対象diffが空の場合だけスキップする", () => {
  assert.equal(shouldSkipReview({ diff: "\n  " }), true);
  assert.equal(shouldSkipReview({ diff: "+const enabled = true;" }), false);
});

test("collectPaginatedItemsは100件未満のページまで全件を取得する", async () => {
  const requestedPages = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => index);
  const secondPage = [100, 101];

  const items = await collectPaginatedItems(async (page) => {
    requestedPages.push(page);
    return page === 1 ? firstPage : secondPage;
  });

  assert.deepEqual(requestedPages, [1, 2]);
  assert.equal(items.length, 102);
  assert.equal(items.at(-1), 101);
});
