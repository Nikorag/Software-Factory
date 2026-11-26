// Ship SQL migrations and the static dashboard next to the compiled code so `dist/` is self-contained.
import { cpSync, mkdirSync } from "node:fs";
mkdirSync("dist/migrations", { recursive: true });
cpSync("migrations", "dist/migrations", { recursive: true });
cpSync("src/public", "dist/public", { recursive: true });
