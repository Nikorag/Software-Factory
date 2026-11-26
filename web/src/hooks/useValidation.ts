import { useEffect, useRef, useState } from "react";
import { validateDefinition } from "@/lib/workflow-api";
import type { Issue, WorkflowDef } from "@/lib/workflows";

export interface Validation { errors: Issue[]; warnings: Issue[]; pending: boolean; failed: string | null; /** the definition the result is about */ for: string }

/** Validates the draft with the server (the same rules that run on save), debounced, ignoring answers to drafts that are already out of date. */
export function useValidation(def: WorkflowDef | null, delayMs = 400): Validation {
  const key = def ? JSON.stringify(def) : "";
  const [v, setV] = useState<Validation>({ errors: [], warnings: [], pending: def !== null, failed: null, for: "" });
  const seq = useRef(0);
  useEffect(() => {
    if (!def) return;
    const mine = ++seq.current;
    setV((x) => ({ ...x, pending: true }));
    const t = setTimeout(() => {
      void validateDefinition(def).then((r) => {
        if (mine !== seq.current) return;
        setV(r.ok ? { errors: r.data.errors, warnings: r.data.warnings, pending: false, failed: null, for: key } : { errors: [], warnings: [], pending: false, failed: r.error, for: key });
      });
    }, delayMs);
    return () => clearTimeout(t);
  }, [key, delayMs]);
  return v;
}
