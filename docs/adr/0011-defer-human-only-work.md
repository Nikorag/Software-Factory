# ADR 0011: Work only a human can do is deferred to the PR, never looped on
The factory is autonomous until the pull request is raised. Some work cannot be done by a sandboxed agent: manual or visual testing, a walkthrough in a real window, real devices or servers, credentials, or a command the check tool does not offer (for example generating a migration). Before this decision, such work became a blocking finding the implementer could only reject, and every rejection bought a full test + review + final-validation cycle until the remediation cap (JAM-414: a manual quickstart walkthrough, rejected three times). The converge step had the same failure mode (job 9c1de607: 14 passes on a migration the implementer could not generate).

Decision:
- **Spec writers tag human-only tasks** `[HUMAN]` in tasks.md (`- [ ] T023 [HUMAN] ...`). The task stays unticked (it is not done) but the `tasks-open` gate does not count it.
- **Agents have an explicit outlet**: the implementer, remediation and converge schemas carry `deferred: [{id, reason}]`. A rejection whose reason says only a person can do it is treated as a deferral. Every deferral is a `human.deferred` decision.
- **Disputes are not re-litigated**: a finding the implementer rejected, raised again with nothing changed (or rejected twice), is deferred instead of starting another cycle. Reviewers are shown earlier cycles and told not to re-raise rejected or deferred findings without new evidence.
- **Deferred items are posted on the PR** under "Needs human verification" (in the body when the PR is created, otherwise as one comment per new batch, each item once).
- **Hard findings are never deferrable**: failing project checks, weakened or deleted tests, protected paths, a dirty tree and conflict markers still loop to the remediation cap and then stop for a human. Secrets and critical security findings still stop the job immediately.

Consequence: a human may see a PR with open verification items; that is intended, since they review every PR anyway (ADR 0002). The cost of a wrong deferral is one checklist item; the cost of a wrong loop was hours of agent time and a held job.
