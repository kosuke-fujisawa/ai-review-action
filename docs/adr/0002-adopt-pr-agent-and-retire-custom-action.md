# 0002. 独自AIレビューActionを廃止しPR-Agentを直接利用する

- 日付: 2026-07-31
- 状態: 採用

## 背景

ADR 0001では、複数リポジトリのAIレビュー処理を独自Composite Actionへ集約した。その後、PR-Agent v0.35.0との比較とevidence filterのbefore/after評価を実施した。

- PR-Agentは標準設定で4/4ケースを完了し、独自Actionは3/4ケース完了だった。
- 両者とも過去PR由来の既知3件を検出できず、独自Actionの精度上の優位は確認できなかった。
- 3正例・3負例の変異パイロットでは、独自filterが正解3件をすべて棄却し、誤検知1件を通過させた。
- PR-AgentはMITライセンスで、GitHub Action、CLI、複数Git provider、複数LLM provider、大規模PR処理、設定機構を既に提供している。

独自実装を維持する費用と、検証で確認された品質リスクを正当化できない。

## 選択肢

1. 独自Actionとevidence filterを継続改善する
2. PR-Agentを独自Actionでラップし、既存の公開APIを維持する
3. 独自Actionを廃止し、各利用リポジトリがPR-Agentを直接参照する
4. AIレビュー自体を廃止する

## 採用案

選択肢3を採用する。

- `action.yml` と `scripts/` を削除し、独自Actionの開発・配布を終了する。
- 利用側は `the-pr-agent/pr-agent` の検証済みコミットを直接参照する。
- 初期移行版はPR-Agent v0.35.0のコミット `0bd56c0508504c718cc03d504cd4ceb6725ba3c7` に固定する。
- 既存の `v1` タグは移動・削除せず凍結し、新規利用を禁止する。
- 比較ベンチマーク、結果、ADRは判断根拠として残す。
- このリポジトリは移行完了後にArchive候補とする。GitHubのArchive操作は別途明示的に行う。

## 採用理由

- 独自実装よりPR-Agentの方が完走率と平均時間で優れていた。
- 独自filterは小規模パイロットでrecallを1.0から0.0へ悪化させた。
- upstreamを直接使うことで、独自ラッパーの互換性管理、API変更追従、プロンプト・diff処理の保守をなくせる。
- 固定コミット参照により、`main` 追従より再現性とサプライチェーン安全性を高められる。
- リポジトリ固有設定はPR-Agent標準の `.pr_agent.toml` とworkflow環境変数で表現できる。

## 欠点・リスク

- PR-Agent upstreamの設計・リリースサイクルへ依存する。
- 既存の独自診断artifactとevidence filterは利用できなくなる。
- 利用側リポジトリごとにworkflow移行が必要になる。
- 固定コミットは自動更新されないため、脆弱性と新リリースを定期確認する必要がある。
- 比較ベンチマークではPR-Agentも既知3件を検出しておらず、レビュー品質そのものが保証されたわけではない。

## 再評価条件

- PR-Agentが保守停止またはMIT互換でなくなる
- セキュリティ上の重大問題へupstreamが対応しない
- 実プロジェクトの継続評価でPR-Agentの費用・完走率・精度が許容基準を満たさない
- PR-Agent標準設定では表現できない必須要件が、複数リポジトリで繰り返し発生する

再評価時も、まず別の既存OSSまたはupstreamへの貢献を検討し、独自レビュー基盤の再構築は最後の選択肢とする。

## 影響範囲

- このリポジトリの `action.yml`、`scripts/`、README、CI
- `kosuke-fujisawa/ai-review-action@v1` を参照する利用側workflow
- 移行対象として確認した `kosuke-fujisawa/chiriyuku-monotachi`、`kosuke-fujisawa/arikoi`、`kosuke-fujisawa/WillMeter`、`kosuke-fujisawa/ambit`
- 利用側の `OPENAI_API_KEY` secret、`AI_REVIEW_MODEL` variable、レビュー指示ファイル
