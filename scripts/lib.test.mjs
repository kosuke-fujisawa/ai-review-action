import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildDiffArgs,
  buildReviewMarkdown,
  budgetDiffByFile,
  collectPaginatedItems,
  extractDeletedSymbols,
  parseReviewJson,
  runGit,
  runVerificationProbe,
  shouldSkipReview,
  truncateText,
  verificationSupportsFinding,
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
  assert.equal(result.fileStats.length, 2);
});

test("budgetDiffByFileはコード拡張子を低価値拡張子より優先して配分する", () => {
  const codeSection = "diff --git a/src/app.js b/src/app.js\n@@ -1 +1 @@\n-old\n+" + "code".repeat(200);
  const lowValueSection = "diff --git a/config/data.json b/config/data.json\n@@ -1 +1 @@\n-old\n+" + "data".repeat(200);
  const diff = [codeSection, lowValueSection].join("\n");

  const result = budgetDiffByFile(diff, 900);

  assert.equal(result.truncated, true);
  const codeStats = result.fileStats.find((stat) => stat.file === "src/app.js");
  const lowValueStats = result.fileStats.find((stat) => stat.file === "config/data.json");
  assert.equal(codeStats.tier, "code");
  assert.equal(lowValueStats.tier, "low_value");
  assert.ok(codeStats.keptChars > lowValueStats.keptChars);
});

test("budgetDiffByFileはファイル数が多い場合MIN_FILE_BUDGETの下限適用で合計がmaxCharsを大幅に超えないようにする", () => {
  const sections = Array.from({ length: 100 }, (_, index) =>
    `diff --git a/d/f${index}.json b/d/f${index}.json\n@@ -1 +1 @@\n-old\n+` + "x".repeat(500));
  const diff = sections.join("\n");

  const result = budgetDiffByFile(diff, 2000);

  assert.equal(result.truncated, true);
  const totalKept = result.fileStats.reduce((sum, stat) => sum + stat.keptChars, 0);
  // 下限(200文字)を全100ファイルへ適用すると20000文字を要求してしまうため、
  // 下限を諦めて比例配分のみに従うことでmaxChars近傍に収まることを確認する
  assert.ok(totalKept < 6000, `keptChars合計が予算に対して大きすぎます: ${totalKept}`);
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
  assert.equal(result.diagnostics.candidateCount, 0);
  assert.equal(result.diagnostics.adoptedCount, 0);
});

function baseFinding(overrides = {}) {
  return {
    severity: "high",
    confidence: "high",
    category: "runtime_bug",
    file: "src/example.js",
    line: 10,
    title: "既定値未設定によるnull参照",
    body: "入力が空のとき、config.valueがundefinedのままアクセスされ例外になります。",
    suggestedVerificationCommand: "node --test",
    executionPath: "APIハンドラがconfig.valueへ直接アクセスする",
    counterEvidence: "デフォルト値の代入は他の分岐にも存在しないため回避されない",
    ...overrides,
  };
}

test("parseReviewJsonは高確信度の重大指摘だけを最大3件残す", () => {
  const verification = { probe: "git_ls_files", arguments: ["--cached", "*.swift"], expected: "unstaged_tracked_file_is_included" };
  const findings = [
    ...Array.from({ length: 6 }, (_, index) =>
      baseFinding({ severity: "medium", line: index + 1, title: `指摘${index + 1}`, verification })),
    baseFinding({ severity: "high", confidence: "medium", title: "確信度不足", verification }),
    baseFinding({ severity: "low", title: "軽微な指摘", verification }),
  ];

  const result = parseReviewJson(JSON.stringify({ status: "completed", findings }), {
    verifyProbe: () => ({ verified: true, outcome: "confirmed", summary: "期待値と一致" }),
  });

  assert.equal(result.findings.length, 3);
  assert.ok(result.findings.every((finding) => finding.confidence === "high"));
  assert.ok(result.findings.every((finding) => finding.severity === "medium"));
  assert.equal(result.diagnostics.candidateCount, 8);
  assert.equal(result.diagnostics.adoptedCount, 3);
  assert.ok(result.diagnostics.candidates.some((candidate) => candidate.reason === "adopted_but_capped_at_3"));
});

