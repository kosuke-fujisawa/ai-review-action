import assert from "node:assert/strict";
import test from "node:test";

import {
  formatBenchmarkReport,
  formatFilterEffectivenessReport,
  scoreBenchmark,
  scoreFilterEffectiveness,
} from "./lib.mjs";

const manifest = {
  version: 1,
  cases: [
    {
      id: "known-regressions",
      expectedFindings: [
        { id: "file-scope", title: "非差分ファイルを採用する" },
        { id: "budget-overflow", title: "配分が上限を超える" },
        { id: "strict-schema", title: "未対応JSON Schema制約" },
      ],
    },
    { id: "clean-fix", expectedFindings: [] },
  ],
};

test("全既知問題を重複なく検出したエンジンは完全なスコアになる", () => {
  // 【テスト目的】: 比較の基本指標が既知問題との一対一対応から正しく計算されることを確認する。
  // 🟢 信頼性レベル: 比較要件の正常系に直接対応する。
  const results = {
    runs: [
      {
        engine: "candidate",
        caseId: "known-regressions",
        status: "completed",
        durationMs: 1200,
        findings: [
          { title: "file", matchedExpectedIds: ["file-scope"] },
          { title: "budget", matchedExpectedIds: ["budget-overflow"] },
          { title: "schema", matchedExpectedIds: ["strict-schema"] },
        ],
      },
      {
        engine: "candidate",
        caseId: "clean-fix",
        status: "completed",
        durationMs: 800,
        findings: [],
      },
    ],
  };

  const score = scoreBenchmark(manifest, results);
  const engine = score.engines.candidate;

  assert.equal(engine.truePositives, 3); // 【確認内容】: 3件の既知問題がすべて検出される。
  assert.equal(engine.falsePositives, 0); // 【確認内容】: 重複・未一致指摘がない。
  assert.equal(engine.falseNegatives, 0); // 【確認内容】: 見逃しがない。
  assert.equal(engine.precision, 1); // 【確認内容】: 全指摘が正しい。
  assert.equal(engine.recall, 1); // 【確認内容】: 全既知問題を検出している。
  assert.equal(engine.f1, 1); // 【確認内容】: precisionとrecallの調和平均が完全値になる。
  assert.equal(engine.averageDurationMs, 1000); // 【確認内容】: 完了した2実行の平均時間を使う。
  assert.equal(score.comparable, true); // 【確認内容】: 全ケースが完了していれば比較可能になる。
});

test("重複検出と既知問題に一致しない指摘はfalse positiveになる", () => {
  // 【テスト目的】: 同じ問題を何度も指摘するノイズを精度へ反映する。
  // 🟢 信頼性レベル: 比較要件の重複・未一致規則に直接対応する。
  const results = {
    runs: [
      {
        engine: "noisy",
        caseId: "known-regressions",
        status: "completed",
        findings: [
          { title: "first", matchedExpectedIds: ["file-scope"] },
          { title: "duplicate", matchedExpectedIds: ["file-scope"] },
          { title: "unrelated", matchedExpectedIds: [] },
        ],
      },
      { engine: "noisy", caseId: "clean-fix", status: "completed", findings: [] },
    ],
  };

  const engine = scoreBenchmark(manifest, results).engines.noisy;

  assert.equal(engine.truePositives, 1); // 【確認内容】: 最初の一致だけをTPにする。
  assert.equal(engine.falsePositives, 2); // 【確認内容】: 重複1件と未一致1件をFPにする。
  assert.equal(engine.falseNegatives, 2); // 【確認内容】: 未検出の既知問題2件をFNにする。
  assert.equal(engine.precision, 1 / 3); // 【確認内容】: TP/(TP+FP)を計算する。
  assert.equal(engine.recall, 1 / 3); // 【確認内容】: TP/(TP+FN)を計算する。
});

