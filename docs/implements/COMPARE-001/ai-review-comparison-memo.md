# TDD開発メモ: AIレビュー基盤比較

## 概要

- 機能名: AIレビュー比較スコアリング
- 現在のフェーズ: Refactor
- 要件定義: `docs/implements/COMPARE-001/ai-review-comparison-requirements.md`
- テストケース: `docs/implements/COMPARE-001/ai-review-comparison-testcases.md`
- 実装予定: `benchmark/lib.mjs`
- テスト: `benchmark/lib.test.mjs`

## Redフェーズ

- TP・FP・FN、重複指摘、未実行ケース、入力不整合を先にテストする。
- `ERR_MODULE_NOT_FOUND` で失敗することを確認した。

## Greenフェーズ

- `benchmark/lib.mjs` に入力検証、スコア計算、Markdown出力を最小実装した。
- blocked / failed / 欠落ケースを精度計算から除外する。
- 同じ既知問題への重複指摘をFPとして数える。

## Refactorフェーズ

- API入出力トークン、費用、計測済み実行数を比較表へ追加した。
- 陽性1ケースに加え、既知問題のない修正コミット3ケースを陰性ケースとして登録した。
- 評価ロジックは外部入力を実行せずJSONとして検証するため、コマンド注入経路を持たない。
- 計算量は実行数・指摘数・既知問題数に対して線形で、現在の小規模ベンチマークでは性能上の問題はない。

## Refactorフェーズ

未実施。
