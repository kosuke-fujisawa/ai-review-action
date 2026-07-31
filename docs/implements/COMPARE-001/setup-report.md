# COMPARE-001 設定作業実行

## 作業概要

- タスクID: COMPARE-001
- 対象: ai-review-action と PR-Agent v0.35.0の比較環境
- 日付: 2026-07-31

## 実行した作業

- PR-Agent v0.35.0 (`0bd56c0508504c718cc03d504cd4ceb6725ba3c7`) を `/private/tmp/pr-agent-v0.35.0` へcloneした。
- `/private/tmp/pr-agent-v0.35.0/.venv` に依存関係を隔離インストールした。
- Azure DevOps SDKのキャッシュ先を `/private/tmp/pr-agent-v0.35.0/azure-cache` に限定した。
- PR #4初回コミットを `/private/tmp/ai-review-benchmark-pr4` へcloneし、比較用baseブランチを作成した。
- PR-Agentの `CONFIG__GIT_PROVIDER=local` と `CONFIG__PUBLISH_OUTPUT=false` を確認した。
- 比較manifest、結果形式、スコア計算、レポート生成を追加した。

## セキュリティ

- APIキーはリポジトリ外の権限 `600` の環境ファイルから読み込み、コマンド出力や成果物へ記録していない。
- PR-AgentはLocalGitProviderを使用し、外部PRへコメントを投稿しない。
- 一時環境はプロジェクトの依存関係へ追加していない。

## 追加実行

- `gpt-5-mini` で4ケース×2エンジンを実行した。
- 現行Actionの陽性ケースは組み込みの90秒タイムアウトに2回到達した。
- 検出能力を切り分けるため、一時コピーだけタイムアウトを300秒へ変更した診断実行を追加した。リポジトリ本体は変更していない。
- 詳細は `comparison-report.md` と `benchmark/results.json` に記録した。
