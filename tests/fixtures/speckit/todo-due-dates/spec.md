# Feature Specification: Optional Due Dates for Todo Items

**Feature Branch**: `todo-1-due-dates`

**Created**: 2026-11-25

**Status**: Draft

**Input**: User description: "Add optional due dates to todo items. A todo may have a due date (ISO date). Listing todos must show overdue items first. Items without a due date keep their current order."

## Clarifications

### Session 2026-11-25

Automated run: no human was available, so each answer below was chosen by the agent as the best-supported option from the ticket, the spec and the codebase (which has no existing todo code). Each is an agent decision and can be overridden.

- Q: Which date text formats are accepted as a valid due date? → A: Only extended calendar form `YYYY-MM-DD` (4-digit year, real calendar dates including leap-year rules); datetimes, basic form (`20261201`), surrounding whitespace and other formats are rejected. (Agent decision: FR-002 says "no time-of-day component" and the ticket says "ISO date".)
- Q: How are a missing, null, or empty-string due date treated? → A: Omitted or null means "no due date"; an empty or whitespace-only string is invalid and rejected. (Agent decision: silently treating "" as none would hide input mistakes, consistent with FR-003.)
- Q: When is "today" evaluated for overdue ordering? → A: Once per list request, using the system's local calendar date, applied to every todo in that response. Overdue status is derived at listing time and never stored. (Agent decision: matches the existing Assumption; avoids a list being split by midnight and avoids stale stored flags.)
- Q: Is there a limit on how far in the past or future a due date may be? → A: No limit beyond being a valid 4-digit-year calendar date (0001-01-01 to 9999-12-31); very old dates are simply overdue. (Agent decision: the spec already accepts past dates at creation; limits would add unrequested rules.)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Assign an optional due date to a todo (Priority: P1)

A user creating a todo can optionally give it a due date, expressed as a calendar date (e.g. 2026-12-01). A todo created without a due date behaves exactly as todos do today.

**Why this priority**: Without the ability to store a due date, nothing else in this feature is possible. It is also fully backward compatible.

**Independent Test**: Create one todo with a due date and one without; retrieve both and confirm the first reports its due date and the second reports none.

**Acceptance Scenarios**:

1. **Given** no existing todos, **When** a todo is created with the due date 2026-12-01, **Then** the todo is stored and reports the due date 2026-12-01.
2. **Given** no existing todos, **When** a todo is created without a due date, **Then** the todo is stored and reports no due date.
3. **Given** a todo is being created, **When** the supplied due date is not a valid ISO calendar date (e.g. "tomorrow", "2026-13-40"), **Then** the todo is rejected with a clear error and nothing is stored.

---

### User Story 2 - See overdue todos first when listing (Priority: P1)

When a user lists their todos, items whose due date is earlier than today appear at the top of the list, so the most urgent work is seen first.

**Why this priority**: This is the user-visible payoff of the feature.

**Independent Test**: Create todos with a past due date, a future due date, and no due date; list them and confirm overdue items come first.

**Acceptance Scenarios**:

1. **Given** todos A (no due date), B (due yesterday), and C (due next week) in that creation order, **When** the todos are listed, **Then** B appears first, followed by A and C in their original relative order.
2. **Given** several overdue todos with different due dates, **When** the todos are listed, **Then** all overdue items precede all non-overdue items, with the earliest due date first among them.
3. **Given** a todo due today, **When** the todos are listed, **Then** it is not treated as overdue.
4. **Given** no todo has a due date, **When** the todos are listed, **Then** the order is identical to the order before this feature existed.

---

### Edge Cases

- A todo due exactly today is not overdue; it becomes overdue the following day.
- Two overdue todos with the same due date keep their existing relative order.
- Existing todos created before this feature have no due date and must continue to work unchanged.
- An empty todo list lists as empty.
- A due date such as 2027-02-29 (non-existent day), 2026-12-01T10:00, 20261201, or "" is rejected; omitted or null is accepted as no due date.
- A due date in the past may be supplied at creation; the todo is accepted and immediately counts as overdue.
- Completed todos: this feature does not change how completion is handled (see Assumptions).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A todo MUST be able to carry an optional due date; omitting it is valid.
- **FR-002**: A due date MUST be a real calendar date in ISO 8601 extended format (YYYY-MM-DD, 4-digit year, 0001-01-01 to 9999-12-31, leap years respected) with no time-of-day component. Datetimes, basic format (YYYYMMDD), and whitespace-padded values are invalid.
- **FR-003**: The system MUST reject a due date that is not a valid ISO calendar date (including an empty or whitespace-only string), without storing the todo, and report an error identifying the problem. An omitted or null due date is valid and means "no due date".
- **FR-004**: A todo MUST be considered overdue when its due date is strictly earlier than the current date. "Current date" is the system's local calendar date, read once per list request and applied to all todos in that response; overdue status is derived at listing time and never stored.
- **FR-005**: Listing todos MUST place all overdue todos before all non-overdue todos.
- **FR-006**: Among overdue todos, the list MUST be ordered by due date, earliest first; ties keep their existing relative order.
- **FR-007**: Todos that are not overdue (no due date, or due today or later) MUST keep their current relative order.
- **FR-008**: Todos created before this feature, or without a due date, MUST behave exactly as before.

### Key Entities

- **Todo**: A task item. Existing attributes are unchanged. New attribute: an optional due date (a calendar date). A todo is "overdue" when it has a due date earlier than today.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a list containing a mix of overdue, upcoming, and undated todos, 100% of overdue todos appear before every non-overdue todo.
- **SC-002**: For a list with no due dates, the listing order is identical to the pre-feature order in 100% of cases.
- **SC-003**: 100% of invalid due date inputs are rejected with an error and none are stored.
- **SC-004**: A user can add a due date to a new todo with no extra steps beyond supplying the date.

## Assumptions

- "Today" is determined using the current local calendar date at the time the list is requested.
- Overdue items are sorted earliest-due-first among themselves; the description only requires that they come first, so this is the chosen tie-breaker for a deterministic result.
- Non-overdue dated items (due today or later) are not reordered relative to undated items; only overdue items move.
- Editing the due date of an existing todo, clearing it, and filtering by due date are out of scope for this feature.
- Completion status of todos is outside this feature; if the system tracks completed todos, how overdue ordering treats them is left to existing behavior.
- Time zones and due times are out of scope; due dates are plain calendar dates.
