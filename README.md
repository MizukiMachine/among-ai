# among ai

## ゲーム概要

- AIキャラクターたちが会話、投票、夜行動を重ねて進行するブラウザ人狼ゲーム
- ユーザーは `自分も参加してプレイ` するか、AI同士の対局を `AI観戦` できる
- 参加時のユーザーは人間陣営、狼陣営、ランダムから陣営を選べる。ランダムは陣営が50:50になる重みで割り当てる
- APIキーがない環境ではデモエージェントに切り替わり、LLMなしでも対局の流れを確認できる

## ゲームの仕様と挙動

- `対局設定` で参加方式、参加キャラクター、人数を決めて対局を開始する
- `設定を決定` すると、まず1日目の昼議論前に出るAIたちの短い意気込み発言を作り始める
- 初日の人狼陣営の顔合わせは、AI生成ではなくキャラクターと役職ごとの固定発言から毎回ランダムに表示する
- 人狼、α人狼、美女狼の顔合わせ発言は各キャラクターに複数用意され、発言する順番も毎回ランダムに変わる
- 顔合わせを表示している間も、裏では昼議論前の意気込み発言だけを先に作っている
- 意気込み発言がそろってから通常の昼議論に入り、昼議論の本文は直前までの会話を見ながら順番に作られる
- 人数は6〜15人に対応し、プレイ参加時は9人以下を推奨する
- 人狼陣営だけが見られる秘密会話、昼議論、投票、夜行動、処刑、襲撃、勝敗判定がSSEで順次流れる
- `AI観戦` では全役職を見られる `全情報` と、秘匿情報を隠す `人間視点` を切り替えられる
- `自分も参加してプレイ` ではプレイヤー本人に見える情報だけを見ながら、発言候補や対象選択で対局に関与する
- 公開発言、秘密会話、役職情報は redaction によって表示権限ごとに分離される
- 昼のAI発言は直前の公開会話を踏まえて生成され、投機的な並列生成で待ち時間を抑える
- 役職は人狼、α人狼、美女狼、占い師、魔女、騎士、ハンター、鴉、愚者、長老、恋人、道化師、人間を扱う

## 構成

- `src/client`: React + Vite の単一ページUI
- `src/server`: Hono API、SSEストリーム、人間入力セッション
- `src/game`: ゲームエンジン、AIエージェント、発言計画、秘匿情報の redaction
- `src/game/rules`: 役職、夜行動、投票、死亡解決、勝敗判定
- `src/game/prompts`: YAML素材、プロンプト組み立て、秘密情報の露出制御
- `public/assets`: キャラクター画像、BGM、SFX、SF UI素材
- `tests`: エンジン、プロンプト、サーバー、UI、音声アセットの回帰テスト

```text
Browser UI
  -> Hono API / SSE
    -> WerewolfGame engine
      -> Rules, roles, voting, night actions
      -> Agents, prompts, llm-hedge
      -> Redaction and human input sessions
```

## Render Web Service へのデプロイ

このアプリは SSE ストリームと人間入力セッションを同じ Node.js プロセスで扱うため、
Render では Static Site ではなく Web Service としてデプロイする。

リポジトリ直下の `render.yaml` を使って Blueprint から作成できる。手動作成する場合は
次の設定にする:

```text
Service type: Web Service
Runtime: Node
Build Command: corepack enable && pnpm install --frozen-lockfile && pnpm build
Start Command: pnpm start
Health Check Path: /api/health
```

環境変数は Render の Environment で設定する:

```text
NODE_VERSION=22.22.3
ZAI_API_KEY=...
ZAI_MODEL=glm-5-turbo
ZAI_BASE_URL=https://api.z.ai/api/anthropic
ZAI_TIMEOUT_MS=120000
AMONG_AI_HUMAN_OPTIONAL_INPUT_TIMEOUT_MS=45000
```

人間参加モードは `src/server/humanSessions.ts` のインメモリセッションを使うため、
Render では `numInstances: 1` の単一インスタンス運用を前提にする。複数インスタンスへ
水平スケールする場合は、セッション状態を Render Key Value などの外部ストアへ移す必要がある。
Free インスタンスはアイドル時にスリープするため、対局用途では有料インスタンスを使う。

## LLM実行レイヤー (llm-hedge)

LLM呼び出しのキュー・レース・リトライ・タイムアウト・キャンセルは、外部ライブラリ
[`llm-hedge`](https://github.com/MizukiMachine/llm-hedge)（npm公開）に切り出してある。
Render などの外部ビルド環境で解決できるように、このリポジトリでは npm 公開版の
`llm-hedge` を依存として参照する。

`llm-hedge` を変更したいときは、**唯一の正である `../llm-hedge` リポジトリの `src/` だけを編集**する
（among-ai 内に実体コピーは無い）。変更を among-ai に反映するには、ライブラリ側でビルドと公開を行い、
among-ai 側の依存バージョンを更新する:

```bash
cd ../llm-hedge
pnpm build
npm publish
cd ../among-ai
pnpm add llm-hedge@<published-version>
```

> 生TSではなくビルド成果物（＝npmで配布する実物）を消費しているため、ローカルで
> 公開パッケージをそのまま dogfood できる。

## 関連ドキュメント

- 機能仕様: [docs/functional-specification.md](docs/functional-specification.md)
- プロンプト管理: [docs/prompt-management.md](docs/prompt-management.md)
- LLM実行レイヤー: [llm-hedge (GitHub)](https://github.com/MizukiMachine/llm-hedge)
