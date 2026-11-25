import pino, { type Logger } from "pino";

// Redact anything that could carry credentials before it reaches a log line.
export const REDACT_PATHS = [
  "*.token", "*.apiKey", "*.api_key", "*.password", "*.secret",
  "headers.authorization", "req.headers.authorization", "env", "*.env",
];

export function createLogger(opts: { level?: string; file?: string } = {}): Logger {
  const options = { level: opts.level ?? "info", redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } };
  return opts.file
    ? pino(options, pino.destination({ dest: opts.file, mkdir: true, sync: false }))
    : pino(options);
}
