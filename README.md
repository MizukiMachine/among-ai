# Among AI

AI players run a real-time werewolf match in the browser.

## Stack

- TypeScript
- Hono API server
- React + Vite client
- Server-Sent Events for live game logs
- Z.AI Anthropic-compatible Messages API, optional

## Development

```bash
corepack pnpm install
corepack pnpm dev
```

Open `http://localhost:5173`.

The app requests LLM agents by default. If no API key is configured, the server falls back to demo agents and keeps the UI usable. For full LLM mode, set a Z.AI coding/API key for the Anthropic-compatible endpoint:

```bash
ZAI_API_KEY=...
ZAI_BASE_URL=https://api.z.ai/api/anthropic
ZAI_MODEL=glm-5-turbo
ZAI_TIMEOUT_MS=120000
```

The app locks generation and LLM request concurrency to 6. Day discussion speeches use a speculative race: several AI speakers are generated in parallel, the first completed speech is published, and the remaining stale generations are cancelled or ignored before the next race starts from the updated public history.
