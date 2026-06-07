# Development

## ローカル開発

```bash
pnpm install
pnpm dev
```

`pnpm dev` は API サーバーと Vite 開発サーバーを同時に起動する。
本番相当のビルド確認は `pnpm build`、回帰テストは `pnpm test`、lint は `pnpm lint` を使う。

## LLM実行レイヤー

LLM呼び出しのキュー、レース、リトライ、タイムアウト、キャンセルは外部ライブラリ
[`llm-hedge`](https://github.com/MizukiMachine/llm-hedge) に切り出している。
Render などの外部ビルド環境で解決できるように、このリポジトリでは npm 公開版の
`llm-hedge` を依存として参照する。

`llm-hedge` を変更するときは、正本である `../llm-hedge` リポジトリの `src/` を編集する。
変更を among-ai に反映するには、ライブラリ側でビルドと公開を行い、among-ai 側の依存バージョンを更新する。

```bash
cd ../llm-hedge
pnpm build
npm publish
cd ../among-ai
pnpm add llm-hedge@<published-version>
```

among-ai は生TSではなく npm で配布されるビルド成果物を消費する。
