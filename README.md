# ai-review-action（廃止）

> [!WARNING]
> この独自GitHub Actionは廃止されました。新規利用・機能追加・`v1`タグ更新は行いません。AIレビューには上流の [PR-Agent](https://github.com/The-PR-Agent/pr-agent) を直接利用してください。

## 廃止理由

PR-Agent v0.35.0との比較とevidence filterの対比較を行った結果、独自実装を維持する根拠が得られませんでした。

- 独自Actionは標準設定で4ケース中1ケースがタイムアウト
- 過去PR由来の既知3件は独自Action・PR-Agentとも未検出
- 独自filterは変異パイロットで正解3件をすべて棄却し、誤検知1件を通過
- PR-Agentは同等の基本機能とより広いprovider・モデル・運用機能をMITで提供

判断の詳細は[ADR 0002](docs/adr/0002-adopt-pr-agent-and-retire-custom-action.md)と[filter有効性評価](docs/implements/COMPARE-001/filter-effectiveness-report.md)を参照してください。

## PR-Agentへの移行

利用側リポジトリの `.github/workflows/ai-review.yml` を、[examples/pr-agent.yml](examples/pr-agent.yml)を基に置き換えます。

```yaml
name: PR Agent

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, review_requested]
  issue_comment:
    types: [created, edited]

permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  review:
    if: >-
      ${{
        github.event.sender.type != 'Bot' &&
        (
          (
            github.event_name == 'pull_request' &&
            !github.event.pull_request.draft &&
            github.event.pull_request.head.repo.full_name == github.repository &&
            !contains(github.event.pull_request.labels.*.name, 'skip-ai-review')
          ) ||
          (
            github.event_name == 'issue_comment' &&
            github.event.issue.pull_request &&
            contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)
          )
        )
      }}
    runs-on: ubuntu-latest
    steps:
      - uses: the-pr-agent/pr-agent@0bd56c0508504c718cc03d504cd4ceb6725ba3c7 # v0.35.0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          OPENAI_KEY: ${{ secrets.OPENAI_API_KEY }}
          config.model: ${{ vars.AI_REVIEW_MODEL || 'gpt-5-mini' }}
          config.fallback_models: '[]'
          config.response_language: ja-JP
          github_action_config.auto_review: 'true'
          github_action_config.auto_describe: 'true'
          github_action_config.auto_improve: 'true'
          github_action_config.pr_actions: '["opened","synchronize","reopened","ready_for_review","review_requested"]'
```

既存のRepository secret `OPENAI_API_KEY` とvariable `AI_REVIEW_MODEL` はそのまま再利用できます。PR-Agentが要求する環境変数名 `OPENAI_KEY` へworkflow内でマッピングします。

プロジェクト固有の設定は、[examples/pr-agent.toml](examples/pr-agent.toml)を参考に利用側ルートの `.pr_agent.toml` へ移します。旧 `.github/ai-review-instructions.md` の内容は `[pr_reviewer].extra_instructions` などへ移植してください。

`issue_comment` ではOpenAI APIキーを使うため、上の例ではPRコメントからの実行をRepository owner、member、collaboratorに限定しています。公開リポジトリではこの制限を外さないでください。

## `v1`利用者への注意

`kosuke-fujisawa/ai-review-action@v1` は既存利用者を突然壊さないため、最後の独自実装を指す状態で凍結します。

- 新しいコミットへタグを付け替えない
- バグ修正・モデル更新・セキュリティ更新を提供しない
- 利用側のPR-Agent移行後に、このGitHubリポジトリのArchiveを検討する

## 残しているもの

- `benchmark/`: 比較とfilter評価の再現用集計コード・入力・結果
- `docs/adr/`: 採用・廃止判断
- `docs/implements/COMPARE-001/`: 実測レポート

独自Action本体の `action.yml` と `scripts/` は削除済みです。

## 検証

```bash
npm test
npm run check
npm run benchmark:report
npm run benchmark:filter-pilot-report
```
