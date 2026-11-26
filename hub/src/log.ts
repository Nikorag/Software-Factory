import pino, { type Logger } from "pino";

// Never let credentials, tokens, passkey material or VAPID keys reach stdout.
export const REDACT = [
  "req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']",
  "*.authorization", "*.cookie", "*.token", "*.secret", "*.password", "*.privateKey",
  "*.publicKey", "*.credential", "*.credentialId", "*.attestation", "*.assertion",
  "*.p256dh", "*.auth", "*.endpoint", "*.vapidPrivateKey", "*.databaseUrl", "*.redisUrl",
  "*.payload", "*.result",
];

export function createLogger(level: string, destination?: pino.DestinationStream): Logger {
  return pino({ level, base: { service: "software-factory-hub" }, timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT, censor: "[REDACTED]" }, formatters: { level: (label) => ({ level: label }) } }, destination);
}