test("parseReviewJsonは根拠不足とBuild成功に反するコンパイルエラーを棄却する", () => {
  const verification = { probe: "git_ls_files", arguments: ["--cached"], expected: "unstaged_tracked_file_is_included" };
  const base = baseFinding({
    category: "compilation_error",
    title: "削除型への参照",
    body: "コンパイルできません。",
    suggestedVerificationCommand: "git grep -n -w LegacyStore HEAD",
    executionPath: "AppからLegacyStoreを生成する",
    counterEvidence: "Build成功を確認済み",
    verification,
  });
  const result = parseReviewJson(JSON.stringify({
    status: "completed",
    findings: [base, { ...base, title: "場所なし", line: null }],
  }), {
    buildSucceeded: true,
    deletedSymbolReferences: [],
    verifyProbe: () => ({ verified: true, outcome: "confirmed" }),
  });

  assert.deepEqual(result.findings, []);
  assert.equal(result.diagnostics.candidates[0].reason, "compilation_error_unconfirmed");
  assert.equal(result.diagnostics.candidates[1].reason, "insufficient_evidence");
});

test("parseReviewJsonは検証なしでも根拠十分な高確信度指摘を採用する", () => {
  const finding = baseFinding({ verification: null });

  const result = parseReviewJson(JSON.stringify({ status: "completed", findings: [finding] }));

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].verificationRelevance, "no_verification");
  assert.equal(result.findings[0].verificationResult, null);
  assert.equal(result.diagnostics.candidates[0].reason, "adopted");
});

test("parseReviewJsonは検証なしのsecurity・data_loss・test_gap指摘も根拠十分なら採用する", () => {
  const findings = [
    baseFinding({
      category: "security", title: "認可チェック漏れ", line: 20,
      body: "管理者用エンドポイントでロール確認をせずデータを返します。",
      executionPath: "一般ユーザーが/admin/usersへ直接リクエストする",
      counterEvidence: "上位ミドルウェアでの権限チェックは存在しない",
    }),
    baseFinding({
      category: "data_loss", title: "上書き保存で旧データが消える", line: 35,
      body: "保存処理がファイルをtruncateしてから書き込むため、書き込み失敗時に元データが失われます。",
      executionPath: "保存APIが大きなファイルを書き込み中にプロセスが停止する",
      counterEvidence: "一時ファイル経由のatomic writeは実装されていない",
    }),
    baseFinding({
      category: "test_gap", title: "境界値のテストが存在しない", line: 5,
      body: "上限ちょうどの入力に対するテストがなく、off-by-oneが検出できません。",
      executionPath: "上限値ちょうどのリクエストを送る",
      counterEvidence: "既存テストは上限未満の値しか使っていない",
    }),
  ];

  const result = parseReviewJson(JSON.stringify({ status: "completed", findings }));

  assert.equal(result.findings.length, 3);
  assert.deepEqual(result.findings.map((finding) => finding.category), ["security", "data_loss", "test_gap"]);
});

test("parseReviewJsonはconfidenceがlowまたはmediumの指摘を棄却する", () => {
  const findings = [
    baseFinding({ confidence: "low", title: "確信度low" }),
    baseFinding({ confidence: "medium", title: "確信度medium" }),
  ];

  const result = parseReviewJson(JSON.stringify({ status: "completed", findings }));

  assert.deepEqual(result.findings, []);
  assert.ok(result.diagnostics.candidates.every((candidate) => candidate.reason === "insufficient_evidence"));
});

