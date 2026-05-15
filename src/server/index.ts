import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app";
import { loadDotEnv } from "./env";

loadDotEnv();

const app = createApp();

if (process.env.NODE_ENV === "production") {
  app.use("/*", serveStatic({ root: "./dist/client" }));
  app.get("*", serveStatic({ path: "./dist/client/index.html" }));
}

const port = Number(process.env.PORT ?? 8787);

serve({
  fetch: app.fetch,
  port
});

console.log(`Among AI API listening on http://localhost:${port}`);
