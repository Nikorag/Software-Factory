# ADR 0013: Configurable workflows: declarative definitions, snapshots, and safety enforced by the engine

The factory ran one hard-coded process. Teams want different processes for different work (features, bug fixes, documentation, research) in the same project, chosen by Linear label, with their own prompts, models and gates.

Decisions:
- **Workflows are data, not code.** A definition is a validated, declarative list of stages drawn from a registry of types implemented in code (`factory`, `agent`, `review`, `check`, `conditional`). There is no script stage. Adding a capability means adding a type in code.
- **The existing process is the built-in Default Workflow**, derived from the factory's own state machine and `workflows.yaml`, read-only, and the fallback. Existing handlers are wrapped, not rewritten: the engine was adapted to read transitions from a snapshot instead of a hard-coded table, and all existing engine and flow tests pass unchanged on that path.
- **Definitions, library, assignments and resolution are separate.** Assignments reference workflows by id; labels by their stable tracker id; resolution is label (by priority, then a configurable conflict policy) → project → global default; an unavailable workflow is reported, never replaced.
- **A job runs an immutable snapshot** taken at creation, so edits, renames, disabling and re-assignment affect only future jobs, and recovery and retries are unchanged.
- **Safety does not depend on configuration.** Mandatory stages (eligibility before any side effect; independent/security review and final validation before a PR) are checked when a workflow is saved (dominance in the stage graph) and again by the engine before a guarded stage runs. Custom stages can only use read-only agent roles; a critical finding, `blocked`, `needs_attention` and `fail` cannot be routed around; loops are bounded by acyclic success paths, fix-cycle budgets, a per-job attempt cap and system ceilings that the engine re-applies to stored snapshots.
- **Gates only tighten.** A success gate is evaluated after the stage reports success, so it can add conditions but never turn a failure into a pass.

Consequences: factory stages keep fixed prompts (workflows add instructions, not replace them) and their ids equal their handler names; custom stages cannot write files. These are deliberate: they keep every file-changing path inside the code that scans for secrets, checks protected paths and enforces the sandbox.
