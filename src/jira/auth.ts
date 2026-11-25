import { LinearApiError } from "../linear/client.js";

export const ATLASSIAN_AUTH = "https://auth.atlassian.com";
export const ATLASSIAN_API = "https://api.atlassian.com";
/** Classic Jira scopes (read and write issues, read users) plus the one that makes Atlassian issue a refresh token. */
export const JIRA_SCOPES = ["read:jira-work", "write:jira-work", "read:jira-user", "offline_access"];

/** Where the OAuth client secret and the rotating refresh token live (the macOS keychain in production). */
export interface SecretStore { get(account: string): string | undefined; set(account: string, value: string): void }
export const ACCOUNT = { clientSecret: "client-secret", refreshToken: "refresh-token" } as const;

export interface TokenResponse { access_token: string; expires_in: number; refresh_token?: string; scope?: string }
export interface Site { id: string; name: string; url: string; scopes?: string[] }

const post = async (f: typeof fetch, url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
  const res = await f(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};

export function authorizeUrl(o: { clientId: string; redirectUri: string; state: string; scopes?: string[]; base?: string }): string {
  const q = new URLSearchParams({ audience: "api.atlassian.com", client_id: o.clientId, scope: (o.scopes ?? JIRA_SCOPES).join(" "), redirect_uri: o.redirectUri, state: o.state, response_type: "code", prompt: "consent" });
  return `${o.base ?? ATLASSIAN_AUTH}/authorize?${q}`;
}

export async function exchangeCode(o: { clientId: string; clientSecret: string; code: string; redirectUri: string; fetch?: typeof fetch; base?: string }): Promise<TokenResponse> {
  const r = await post(o.fetch ?? fetch, `${o.base ?? ATLASSIAN_AUTH}/oauth/token`, { grant_type: "authorization_code", client_id: o.clientId, client_secret: o.clientSecret, code: o.code, redirect_uri: o.redirectUri });
  if (r.status !== 200 || typeof r.json.access_token !== "string") throw new LinearApiError(`Atlassian refused the authorisation code (${r.status}${r.json.error ? `: ${String(r.json.error)}` : ""}). Check the client id, secret and callback URL.`, false, r.status, "AUTH");
  return r.json as unknown as TokenResponse;
}

export async function accessibleSites(accessToken: string, f: typeof fetch = fetch, base = ATLASSIAN_API): Promise<Site[]> {
  const res = await f(`${base}/oauth/token/accessible-resources`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new LinearApiError(`could not list your Jira sites (${res.status})`, res.status >= 500, res.status);
  return ((await res.json()) as Site[]).map((s) => ({ id: s.id, name: s.name, url: s.url, scopes: s.scopes }));
}

/**
 * The access token for API calls. Access tokens are short-lived; refresh tokens ROTATE (each refresh returns a new one and disables the
 * old), so the new one is saved before anything else, and refreshes never overlap (a second concurrent refresh would present a used token).
 */
export class JiraAuth {
  private token: { value: string; expires: number } | null = null;
  private inflight: Promise<string> | null = null;
  constructor(private o: { clientId: string; store: SecretStore; fetch?: typeof fetch; base?: string; now?: () => number }) {}

  get connected(): boolean { return Boolean(this.o.store.get(ACCOUNT.refreshToken)); }
  private now() { return (this.o.now ?? Date.now)(); }

  async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expires - 60_000 > this.now()) return this.token.value;
    this.inflight ??= this.refresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** First tokens, from the code exchange. */
  adopt(t: TokenResponse): void {
    if (t.refresh_token) this.o.store.set(ACCOUNT.refreshToken, t.refresh_token);
    this.token = { value: t.access_token, expires: this.now() + t.expires_in * 1000 };
  }

  private async refresh(): Promise<string> {
    const refreshToken = this.o.store.get(ACCOUNT.refreshToken), secret = this.o.store.get(ACCOUNT.clientSecret);
    if (!refreshToken || !secret) throw new LinearApiError("Jira is not connected: connect it in Settings → Tracker", false, undefined, "AUTH");
    const r = await post(this.o.fetch ?? fetch, `${this.o.base ?? ATLASSIAN_AUTH}/oauth/token`, { grant_type: "refresh_token", client_id: this.o.clientId, client_secret: secret, refresh_token: refreshToken });
    if (r.status !== 200 || typeof r.json.access_token !== "string") {
      const permanent = r.status === 400 || r.status === 401 || r.status === 403;
      throw new LinearApiError(permanent ? "Jira authorisation has expired or was revoked (or the app's secret changed): reconnect Jira in Settings → Tracker" : `could not refresh the Jira token (${r.status})`, !permanent, r.status, permanent ? "AUTH" : undefined);
    }
    const t = r.json as unknown as TokenResponse;
    if (t.refresh_token) this.o.store.set(ACCOUNT.refreshToken, t.refresh_token); // rotated: persist before using anything
    this.token = { value: t.access_token, expires: this.now() + t.expires_in * 1000 };
    return this.token.value;
  }
}
