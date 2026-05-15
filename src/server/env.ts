import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function unquote(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function loadDotEnv(path = resolve(process.cwd(), ".env")): void {
  if (!existsSync(path)) {
    return;
  }

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7).trimStart() : trimmed;
    const separator = withoutExport.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = unquote(withoutExport.slice(separator + 1));
  }
}
