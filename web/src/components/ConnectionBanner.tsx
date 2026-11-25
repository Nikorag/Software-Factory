import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { WifiOff } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ago } from "@/lib/format";

/** True while the Shell's own poll of the API is failing: pages use it to disable their controls (an action would fail too). */
export function useOffline(): boolean {
  const ctx = useOutletContext<{ offline?: boolean } | undefined>();
  return ctx?.offline ?? false;
}

/**
 * Shown whenever a poll is failing, even when older data is on screen, so stale data never looks fresh.
 * With data: "Connection lost: last updated Xs ago". Without: "Cannot load". The Shell's banner is `global`.
 */
export function ConnectionBanner({ error, updatedAt, what = "data", global = false }: { error: string | null; updatedAt: number | null; what?: string; global?: boolean }) {
  const offline = useOffline();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!error || !updatedAt) return;
    const t = setInterval(() => tick((n) => n + 1), 1000); // keep "Xs ago" honest
    return () => clearInterval(t);
  }, [error, updatedAt]);
  if (!error || (offline && !global)) return null; // the Shell already says the whole API is unreachable: one banner, not two
  return (
    <Alert variant="destructive" role="alert" data-testid="connection-lost"><WifiOff /><AlertDescription>
      {updatedAt ? <span><b>Connection lost</b>: the {what} below was last updated {ago(updatedAt)} and may be out of date. Retrying… ({error})</span>
        : <span><b>Cannot load</b> {what}: {error}. Retrying…</span>}
    </AlertDescription></Alert>
  );
}
