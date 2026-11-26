import type { WorkflowListItem } from "@/lib/workflows";
import { Pick } from "./fields";

/** Choose a workflow from the library. Disabled ones can still be chosen (an existing assignment may point at one) but are marked. `empty` adds a "none" first option. */
export function WorkflowSelect({ workflows, value, onChange, empty, label, className, disabled }: { workflows: WorkflowListItem[]; value: string | undefined; onChange: (id: string | undefined) => void; empty?: string; label: string; className?: string; disabled?: boolean }) {
  const known = value === undefined || workflows.some((w) => w.id === value);
  return (
    <Pick label={label} value={value} empty={empty} disabled={disabled} className={className ?? "w-64"} onChange={onChange}
      options={[...workflows.map((w) => ({ value: w.id, label: `${w.name}${w.enabled ? "" : " (disabled)"}${w.valid ? "" : " (invalid)"}` })), ...(known ? [] : [{ value: value!, label: `${value} (missing)` }])]} />
  );
}
