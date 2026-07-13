# ai-review-action

複数リポジトリで共用する、根拠重視のGitHub Pull Request向けAIレビューActionです。

## 特徴

- PR差分をファイル単位で配分し、後半の変更ファイルが丸ごと欠落することを防ぐ
- 削除された型・関数を抽出し、HEADの残存参照を `git grep` で確認する
- GitHub check-runsのBuild・Test・Lint結果をレビュー入力へ含める
- 実在するファイルと行番号、実行経路、反証結果がない指摘を破棄する
- モデルが提案した任意のシェルコマンドは実行せず、許可された構造化プローブだけを `execFileSync` で実行する
- 指摘内容、検証コマンド案、構造化プローブが直接対応しない指摘を破棄する
- 構造化プローブを実行できない、または期待値と実結果が一致しない指摘を破棄する
- Build成功時、残存参照が確認できないコンパイルエラー指摘を破棄する

現在許可している構造化プローブは `git_ls_files` のみです。`--cached` と最大10個のpathspecだけを受け付け、未ステージ追跡ファイルが列挙されるかを実結果と照合します。指摘の実行経路と検証コマンド案が `git ls-files` の挙動を直接扱う場合に限って採用し、ランタイムやライブラリの挙動を裏付ける用途には使用しません。検証対象がない場合は、確認済みとは扱いません。

## 使用例

```yaml
permissions:
  checks: read
  contents: read
  pull-requests: write

steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0

  - uses: kosuke-fujisawa/ai-review-action@v1
    with:
      github-token: ${{ github.token }}
      openai-api-key: ${{ secrets.OPENAI_API_KEY }}
      model: ${{ vars.AI_REVIEW_MODEL || 'gpt-5-mini' }}
      max-diff-chars: 30000
```

プロジェクト固有のルールは、利用側リポジトリの `.github/ai-review-instructions.md` に記載します。生成物は `tmp/ai-review/` に保存されます。

## 開発

```bash
npm test
npm run check
```
