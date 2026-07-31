# AIレビュー基盤比較 Redフェーズ

## 対象

`scoreBenchmark` と `formatBenchmarkReport`

## 期待する失敗

`benchmark/lib.mjs` がまだ存在しないため、テストのimportが失敗する。

## Greenフェーズで実装する最小機能

- manifestとresultsの整合性検証
- TP・FP・FN、precision・recall・F1の計算
- 未完了ケースの検出
- Markdownレポート生成
