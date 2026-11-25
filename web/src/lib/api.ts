// Everything that originates from tickets, agents or logs is untrusted. React escapes text children, and this app never injects raw
// markup or builds HTML strings, so that content can only ever be rendered as text.
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

/**
 * Changes are same-origin requests from this page: the browser adds Origin / Sec-Fetch-Site itself and the custom header cannot be
 * sent cross-origin without a CORS preflight the server never grants. There is no token to paste. Resolves to an error message, or null.
 */
export async function post(path: string, body: unknown = {}): Promise<string | null> {
  try {
    const res = await fetch(path, { method: "POST", headers: { "X-Factory-UI": "1", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) return ((await res.json().catch(() => ({}))) as { error?: string }).error || `HTTP ${res.status}`;
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Like post(), for settings: any method, and the response body (or the server's error message). */
export async function send<T = unknown>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(path, { method, headers: { "X-Factory-UI": "1", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return res.ok ? { ok: true, data: data as T } : { ok: false, error: data.error || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
