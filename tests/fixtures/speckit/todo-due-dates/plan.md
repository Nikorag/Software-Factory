# Implementation Plan: Optional Due Dates for Todo Items

**Branch**: `todo-1-due-dates` | **Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/todo-1-due-dates/spec.md`

## Summary

Add an optional `dueDate` (`YYYY-MM-DD`) to todos and make listing put overdue todos first (earliest due first, stable ties), leaving all other todos in their current order. Approach: a small in-memory ES-module library with pure functions (date validation, overdue test, ordering) and a todo store that calls them. "Today" is read once per list call. No dependencies.

## Technical Context

**Language/Version**: Node.js (plain JavaScript, ES modules); relies only on the stable-sort guarantee of `Array.prototype.sort`

**Primary Dependencies**: None (no new dependencies; Node built-ins only)

**Storage**: In-memory array held by the store instance. The repo has no existing persistence or todo code, so none is introduced.

**Testing**: `node --test` (`npm test`), using `node:test` and `node:assert/strict`

**Target Platform**: Node.js runtime (library, no server)

**Project Type**: Single project / library

**Performance Goals**: N/A; lists are small, sort is O(n log n)

**Constraints**: No new dependencies; plain ES modules; "today" is the local calendar date read once per list request; overdue is never stored

**Scale/Scope**: One entity, three small modules, one test file per module

## Constitution Check

`.specify/memory/constitution.md` is the unfilled template (placeholders only), so it defines no ratified principles or gates. Result: **PASS (vacuous)**; no violations, so Complexity Tracking is not needed. Self-imposed principles applied anyway: simplicity (no deps, pure functions) and a test for every FR. Recommendation: ratify a constitution via `/speckit-constitution` later.

Post-design re-check: still PASS; the design adds no projects, dependencies, or abstractions beyond three small modules.

## Project Structure

### Documentation (this feature)

```text
specs/todo-1-due-dates/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── todo-module.md
└── tasks.md             # created later by /speckit-tasks
```

### Source Code (repository root)

```text
package.json             # add "type": "module" (for plain .js ES modules)
src/
├── math.js              # existing, untouched
├── due-date.js          # parseDueDate / isValidDueDate / todayLocal / isOverdue
├── order.js             # orderTodos(todos, today)
└── todos.js             # createTodoStore(): add(), list()
tests/
├── due-date.test.js
├── order.test.js
└── todos.test.js
```

**Structure Decision**: Single project with `src/` and `tests/` at the root, matching the existing layout. `order.js` is separate so ordering is a pure function testable without a store.

## Complexity Tracking

No constitution violations; nothing to justify.