test("parseReviewJsonはfile・line・executionPath・counterEvidenceが欠けた指摘を棄却する", () => {
  const cases = [
    baseFinding({ file: "" }),
    baseFinding({ line: null }),
    baseFinding({ line: 0 }),
    baseFinding({ executionPath: "" }),
    baseFinding({ counterEvidence: "" }),
    baseFinding({ title: "" }),
    baseFinding({ body: "" }),
  ];

  const result = parseReviewJson(JSON.stringify({ status: "completed", findings: cases }));

  assert.deepEqual(result.findings, []);
  assert.equal(result.diagnostics.candidateCount, cases.length);
  assert.ok(result.diagnostics.candidates.every((candidate) => candidate.reason === "insufficient_evidence"));
});

test("parseReviewJsonはchangedFilesに含まれないファイルへの指摘を棄却する", () => {
  const finding = baseFinding({ file: "src/not-in-diff.js" });

  const result = parseReviewJson(JSON.stringify({ status: "completed", findings: [finding] }), {
    changedFiles: ["src/other.js", "src/another.js"],
  });

  assert.deepEqual(result.findings, []);
  assert.equal(result.diagnostics.candidates[0].reason, "file_not_in_diff");
});

test("parseReviewJsonはchangedFilesに含まれるファイルへの指摘を採用する", () => {
  const finding = baseFinding({ file: "src/example.js" });

  const result = parseReviewJson(JSON.stringify({ status: "completed", findings: [finding] }), {
    changedFiles: ["src/example.js", "src/other.js"],
  });

  assert.equal(result.findings.length, 1);
});

test("parseReviewJsonはchangedFilesが渡されない場合ファイル照合をスキップする(後方互換)", () => {
  const finding = baseFinding({ file: "src/anything.js" });

  const result = parseReviewJson(JSON.stringify({ status: "completed", findings: [finding] }));

  assert.equal(result.findings.length, 1);
});

test("parseReviewJsonは無関係なgit_ls_filesプローブを根拠として扱わない", () => {
  const finding = baseFinding({
    title: "非同期処理の競合状態",
    body: "並列リクエストでカウンタがロックなしに更新され、値がずれます。",
    verification: { probe: "git_ls_files", arguments: ["--cached", "*.js"], expected: "unstaged_tracked_file_is_included" },
  });

  const result = parseReviewJson(JSON.stringify({ status: "completed", findings: [finding] }), {
    verifyProbe: () => ({ verified: true, outcome: "confirmed", summary: "無関係な結果" }),
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].verificationRelevance, "irrelevant");
});

test("parseReviewJsonはプローブ結果が期待と矛盾する指摘を棄却する", () => {
  const finding = baseFinding({
    title: "追跡ファイル一覧の誤り",
    body: "git ls-filesの未ステージ追跡ファイル列挙が期待と異なります。",
    suggestedVerificationCommand: "git ls-files --cached '*.swift'",
    verification: { probe: "git_ls_files", arguments: ["--cached", "*.swift"], expected: "unstaged_tracked_file_is_excluded" },
  });

  const result = parseReviewJson(JSON.stringify({ status: "completed", findings: [finding] }), {
    verifyProbe: () => ({ verified: false, outcome: "contradicted", summary: "未ステージ追跡ファイルも列挙された" }),
  });

  assert.deepEqual(result.findings, []);
  assert.equal(result.diagnostics.candidates[0].reason, "verification_contradicted");
});

test("parseReviewJsonからbuildReviewMarkdownまで通しで通常のruntime bugがコメントに掲載される", () => {
  const finding = baseFinding({ verification: null });
  const parsed = parseReviewJson(JSON.stringify({ status: "completed", findings: [finding] }));
  const markdown = buildReviewMarkdown(parsed);

  assert.match(markdown, /既定値未設定によるnull参照/);
  assert.match(markdown, /機械検証なし/);
});