test("blockedまたは結果欠落があれば比較未完了になる", () => {
  // 【テスト目的】: APIキー不足などを精度0として誤集計せず、比較自体を未完了にする。
  // 🟢 信頼性レベル: APIキーがない場合の制約に直接対応する。
  const results = {
    runs: [
      {
        engine: "blocked-engine",
        caseId: "known-regressions",
        status: "blocked",
        reason: "OPENAI_API_KEY is not set",
        findings: [],
      },
    ],
  };

  const score = scoreBenchmark(manifest, results);
  const engine = score.engines["blocked-engine"];

  assert.equal(score.comparable, false); // 【確認内容】: 全ケース未完了なので比較確定を禁止する。
  assert.deepEqual(engine.incompleteCaseIds, ["clean-fix", "known-regressions"]); // 【確認内容】: blockedと欠落を両方列挙する。
  assert.equal(engine.truePositives, 0); // 【確認内容】: blocked実行をTPへ混ぜない。
  assert.equal(engine.falseNegatives, 0); // 【確認内容】: 未実行を見逃しとして扱わない。
});

test("ケースに存在しない既知問題IDへの一致は拒否する", () => {
  // 【テスト目的】: 人手ラベルの入力ミスでスコアが壊れないようにする。
  // 🟢 信頼性レベル: 入力整合性要件に直接対応する。
  const results = {
    runs: [
      {
        engine: "candidate",
        caseId: "known-regressions",
        status: "completed",
        findings: [{ title: "bad label", matchedExpectedIds: ["missing-id"] }],
      },
    ],
  };

  assert.throws(
    () => scoreBenchmark(manifest, results),
    /unknown expected finding ID: missing-id/,
  ); // 【確認内容】: 未定義IDを明示したエラーにする。
});

test("manifestに存在しないケースの結果は拒否する", () => {
  // 【テスト目的】: 比較対象外の結果が集計へ混入しないようにする。
  // 🟢 信頼性レベル: 入力整合性要件に直接対応する。
  const results = {
    runs: [
      { engine: "candidate", caseId: "unknown-case", status: "completed", findings: [] },
    ],
  };

  assert.throws(
    () => scoreBenchmark(manifest, results),
    /unknown benchmark case: unknown-case/,
  ); // 【確認内容】: 未定義ケースを明示したエラーにする。
});

test("Markdownレポートは精度と未完了状態を表示する", () => {
  // 【テスト目的】: 採用判断に必要な指標と未完了警告が人間に読めることを確認する。
  // 🟢 信頼性レベル: 出力要件に直接対応する。
  const results = {
    runs: [
      {
        engine: "candidate",
        caseId: "known-regressions",
        status: "completed",
        findings: [{ title: "file", matchedExpectedIds: ["file-scope"] }],
      },
    ],
  };

  const report = formatBenchmarkReport(scoreBenchmark(manifest, results));

  assert.match(report, /比較状態: 未完了/); // 【確認内容】: 結果欠落を警告する。
  assert.match(report, /\| candidate \| 1 \| 0 \| 2 \|/); // 【確認内容】: TP・FP・FNを表形式で示す。
  assert.match(report, /clean-fix/); // 【確認内容】: 未完了ケースIDを表示する。
});

test("Markdownレポートは取得できたAPI使用量と費用を表示する", () => {
  // 【テスト目的】: 精度だけでなく運用コストも同じ比較表で判断できるようにする。
  // 🟢 信頼性レベル: 出力要件のAPI使用量・費用に直接対応する。
  const results = {
    runs: [
      {
        engine: "candidate",
        caseId: "known-regressions",
        status: "completed",
        usage: { inputTokens: 12000, outputTokens: 800, costUsd: 0.031 },
        findings: [],
      },
      {
        engine: "candidate",
        caseId: "clean-fix",
        status: "completed",
        usage: { inputTokens: 4000, outputTokens: 200, costUsd: 0.009 },
        findings: [],
      },
    ],
  };

  const report = formatBenchmarkReport(scoreBenchmark(manifest, results));

  assert.match(report, /\| 16000 \| 1000 \| 0\.0400 \| 2 \|/); // 【確認内容】: token・費用・計測実行数を合算して表示する。
});

