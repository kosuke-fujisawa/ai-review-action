# AIレビュー基盤比較 Greenフェーズ

## 実装

- `scoreBenchmark`: manifestと結果を検証し、エンジン別にTP・FP・FNと派生指標を計算する。
- `formatBenchmarkReport`: 完了状態、指標、未完了ケースをMarkdownへ整形する。

## 境界条件

- blocked / failed / 結果欠落はFNとして扱わない。
- 同じ既知問題への2件目以降の指摘はFPとする。
- 未定義ケース、未定義エンジン、未定義の既知問題IDはエラーにする。
