# Debug Logging

永続トレースは、SSE は進んでいるのに UI が待機状態から戻らない不具合を追うための開発用ログです。

## 有効化

```bash
AMONG_AI_TRACE=1 npm run dev
```

ログは既定で `logs/game-traces/*.jsonl` に出ます。保存先を変える場合:

```bash
AMONG_AI_TRACE=1 AMONG_AI_TRACE_DIR=/tmp/among-ai-traces npm run dev
```

`logs/` は `.gitignore` 済みです。

## 記録内容

- サーバー: `server.system`, `server.progress`, `server.game`, `server.human_input`, `server.human_input_cancelled`, `server.done`, `server.error`
- クライアント: `client.ui_state`, `client.progress`, `client.game`, `client.human_input`, `client.done`, `client.error`
- トレース管理: `trace.opened`, `trace.closed`
- 共通キー: `streamLogId`

本文、LLMプロンプト、会話履歴、入力テキストは保存しません。イベント本文は `messageLength`、UI入力は `requestId` や `kind` などのメタ情報だけを残します。

## 見るべき項目

今回のような進行ブロックでは、同じ `streamLogId` の JSONL で以下を確認します。

- `queuedCount`
- `processingHudVisible`
- `waitingForSubmittedHumanInput`
- `storyWaitingForStream`
- `storyProcessingBlocksAdvance`
- `storyNextDisabled`
- `humanInputAdvanceReady`
