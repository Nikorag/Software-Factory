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
/**
 * The access keys AWS itself publishes in its documentation. They are public and can never be live credentials, so a test
 * fixture or doc snippet that uses one must not stop a job (seen live: JAM-66's lessons tests). Built from two halves so this
 * file does not match its own rule. Exact matches only: any other AKIA/ASIA value, however "example"-like, still counts.
 */
const AWS_DOC_KEYS = new Set(["AKIAIOSFODNN7" + "EXAMPLE", "AKIAI44QH8DHB" + "EXAMPLE", "ASIAIOSFODNN7" + "EXAMPLE"]);
const PLACEHOLDER = /(example|placeholder|changeme|your[_-]|xxxx|<[^>]+>|dummy|fake|test|redacted|\*{4})/i;

/** Test files: where made-up credentials live as fixtures (`const SECRET = "s3cr3t-value-123"`). */
export const isTestFile = (path: string): boolean => /(^|\/)(tests?|__tests__|__mocks__|spec)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);

/** Scans added lines. Values that look like documentation placeholders are ignored. `skip` turns rules off for these lines. */
export function scanForSecrets(lines: string[], skip: ReadonlySet<string> = new Set()): SecretHit[] {
  const hits: SecretHit[] = [];
  lines.forEach((l, i) => {
    for (const { rule, re } of RULES) {
      if (skip.has(rule)) continue;
      const m = re.exec(l);
      if (!m) continue;
      if (rule === "credential-assignment" && PLACEHOLDER.test(m[0])) continue;
      if (rule === "aws-access-key" && AWS_DOC_KEYS.has(m[0])) continue;
      hits.push({ rule, line: i + 1, preview: `${l.trim().slice(0, 12)}…[${rule}]` }); // never echo the secret itself
      break;
    }
  });
  return hits;
}

/**
 * The history scan: every rule everywhere, except that test files do not trip the generic `credential-assignment` heuristic
 * (a fixture like `const SECRET = "s3cr3t-value-123"` is indistinguishable from a real one by shape, and stopped JAM-64).
 * Rules for real token formats (AWS, GitHub, Anthropic, private keys...) still apply in tests, since a pasted live credential
 * there is exactly as bad as anywhere else.
 */
export function scanHistoryForSecrets(added: { file: string; line: string }[]): SecretHit[] {
  const code = added.filter((a) => !isTestFile(a.file)).map((a) => a.line);
  const tests = added.filter((a) => isTestFile(a.file)).map((a) => a.line);
  return [...scanForSecrets(code), ...scanForSecrets(tests, new Set(["credential-assignment"]))];
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
