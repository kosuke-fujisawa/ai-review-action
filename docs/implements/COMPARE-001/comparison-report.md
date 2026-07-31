# AIレビュー基盤 比較検証レポート

実施日: 2026-07-31

## 結論

汎用AIコードレビュー基盤としては、既存OSSを流用する方が合理的である。現行の `ai-review-action` をそのまま独立した汎用レビュアーとして公開する根拠は、今回の実測では得られなかった。

現行実装の「決定論的チェックとLLM指摘を照合する」「候補と棄却理由をdiagnosticsへ残す」という方向は一般的なレビュー生成ツールとは異なる。しかし追加の変異パイロットで、現在のevidence filterは正解3件をすべて棄却し、誤検知1件を通過させた。したがって、現時点ではfilterも公開価値として主張できない。

## 実測条件

- モデル: `gpt-5-mini`
- 正例: 過去のPRで実際に検出・修正された3不具合を含む1ケース
- 負例: 既知の新規不具合がない修正コミット3ケース
- エンジン:
  - 現行 `ai-review-action`
  - PR-Agent v0.35.0
- PR-AgentはLocalGitProviderで実行し、GitHubへ投稿していない。

## 標準実行

| Engine | 完了ケース | TP | FP | FN | 平均所要時間 |
| --- | ---: | ---: | ---: | ---: | ---: |
| ai-review-action | 3/4 | 0 | 2 | 未完了のため確定せず | 52.0秒 |
| PR-Agent v0.35.0 | 4/4 | 0 | 6 | 3 | 30.8秒 |

現行Actionは正例で組み込みの90秒タイムアウトに2回到達した。PR-Agentは全ケースを完了した。

## 検出能力の切り分け

現行Actionの一時コピーだけタイムアウトを300秒へ延長したところ、正例は89.1秒で完了した。しかし既知3件は検出せず、別の2件を指摘した。

この診断結果を含めると以下になる。

| Engine | TP | FP | FN | Precision | Recall | F1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ai-review-action（延長診断） | 0 | 4 | 3 | 0.000 | 0.000 | 0.000 |
| PR-Agent v0.35.0 | 0 | 6 | 3 | 0.000 | 0.000 | 0.000 |

現行ActionはPR-Agentより誤検知が2件少なかったが、正解を1件も検出していないため、有効性の優位を示すものではない。

## 公開OSSとの重複

### PR-Agent

[PR-Agent](https://github.com/The-PR-Agent/pr-agent) はMITライセンスの公開OSSで、GitHub ActionとCLIに加え、GitHub、GitLab、Bitbucket、Azure DevOps、Gitea、複数LLM provider、大規模PR向けのtoken-aware処理を提供する。

現行Actionと重複する範囲:

- PR差分の取得
- LLMによるレビュー
- GitHub Actionからの自動実行
- ファイル除外と入力サイズ制御
- レビュー結果の投稿

この範囲を自前で維持する価値は低い。

### 軽量なGitHub Action

MITの [villesau/ai-codereviewer](https://github.com/villesau/ai-codereviewer) も、PR差分取得、除外、OpenAI API呼び出し、PRコメント投稿という基本フローを既に提供する。ISCの [anc95/ChatGPT-CodeReview](https://github.com/anc95/ChatGPT-CodeReview)、MITの [Matter AI](https://github.com/MatterAIOrg/matter-ai) や [Gito](https://github.com/Nayjest/Gito) など、同じ問題領域の公開実装も複数存在する。

したがって「OpenAIへdiffを送り、PRへレビューを投稿する」だけでは独自性にならない。

## 独自性として残せる部分

- deterministic checksとLLM出力の照合
- 変更ファイル外の指摘を投稿前に排除
- 検証結果との矛盾、Build成功との矛盾、根拠不足を分類して棄却
- 採用・棄却理由をdiagnosticsとして監査可能に保存
- 誤検知を正解データで継続評価する小さなベンチマーク

追加の変異パイロットでは、filter適用前の `TP=3 / FP=1 / Recall=1.0` が、適用後に `TP=0 / FP=1 / Recall=0.0` になった。現在の実装は「価値が未実証」ではなく、小規模パイロット上で有害な結果が観測された段階である。詳細は `filter-effectiveness-report.md` を参照する。

## 推奨方針

1. 汎用レビュー生成はPR-Agent等を流用する。
2. evidence filterは現状のまま利用・公開せず、正解を落とした条件を先に修正する。
3. 修正後、同じ候補を使うbefore/after評価で正解保持率と誤検知削減率を再測定する。
4. 実プロジェクト由来の正例・負例を増やし、recallを維持しながらprecisionが上がる場合のみ独立OSSとして公開する。
5. 改善が再現しなければ、研究・実験用リポジトリとして明示するかArchiveする。

## 制約

- 正例1ケース、既知問題3件、負例3ケースだけの小規模評価である。
- 単一モデルの単発実行を中心としており、LLM出力の分散は測定していない。
- PR-AgentのAPI token usageはLocalGitProvider成果物から取得できなかった。
- 現行Actionの正例は標準設定で完了していないため、正式な横並び精度比較は未完了である。
- filter変異パイロットは正例3件・負例3件であり、一般化には追加データが必要である。
