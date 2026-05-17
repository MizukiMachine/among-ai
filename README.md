# Among AI

AI players run a real-time werewolf match in the browser.

## Stack

- TypeScript
- Hono API server
- React + Vite client
- Server-Sent Events for live game logs
- OpenAI-compatible chat completions API, optional

## Development

```bash
corepack pnpm install
corepack pnpm dev
```

Open `http://localhost:5173`.

The app requests LLM agents by default. If no API key is configured, the server falls back to demo agents and keeps the UI usable. For full LLM mode, set:

```bash
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=...
OPENAI_TIMEOUT_MS=15000
```