test("0件の場合モデル起因か後処理フィルタ起因かをdiagnosticsから判別できる", () => {
  const modelReturnedNone = parseReviewJson(JSON.stringify({ status: "completed", findings: [] }));
  assert.equal(modelReturnedNone.diagnostics.candidateCount, 0);
  assert.equal(modelReturnedNone.diagnostics.adoptedCount, 0);

  const filteredToZero = parseReviewJson(JSON.stringify({
    status: "completed",
    findings: [baseFinding({ confidence: "low" }), baseFinding({ file: "" })],
  }));
  assert.equal(filteredToZero.diagnostics.candidateCount, 2);
  assert.equal(filteredToZero.diagnostics.adoptedCount, 0);
  assert.ok(filteredToZero.diagnostics.candidates.every((candidate) => candidate.reason === "insufficient_evidence"));
});

test("verificationSupportsFindingはverificationResultがない場合no_verificationを返す", () => {
  assert.equal(verificationSupportsFinding({ verification: null }, null), "no_verification");
});

test("verificationSupportsFindingはgit_ls_files以外のprobeをirrelevantとして扱う", () => {
  const relevance = verificationSupportsFinding(
    { verification: { probe: "other" } },
    { outcome: "confirmed" },
  );
  assert.equal(relevance, "irrelevant");
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
  assert.equal(result.outcome, "confirmed");
});

test("runVerificationProbeはgit_ls_filesの実結果が除外期待に反すれば失敗する", () => {
  const outputs = ["Sources/App.swift\n", "Sources/App.swift\n"];
  const result = runVerificationProbe(
    { probe: "git_ls_files", arguments: ["--cached", "*.swift"], expected: "unstaged_tracked_file_is_excluded" },
    () => outputs.shift(),
  );

  assert.equal(result.verified, false);
  assert.equal(result.outcome, "contradicted");
  assert.match(result.summary, /列挙されました/);
});

test("runVerificationProbeは対象となる未ステージ追跡ファイルがない場合inconclusiveを返す", () => {
  const outputs = ["Sources/App.swift\n", ""];
  const result = runVerificationProbe(
    { probe: "git_ls_files", arguments: ["--cached", "*.swift"], expected: "unstaged_tracked_file_is_included" },
    () => outputs.shift(),
  );

  assert.equal(result.verified, false);
  assert.equal(result.outcome, "inconclusive");
});

test("runVerificationProbeは未許可オプションや未知の期待値を実行しない", () => {
  let executed = false;
  const runner = () => { executed = true; return ""; };

  assert.equal(runVerificationProbe({ probe: "git_ls_files", arguments: ["--exec=echo"], expected: "unstaged_tracked_file_is_included" }, runner).verified, false);
  assert.equal(runVerificationProbe({ probe: "git_ls_files", arguments: ["--cached"], expected: "arbitrary_claim" }, runner).verified, false);
  assert.equal(runVerificationProbe({ probe: "git_ls_files", arguments: Array(11).fill("*.swift"), expected: "unstaged_tracked_file_is_included" }, runner).verified, false);
  assert.equal(executed, false);
});

test("runGitはNodeデフォルトのmaxBuffer(1MiB)を超えるdiffでも取得できる", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "ai-review-large-diff-"));
  const cwd = process.cwd();
  try {
    process.chdir(repoDir);
    const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
    git("init", "-q");
    git("-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "--allow-empty", "-m", "init");
    // 2MiB超の追加行を持つdiffを作る(エンジン同梱PR相当)
    writeFileSync("big.js", "const line = 1;\n".repeat(140_000));
    git("add", "big.js");

    const diff = runGit(["diff", "--cached"]);

    assert.ok(diff.length > 1024 * 1024);
    assert.match(diff, /^diff --git a\/big\.js b\/big\.js/m);
  } finally {
    process.chdir(cwd);
    rmSync(repoDir, { recursive: true, force: true });
  }
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
  assert.ok(args.includes(":(exclude,glob)**/*.uid"));
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
