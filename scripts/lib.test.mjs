import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDiffArgs,
  buildReviewMarkdown,
  budgetDiffByFile,
  collectPaginatedItems,
  extractDeletedSymbols,
  parseReviewJson,
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
      body: "再現可能な問題です。",
      category: "runtime_bug",
      verificationCommand: "node --test",
      executionPath: "入力から対象処理へ到達する",
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
      verificationCommand: "node --test",
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
      verificationCommand: "node --test",
      executionPath: "実行経路",
      counterEvidence: "反証結果",
    },
  ];

  const result = parseReviewJson(JSON.stringify({ status: "completed", findings }));

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
    verificationCommand: "git grep -n -w LegacyStore HEAD",
    executionPath: "AppからLegacyStoreを生成する",
    counterEvidence: "Build成功を確認済み",
  };
  const result = parseReviewJson(JSON.stringify({
    status: "completed",
    findings: [base, { ...base, title: "場所なし", line: null }],
  }), { buildSucceeded: true, deletedSymbolReferences: [] });

  assert.deepEqual(result.findings, []);
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
