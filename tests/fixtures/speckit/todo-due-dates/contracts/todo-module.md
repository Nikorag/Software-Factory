# Contract: Todo module (public library API)

The project is a library, so the contract is its ES-module exports.

## `src/due-date.js`
- `parseDueDate(value) => string | null`: returns `null` for `undefined`/`null`; returns the string if valid; throws `InvalidDueDateError` otherwise.
- `isValidDueDate(value: unknown) => boolean`: true only for a valid non-null `YYYY-MM-DD` string.
- `todayLocal(now?: Date) => string`: local calendar date as `YYYY-MM-DD`.
- `isOverdue(dueDate: string | null, today: string) => boolean`
- `class InvalidDueDateError extends Error` with `code = "INVALID_DUE_DATE"`; the message names the value.

## `src/order.js`
- `orderTodos(todos: Todo[], today: string) => Todo[]`: pure; returns a new array; does not mutate input or items.

## `src/todos.js`
- `createTodoStore() => { add(input), list(options?) }`
  - `add({ title, dueDate? }) => Todo`: validates `dueDate` first; on error throws and stores nothing. Returns `{ id, title, dueDate }`.
  - `list({ now?: Date } = {}) => Todo[]`: reads today once from `now ?? new Date()`, returns the ordered copy.

## Behaviour examples (today = 2026-11-25)
| Input | Result |
|---|---|
| A (none), B (2026-11-24), C (2026-12-02) | B, A, C |
| X (2026-11-20), Y (2026-11-10), Z (none) | Y, X, Z |
| Todo due 2026-11-25 | not overdue; stays in place |
| `add({title:"t", dueDate:"2026-13-40"})` | throws `InvalidDueDateError`; list unchanged |
| `add({title:"t", dueDate:""})` | throws |
| `add({title:"t", dueDate:null})` | ok, `dueDate: null` |
