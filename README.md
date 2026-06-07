# among ai

## ゲーム概要

- AIキャラクターたちが会話、投票、夜行動を重ねて進行するブラウザ人狼ゲーム
- ユーザーはAI同士の対局を観戦するか、自分も1プレイヤーとして参加できる
- 観戦時は全役職を見られる `全情報` と、秘匿情報を隠す `人間視点` を切り替えられる
- 参加時は人間陣営、狼陣営、ランダムから陣営を選んで対局に関与する
- APIキーがない環境ではデモエージェントに切り替わり、LLMなしでも進行を確認できる

## ゲームの仕様と挙動

- `対局設定` で参加方式、キャラクター、人数を決めて対局を開始する
- 人数は6〜15人に対応し、プレイ参加時は9人以下を推奨する
- 1日目は狼陣営の顔合わせを固定発言から表示し、裏で昼議論前の意気込み発言を先行生成する
- 昼議論は直前までの公開会話を踏まえてAI発言を生成し、投機的な並列生成で待ち時間を抑える
- 秘密会話、昼議論、投票、夜行動、処刑、襲撃、勝敗判定がSSEで順次流れる
- 公開発言、秘密会話、役職情報は redaction によって表示権限ごとに分離される
- 人間参加時は本人に見える情報だけを見ながら、発言候補や対象選択で対局に関与する
- 役職は人狼、α人狼、美女狼、占い師、魔女、騎士、ハンター、罠師、愚者、長老、恋人、道化師、人間を扱う

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

## 関連ドキュメント

- 開発手順: [docs/development.md](docs/development.md)
- デプロイ手順: [docs/deployment.md](docs/deployment.md)
- 機能仕様: [docs/functional-specification.md](docs/functional-specification.md)
- プロンプト管理: [docs/prompt-management.md](docs/prompt-management.md)
- デバッグログ: [docs/debug-logging.md](docs/debug-logging.md)
