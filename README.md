# among ai

## ゲーム概要

- AIキャラクターたちが会話、投票、夜行動を重ねて進行するブラウザ人狼ゲーム
- ユーザーは `人狼として参加` するか、AI同士の対局を `AI観戦` できる
- 参加時のユーザーは人狼陣営として扱われ、仲間の演技を見ながら村人の全排除を狙う
- APIキーがない環境ではデモエージェントに切り替わり、LLMなしでも対局の流れを確認できる

## ゲームの仕様と挙動

- `対局設定` で参加方式、参加キャラクター、人数を決めて対局を開始する
- 人数は6〜15人に対応し、プレイ参加時は9人以下を推奨する
- 人狼陣営だけが見られる秘密会話、昼議論、投票、夜行動、処刑、襲撃、勝敗判定がSSEで順次流れる
- `AI観戦` では全役職を見られる `全情報` と、秘匿情報を隠す `人間視点` を切り替えられる
- `人狼として参加` ではプレイヤー本人と人狼仲間の情報だけを見ながら、発言候補や対象選択で対局に関与する
- 公開発言、秘密会話、役職情報は redaction によって表示権限ごとに分離される
- 昼のAI発言は直前の公開会話を踏まえて生成され、投機的な並列生成で待ち時間を抑える
- 役職は人狼、α人狼、美女狼、占い師、魔女、騎士、ハンター、鴉、愚者、長老、恋人、道化師、人間を扱う

## 構成

- `src/client`: React + Vite の単一ページUI
- `src/server`: Hono API、SSEストリーム、人間入力セッション
- `src/game`: ゲームエンジン、AIエージェント、発言計画、秘匿情報の redaction
- `src/game/rules`: 役職、夜行動、投票、死亡解決、勝敗判定
- `src/game/prompts`: YAML素材、プロンプト組み立て、秘密情報の露出制御
- `packages/llm-hedge`: LLM呼び出しのキュー、レース、リトライ、キャンセル用ライブラリ
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

- 機能仕様: [docs/functional-specification.md](docs/functional-specification.md)
- プロンプト管理: [docs/prompt-management.md](docs/prompt-management.md)
- LLM実行レイヤー: [packages/llm-hedge/README.md](packages/llm-hedge/README.md)
