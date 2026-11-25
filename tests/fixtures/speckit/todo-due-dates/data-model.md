# Data Model

## Todo
| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | number | yes | Assigned by the store, incrementing from 1 (the repo has no prior todo model) |
| `title` | string | yes | Non-empty string; the store throws `TypeError` otherwise |
| `dueDate` | string \| null | no | `YYYY-MM-DD` or `null`. Omitted/`undefined`/`null` at creation becomes `null` |

## Validation rules (DueDate)
- `undefined`/`null` is valid and stored as `null`.
- Otherwise it must be a string matching `^\d{4}-\d{2}-\d{2}$`, year 0001-9999, and a real calendar date (leap years respected).
- Invalid: `""`, whitespace-only or padded, `2026-13-40`, `2027-02-29`, `2026-12-01T10:00`, `20261201`, `tomorrow`, `0000-01-01`, non-strings.

## Derived: overdue
`overdue(todo, today) = todo.dueDate != null && todo.dueDate < today` (string comparison). Never stored. `today` is the local `YYYY-MM-DD`, computed once per `list()` call.

## Ordering (list)
1. Overdue todos, by `dueDate` ascending; ties keep insertion order.
2. All other todos (undated, due today or later) in insertion order.

## State transitions
None. Editing/clearing due dates, filtering and completion are out of scope.
