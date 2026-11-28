import type { Invocation, JobDetail } from "@/lib/types";

/** The lesson ids a run was given (recorded in its usage). */
export const lessonIdsOf = (run: Pick<Invocation, "usage">): number[] => (Array.isArray(run.usage?.lessons) ? run.usage.lessons.filter((n) => Number.isInteger(n)) : []);

/** Which project lessons one agent run saw. Text is untrusted-derived, so it is only ever rendered as text. */
export function RunLessons({ run, known }: { run: Pick<Invocation, "usage">; known: JobDetail["lessonsInjected"] }) {
  const ids = lessonIdsOf(run);
  if (ids.length === 0) return <span className="text-muted-foreground">none</span>;
  return (
    <span className="flex flex-wrap gap-1" aria-label={`${ids.length} lessons injected`}>
      {ids.map((id) => {
        const l = known?.find((k) => k.id === id);
        return <span key={id} title={l ? `${l.kind}: ${l.text}` : "lesson no longer available"} className="rounded border border-[var(--z-line)] px-1.5 py-0.5 font-mono text-xs">#{id}{l ? ` ${l.kind}` : ""}</span>;
      })}
    </span>
  );
}
