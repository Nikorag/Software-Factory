import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

// The dashboard is a few static files (no framework, no build step, no third-party scripts), so the
// Content-Security-Policy can be strict: only same-origin scripts/styles, no inline code, no framing.
const FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/favicon.png": { file: "favicon.png", type: "image/png" },
};

export function publicDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "public"); // src/public in dev (tsx), dist/public once built
}

export const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
  "strict-transport-security": "max-age=31536000", "permissions-policy": "publickey-credentials-get=(self), publickey-credentials-create=(self)",
};

export function registerUi(app: FastifyInstance, dir = publicDir()) {
  for (const [url, { file, type }] of Object.entries(FILES)) {
    const body = readFileSync(join(dir, file));
    app.get(url, async (_req, reply) => reply.header("content-type", type).header("cache-control", url === "/" ? "no-cache" : "public, max-age=300").send(body));
  }
}
