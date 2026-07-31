# MIGRATE-001 設定確認・動作テスト

## 確認対象

- 独自Action実装の撤去
- PR-Agent v0.35.0直接利用テンプレート
- 比較・判断記録の継続検証

## 確認結果

- [x] `action.yml` が存在しない。
- [x] `scripts/` が存在しない。
- [x] PR-Agent固定SHAがupstreamに存在し、v0.35.0 release commitである。
- [x] `examples/pr-agent.yml` がactionlintを通過する。
- [x] `examples/pr-agent.toml` がPython `tomllib`でparseできる。
- [x] benchmark単体テスト10件が成功する。
- [x] benchmarkスクリプトの構文検査が成功する。
- [x] 比較レポートとfilterパイロットレポートを生成できる。
- [x] APIキー・秘密鍵形式の値が差分へ含まれていない。
- [x] `git diff --check` が成功する。
- [x] 4つの利用側リポジトリで移行workflowがactionlintを通過する。
- [x] 4つの利用側リポジトリで `.pr_agent.toml` がparseできる。
- [x] 4つの利用側リポジトリに移行Draft PRを作成した。
- [ ] 4つの利用側Draft PRをマージする。
- [ ] PR-Agentを利用側の実PRで起動するE2E確認。

## 実行コマンド

```bash
npm test
npm run check
npm run benchmark:report
npm run benchmark:filter-pilot-report
actionlint examples/pr-agent.yml
python3 -c "import pathlib,tomllib; tomllib.loads(pathlib.Path('examples/pr-agent.toml').read_text())"
```

利用側4リポジトリについても、同じ `actionlint`、TOML parse、`git diff --check`、秘密情報パターン検査を実行した。

## 現在の判定

このリポジトリ内の独自Action撤去、移行テンプレート作成、利用側4リポジトリの移行Draft PR作成は完了した。全面移行の完了条件である利用側PRのマージと実PR動作確認は未完了である。
