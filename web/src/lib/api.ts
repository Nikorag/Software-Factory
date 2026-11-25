// Everything that originates from tickets, agents or logs is untrusted. React escapes text children, and this app never injects raw
// markup or builds HTML strings, so that content can only ever be rendered as text.
const KEY = "factory-token";

export function loadToken(): string {
  try {
    const m = /#token=([0-9a-f]+)/.exec(window.location.hash);
    if (m) {
      sessionStorage.setItem(KEY, m[1]!);
      history.replaceState(null, "", window.location.pathname + "#/"); // keep it out of the URL bar and history
    }
    return sessionStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}
export const getToken = () => { try { return sessionStorage.getItem(KEY) ?? ""; } catch { return ""; } };

export async function api<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function apiText(path: string): Promise<string> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `HTTP ${res.status}`);
  return res.text();
}

/** Controls need the token. Resolves to an error message, or null on success. */
export async function post(path: string, body: unknown = {}): Promise<string | null> {
  const token = getToken();
  if (!token) return "Controls need the control token. Open the dashboard with: pnpm factory dashboard --open";
  try {
    const res = await fetch(path, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) return ((await res.json().catch(() => ({}))) as { error?: string }).error || `HTTP ${res.status}`;
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
