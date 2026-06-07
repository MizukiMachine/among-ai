# Deployment

## Render Web Service

このアプリは SSE ストリームと人間入力セッションを同じ Node.js プロセスで扱うため、
Render では Static Site ではなく Web Service としてデプロイする。

リポジトリ直下の `render.yaml` を使って Blueprint から作成できる。手動作成する場合は次の設定にする。

```text
Service type: Web Service
Runtime: Node
Build Command: corepack enable && pnpm install --frozen-lockfile && pnpm build
Start Command: pnpm start
Health Check Path: /api/health
```

## 環境変数

```text
NODE_VERSION=22.22.3
ZAI_API_KEY=...
ZAI_MODEL=glm-5-turbo
ZAI_BASE_URL=https://api.z.ai/api/anthropic
ZAI_TIMEOUT_MS=45000
AMONG_AI_HUMAN_OPTIONAL_INPUT_TIMEOUT_MS=120000
AMONG_AI_STREAM_HEARTBEAT_MS=15000
AMONG_AI_STREAM_WATCHDOG_MS=30000
```

## 運用上の注意

人間参加モードは `src/server/humanSessions.ts` のインメモリセッションを使うため、Render では
`numInstances: 1` の単一インスタンス運用を前提にする。複数インスタンスへ水平スケールする場合は、
セッション状態を Render Key Value などの外部ストアへ移す必要がある。

Free インスタンスはアイドル時にスリープするため、対局用途では有料インスタンスを使う。
