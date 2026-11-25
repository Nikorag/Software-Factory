---

description: "Task list for Optional Due Dates for Todo Items"
---

# Tasks: Optional Due Dates for Todo Items

**Input**: Design documents from `/specs/todo-1-due-dates/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/todo-module.md, quickstart.md

**Tests**: Included. plan.md commits to "a test for every FR" and the technical context requires `node --test` (`node:test` + `node:assert/strict`). Agent decision, recorded because the run was automated.

**Organization**: Grouped by user story. Plain Node.js ES modules, no new dependencies.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 or US2
- Field constraints are defined in `data-model.md`; tasks cite `Entity.field` instead of restating them.

## Path Conventions

Single project: `src/` and `tests/` at the repository root (see plan.md). `src/math.js` is existing and must not be touched.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Enable ES modules and test layout

- [ ] T001 Add `"type": "module"` to `package.json` (keep the existing `"test": "node --test"` script; add no dependencies) per research.md D1
- [ ] T002 [P] Create the empty `tests/` directory by adding the first test file in later tasks; confirm `src/math.js` still imports/works under `"type": "module"` (no edits to `src/math.js`)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared date primitives used by both stories

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T003 [P] Write tests in `tests/due-date.test.js` for `parseDueDate`, `isValidDueDate`, `todayLocal`, `isOverdue`, and `InvalidDueDateError` per `contracts/todo-module.md`; cover valid dates, leap years, and every invalid example listed under "Validation rules (DueDate)" in `data-model.md` (`Todo.dueDate`); confirm they fail first
- [ ] T004 Implement `src/due-date.js` exporting `parseDueDate`, `isValidDueDate`, `todayLocal(now?)`, `isOverdue(dueDate, today)` and `InvalidDueDateError` (`code = "INVALID_DUE_DATE"`, message names the value). Validation follows `data-model.md` `Todo.dueDate` using research.md D2 (regex then UTC round-trip with `setUTCFullYear`); `todayLocal` uses local getters per D4; overdue is the string comparison in `data-model.md` "Derived: overdue" (depends on T003)

**Checkpoint**: Date primitives pass `node --test tests/due-date.test.js`

---

## Phase 3: User Story 1 - Assign an optional due date to a todo (Priority: P1) 🎯 MVP

**Goal**: Todos can be created with or without a valid due date; invalid dates are rejected and nothing is stored.

**Independent Test**: Add one todo with a due date and one without; `list()` shows the string and `null` respectively; invalid dates throw `InvalidDueDateError` and the list length is unchanged.

### Tests for User Story 1

> Write these first and confirm they fail before implementation

- [ ] T005 [P] [US1] Store tests in `tests/todos.test.js` for `add`: with date (US1-1), without date and with `null` (US1-2, FR-001, FR-008), invalid dates throw `InvalidDueDateError` and leave `list()` unchanged (US1-3, FR-003, SC-003), including `""`, `2027-02-29`, `2026-12-01T10:00`, `20261201`, padded value, non-string; `id`/`title` rules per `data-model.md` `Todo.id` and `Todo.title` (non-empty title throws `TypeError`)

### Implementation for User Story 1

- [ ] T006 [US1] Implement `createTodoStore()` with `add({ title, dueDate? })` and a minimal `list()` (insertion order) in `src/todos.js`. Validate `dueDate` via `parseDueDate` before assigning an id or storing (research.md D6); implement `Todo.id` and `Todo.title` and `Todo.dueDate` as defined in `data-model.md`; return `{ id, title, dueDate }` (depends on T004, T005)

**Checkpoint**: US1 tests pass; store works independently with insertion-order listing

---

## Phase 4: User Story 2 - See overdue todos first when listing (Priority: P1)

**Goal**: `list()` puts overdue todos first, earliest due first, everything else in original order.

**Independent Test**: With today = 2026-11-25, A (none), B (2026-11-24), C (2026-12-02) lists as B, A, C.

### Tests for User Story 2

- [ ] T007 [P] [US2] Tests in `tests/order.test.js` for `orderTodos(todos, today)`: US2-1 example, multiple overdue ascending (US2-2, FR-006), same-date ties keep order, due today not overdue (US2-3, FR-004), no due dates gives identical order (US2-4, SC-002, FR-007), empty list, input array and items not mutated, items lacking `dueDate` treated as `null` (research.md D7, FR-008)
- [ ] T008 [P] [US2] Add integration tests to `tests/todos.test.js` for `list({ now })`: contract table examples in `contracts/todo-module.md` (today = 2026-11-25, using `new Date(2026, 10, 25)`), and `today` read once per call (depends on T005 for file creation; append, do not overwrite)

### Implementation for User Story 2

- [ ] T009 [P] [US2] Implement `orderTodos(todos, today)` in `src/order.js`: copy, split overdue vs rest using `isOverdue`, stable-sort overdue by `Todo.dueDate` ascending (`data-model.md` "Ordering"), return `[...overdue, ...rest]` per research.md D5 (depends on T004)
- [ ] T010 [US2] Update `list({ now } = {})` in `src/todos.js` to compute `todayLocal(now ?? new Date())` once and return `orderTodos(...)` (depends on T006, T009)

**Checkpoint**: All tests pass; US1 and US2 both work

---

## Phase 5: Polish & Cross-Cutting Concerns

- [ ] T011 Run `npm test` and confirm all tests in `tests/` pass and `src/math.js` is unchanged
- [ ] T012 Run the manual scenario in `quickstart.md`; expect `B,A,C`, `INVALID_DUE_DATE`, `3`

---

## Dependencies & Execution Order

- Setup (T001-T002) → Foundational (T003-T004) → US1 (T005-T006) → US2 (T007-T010) → Polish (T011-T012)
- US2 `list` integration (T010) builds on the US1 store (T006); `orderTodos` (T009) depends only on T004, so it can be built in parallel with US1.
- Tests precede implementation within each phase.
- T008 and T005 edit the same file (`tests/todos.test.js`), so they are not run in parallel.

### Parallel Opportunities

- T002 with T001 (after T001 is merged only for the module check, otherwise sequential)
- T003 can start alongside T001/T002
- After T004: T005, T007, T009 touch different files and can run in parallel

```text
# After T004:
Task: "Store tests in tests/todos.test.js (T005)"
Task: "orderTodos tests in tests/order.test.js (T007)"
Task: "Implement orderTodos in src/order.js (T009)"
```

## Implementation Strategy

### MVP First (User Story 1)

1. Phases 1-2, then Phase 3; stop and validate with `node --test`. This delivers storing and validating due dates. The user-visible payoff (overdue first) is US2, also P1, so ship both for the full feature.

### Incremental Delivery

1. Setup + Foundational → primitives ready
2. US1 → store with validated due dates
3. US2 → overdue ordering; run quickstart.md

## Notes

- Never store overdue status; derive it at list time.
- Commit after each task or logical group.
