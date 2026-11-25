export interface SecretHit { rule: string; line: number; preview: string }

// Deliberately conservative: a false positive stops a job for a human; a false negative could publish a credential.
const RULES: { rule: string; re: RegExp }[] = [
  { rule: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { rule: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { rule: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { rule: "linear-api-key", re: /\blin_(?:api|oauth)_[A-Za-z0-9]{20,}\b/ },
  { rule: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { rule: "openai-style-key", re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { rule: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { rule: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: "stripe-key", re: /\b[sr]k_live_[0-9A-Za-z]{20,}\b/ },
  { rule: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { rule: "credential-assignment", re: /\b(?:api[_-]?key|secret|passw(?:or)?d|token)\b["']?\s*[:=]\s*["'][A-Za-z0-9/+_\-=]{16,}["']/i },
];
const PLACEHOLDER = /(example|placeholder|changeme|your[_-]|xxxx|<[^>]+>|dummy|fake|test|redacted|\*{4})/i;

/** Scans added lines. Values that look like documentation placeholders are ignored. */
export function scanForSecrets(lines: string[]): SecretHit[] {
  const hits: SecretHit[] = [];
  lines.forEach((l, i) => {
    for (const { rule, re } of RULES) {
      const m = re.exec(l);
      if (!m) continue;
      if (rule === "credential-assignment" && PLACEHOLDER.test(m[0])) continue;
      hits.push({ rule, line: i + 1, preview: `${l.trim().slice(0, 12)}…[${rule}]` }); // never echo the secret itself
      break;
    }
  });
  return hits;
}

/** For display only (the dashboard's conversation view): replaces anything that looks like a credential. Conservative, like the scanner. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { rule, re } of RULES) {
    if (rule === "credential-assignment") out = out.replace(new RegExp(re.source, `${re.flags.replace("g", "")}g`), (m) => (PLACEHOLDER.test(m) ? m : `[redacted:${rule}]`));
    else out = out.replace(new RegExp(re.source, `${re.flags.replace("g", "")}g`), `[redacted:${rule}]`);
  }
  return out;
}
