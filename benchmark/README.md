# AIレビュー基盤ベンチマーク

廃止された独自 `ai-review-action` と PR-Agent v0.35.0を、同じGit差分と `gpt-5-mini` で比較した判断記録です。

> [!NOTE]
> 独自Action本体はADR 0002により削除済みです。このディレクトリは集計コード、入力、実測結果だけを保存します。独自Actionを本番利用するための資料ではありません。

## 判定方法

`manifest.json` の `expectedFindings` が正解データです。モデル出力を確認した人が、各指摘の `matchedExpectedIds` に一致するIDを記入します。

- 最初の一致: TP
- 同じIDへの重複指摘: FP
- 一致IDなし: FP
- 未検出の正解ID: FN
- blocked / failed / 結果欠落: 精度へ混ぜず、比較未完了

モデル自身に正解判定をさせないことで、採点側のLLMバイアスを避けます。

## レポート

```bash
npm run benchmark:report
npm run benchmark:filter-report
npm run benchmark:filter-pilot-report
```

`benchmark:filter-report` は、同じモデル応答候補に対するfilter適用前後を比較します。別々のモデル呼び出しを比較しないため、LLM出力の揺れをfilter効果として誤集計しません。

`benchmark:filter-pilot-report` は、認証条件反転、配列境界、削除先取り違えの3変異と各修正差分を使い、正解候補をfilterが保持できるかを測ります。

## ケースの準備

ケースごとに一時cloneを作成し、headを作業ブランチ、baseを `benchmark-base` ブランチにします。PR #4ケースの例:

```bash
git clone --no-hardlinks /path/to/ai-review-action /private/tmp/ai-review-benchmark-pr4
git -C /private/tmp/ai-review-benchmark-pr4 switch -c benchmark-candidate 423ced4cfb115dd4e3a1cc20867cb418ad279872
git -C /private/tmp/ai-review-benchmark-pr4 branch benchmark-base 45f66355683d3be8218003f83c4b96fb441c4da1
```

## 廃止済みActionの再現

廃止直前の独自Actionはコミット `fba51c2e9fb3b496efdc234bee21386ed966d010` に残っています。過去結果を再実行する場合だけ、隔離worktreeを使用します。

```bash
git worktree add /private/tmp/ai-review-action-retired fba51c2e9fb3b496efdc234bee21386ed966d010
```

ケースcloneをカレントディレクトリにし、隔離した旧スクリプトを実行します。

```bash
AI_REVIEW_MAX_DIFF_CHARS=45000 node /private/tmp/ai-review-action-retired/scripts/collect-input.mjs
OPENAI_API_KEY=... AI_REVIEW_MODEL=gpt-5-mini node /private/tmp/ai-review-action-retired/scripts/review.mjs
```

結果はケースclone内の `tmp/ai-review/result.json` と `diagnostics.json` に保存されます。

## PR-Agent

PR-Agent v0.35.0を隔離venvへインストールし、LocalGitProviderを使用します。`benchmark-base` はURLではなく比較対象のローカルブランチ名です。

```bash
AZURE_DEVOPS_CACHE_DIR=/private/tmp/pr-agent-v0.35.0/azure-cache \
CONFIG__GIT_PROVIDER=local \
CONFIG__PUBLISH_OUTPUT=true \
OPENAI_KEY=... \
/private/tmp/pr-agent-v0.35.0/.venv/bin/python -m pr_agent.cli \
  --pr_url=benchmark-base \
  review \
  --config.model=gpt-5-mini \
  '--config.fallback_models=[]'
```

LocalGitProviderの出力はケースclone内の `review.md` です。GitHub上のPRへは投稿されません。

## 注意

- APIキーをリポジトリ内のファイルへ保存しないでください。ローカル実行時はリポジトリ外の権限制限した環境ファイルまたはOSのシークレットストアを使用してください。
- 両エンジンを同じモデル、同じコミット範囲で実行してください。
- `matchedExpectedIds` は指摘内容と根拠を読んで手動で割り当ててください。
- 全ケース・全エンジンが完了するまで採用判断を確定しません。
