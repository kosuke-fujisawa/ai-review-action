# 0001. AIレビュー基盤を専用の共有Actionへ集約する

- 日付: 2026-07-12
- 状態: 廃止（後継: [0002. 独自AIレビューActionを廃止しPR-Agentを直接利用する](0002-adopt-pr-agent-and-retire-custom-action.md)）

## 背景

tsumugai、arikoi、WillMeterで同じPRレビュー機能を利用する。各リポジトリへスクリプトを複製すると、誤検知対策や出力スキーマの修正が同期されず、レビュー品質が分岐する。

## 選択肢

1. 各リポジトリで同じスクリプトを管理する
2. 既存プロダクトリポジトリのサブディレクトリを共有Actionとして参照する
3. 専用の公開リポジトリでComposite Actionとして管理する

## 採用案

専用の公開リポジトリ `kosuke-fujisawa/ai-review-action` でComposite Actionを管理し、利用側はバージョンタグを指定して呼び出す。

## 採用理由

共通ロジックの正本が1か所になり、利用側にはプロジェクト固有設定だけが残る。Composite Actionは既存Workflowから少ない変更で利用でき、特定プロダクトへの不自然な依存も避けられる。

## 欠点・リスク

- 共有Actionの障害が3リポジトリへ影響する
- タグ更新時に互換性管理が必要になる
- 公開リポジトリのため、秘密情報やプロジェクト固有情報を含められない

利用側は不変のリリースタグを参照し、秘密情報はAction inputsでのみ渡す。

## 再評価条件

- 利用リポジトリごとにレビュー処理の大半が異なる
- GitHub Actions以外でも同じ基盤を実行する必要が生じる
- 公開Actionとして維持できない機密要件が生じる

## 影響範囲

- `ai-review-action` の公開APIと実装
- tsumugai、arikoi、WillMeterのAIレビューWorkflow
- 各リポジトリの `.github/ai-review-instructions.md`