test("Markdownレポートはトークンだけ取得できた場合に費用を未計測として表示する", () => {
  // 【テスト目的】: costUsd欠落をゼロ費用と誤表示せず、未計測であることを明示する。
  // 🟢 信頼性レベル: 実測した現行ActionのResponses API usage形式に直接対応する。
  const results = {
    runs: [
      {
        engine: "candidate",
        caseId: "known-regressions",
        status: "completed",
        usage: { inputTokens: 12000, outputTokens: 800 },
        findings: [],
      },
      {
        engine: "candidate",
        caseId: "clean-fix",
        status: "completed",
        findings: [],
      },
    ],
  };

  const report = formatBenchmarkReport(scoreBenchmark(manifest, results));

  assert.match(report, /\| 12000 \| 800 \| - \| 1 \|/); // 【確認内容】: tokenは表示し、取得していない費用はハイフンにする。
});

test("filter有効性は同じ候補群の適用前後から誤検知削減率と正解保持率を計算する", () => {
  // 【テスト目的】: モデル出力の揺れを混ぜず、filterだけの効果を対比較する。
  // 🟢 信頼性レベル: filter有効性の主要な評価要件に直接対応する。
  const pairedResults = {
    runs: [
      {
        caseId: "known-regressions",
        status: "completed",
        candidates: [
          { title: "正解1", kept: true, rejectionReason: null, matchedExpectedIds: ["file-scope"] },
          { title: "正解2を誤棄却", kept: false, rejectionReason: "insufficient_evidence", matchedExpectedIds: ["budget-overflow"] },
          { title: "誤検知を棄却", kept: false, rejectionReason: "file_not_in_diff", matchedExpectedIds: [] },
        ],
      },
      {
        caseId: "clean-fix",
        status: "completed",
        candidates: [
          { title: "残った誤検知", kept: true, rejectionReason: null, matchedExpectedIds: [] },
        ],
      },
    ],
  };

  const score = scoreFilterEffectiveness(manifest, pairedResults);

  assert.equal(score.comparable, true);
  assert.deepEqual(
    {
      tp: score.before.truePositives,
      fp: score.before.falsePositives,
      fn: score.before.falseNegatives,
    },
    { tp: 2, fp: 2, fn: 1 },
  );
  assert.deepEqual(
    {
      tp: score.after.truePositives,
      fp: score.after.falsePositives,
      fn: score.after.falseNegatives,
    },
    { tp: 1, fp: 1, fn: 2 },
  );
  assert.equal(score.effect.falsePositiveReductionRate, 0.5);
  assert.equal(score.effect.truePositiveRetentionRate, 0.5);
  assert.deepEqual(score.effect.rejectionsByReason, {
    file_not_in_diff: 1,
    insufficient_evidence: 1,
  });
});

test("filter適用前に正解候補がない場合は正解保持率を評価不能にする", () => {
  // 【テスト目的】: TP=0のデータから「正解を100%保持した」と誤結論しない。
  // 🟢 信頼性レベル: 現在の実測データに該当する重要な境界値。
  const pairedResults = {
    runs: manifest.cases.map(({ id }) => ({
      caseId: id,
      status: "completed",
      candidates: [
        { title: `${id}の誤検知`, kept: false, rejectionReason: "insufficient_evidence", matchedExpectedIds: [] },
      ],
    })),
  };

  const score = scoreFilterEffectiveness(manifest, pairedResults);
  const report = formatFilterEffectivenessReport(score);

  assert.equal(score.effect.falsePositiveReductionRate, 1);
  assert.equal(score.effect.truePositiveRetentionRate, null);
  assert.match(report, /正解保持率 \| 評価不能/);
  assert.match(report, /正解候補がfilter適用前から0件/);
});
