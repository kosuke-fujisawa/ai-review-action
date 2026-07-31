# MIGRATE-001 設定作業実行

## 作業概要

- タスクID: MIGRATE-001
- 作業内容: 独自AIレビューActionを廃止し、PR-Agent直接利用へ移行
- 実行日: 2026-07-31

## 設計文書

- `docs/adr/0001-centralize-ai-review-action.md`
- `docs/adr/0002-adopt-pr-agent-and-retire-custom-action.md`
- `docs/implements/COMPARE-001/comparison-report.md`
- `docs/implements/COMPARE-001/filter-effectiveness-report.md`
- PR-Agent v0.35.0のGitHub Action設定と標準configuration

## 実行した作業

### 判断記録

- ADR 0001を廃止状態へ変更した。
- ADR 0002にPR-Agent直接利用、独自Action撤去、`v1`タグ凍結を記録した。

### 独自実装の撤去

- `action.yml` を削除した。
- `scripts/` 配下の収集、レビュー、filter、投稿処理とテストを削除した。
- `package.json` から独自実装のテスト・構文検査を削除した。
- 残したbenchmarkは判断記録であり、本番Actionではないことを明記した。

### PR-Agent移行設定

- `examples/pr-agent.yml` にPR-Agent v0.35.0の直接利用workflowを追加した。
- upstream参照をコミット `0bd56c0508504c718cc03d504cd4ceb6725ba3c7` へ固定した。
- 既存secret `OPENAI_API_KEY` をPR-Agentの `OPENAI_KEY` へマッピングした。
- `gpt-5-mini`、日本語応答、自動review・describe・improveを設定した。
- `examples/pr-agent.toml` にリポジトリ固有設定の移行先を示した。

### 利用側リポジトリ

次の4リポジトリで、旧ActionをPR-Agent v0.35.0の直接参照へ置き換えるDraft PRを作成した。

- [chiriyuku-monotachi PR #62](https://github.com/kosuke-fujisawa/chiriyuku-monotachi/pull/62)
- [arikoi PR #123](https://github.com/kosuke-fujisawa/arikoi/pull/123)
- [WillMeter PR #93](https://github.com/kosuke-fujisawa/WillMeter/pull/93)
- [ambit PR #13](https://github.com/kosuke-fujisawa/ambit/pull/13)

各PRでは以下を共通化した。

- PR-Agent v0.35.0の固定SHA参照
- 自動review、describe、improve
- `skip-ai-review` ラベル
- 同一リポジトリの非ドラフトPRだけを自動実行
- PRコメントコマンドをowner、member、collaboratorへ限定
- 既存secret `OPENAI_API_KEY` を `OPENAI_KEY` へworkflow内でマッピング
- リポジトリ固有指示を `.pr_agent.toml` へ移行

Arikoiの旧レビュー指示は現行のTyranoScript構成と不一致だったため、`AGENTS.md` を正として更新した。AmbitのSwiftData・日付正規化・プライバシー指示は維持した。

## セキュリティ

- PR-Agentは可変の`main`やtagではなく検証済みcommit SHAへ固定した。
- APIキー値を読み取り・出力・リポジトリ保存していない。
- 旧`v1`タグを新しい廃止コミットへ移動せず、既存利用者の突然の破損を避ける。

## 残作業

- 4件の利用側Draft PRをレビューしてマージする。
- 各利用側リポジトリで `OPENAI_API_KEY` secretの登録を確認する。
- 利用側PRをReady for reviewへ変更し、PR-Agentの実行結果を確認する。
- 全利用先の移行後、このリポジトリをGitHub上でArchiveするか明示的に判断する。
