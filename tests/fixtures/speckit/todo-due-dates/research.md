# Research: Optional Due Dates

No NEEDS CLARIFICATION remain in Technical Context. The spec's clarification session already fixed formats and semantics. Decisions below are agent decisions from an automated run (no human available) and can be overridden.

## Existing codebase
Only `src/math.js` (`add`) exists; `package.json` has `"test": "node --test"` and no `"type"` field. There is no todo code, so a minimal todo store is created as part of this feature.

## D1: Module system
- **Decision**: Add `"type": "module"` to `package.json`; write `.js` ES modules.
- **Rationale**: `src/math.js` already uses `export`; the field makes module intent explicit and portable. It is not a dependency.
- **Alternatives**: `.mjs` extensions (inconsistent with `math.js`); CommonJS (contradicts the requirement).

## D2: Date validation
- **Decision**: Regex `^\d{4}-\d{2}-\d{2}$`, then check the calendar by building a UTC date (using `setUTCFullYear` so years < 100 work) and confirming year, month and day round-trip. Year 0000 is rejected.
- **Rationale**: Satisfies FR-002/003 (rejects datetimes, basic form, whitespace, `""`, 2027-02-29) with no library. `Date.parse` is rejected because it accepts non-ISO text and datetimes. UTC avoids DST/zone artifacts.
- **Alternatives**: `Temporal` (not universally available); a days-in-month table (more code, same result); a date library (forbidden).

## D3: Representation and comparison
- **Decision**: Store `dueDate` as the validated string or `null`; compare as strings.
- **Rationale**: Zero-padded 4-digit `YYYY-MM-DD` sorts lexicographically in chronological order, so no parsing at list time and no timezone drift.
- **Alternatives**: `Date` objects (zone bugs, mutable).

## D4: "Today"
- **Decision**: `todayLocal(now = new Date())` formats local `getFullYear/getMonth/getDate`, zero-padded. `list()` calls it once and passes it to `orderTodos`; `list` accepts an optional `now` for tests.
- **Rationale**: FR-004 (local date, once per request). `toISOString()` is UTC and can be off by one day.
- **Alternatives**: global clock mocking (heavier; an injectable `now` is simpler).

## D5: Ordering algorithm
- **Decision**: Copy the array, split into `overdue` (`dueDate != null && dueDate < today`) and `rest`; stable-sort `overdue` by `dueDate` ascending; return `[...overdue, ...rest]`.
- **Rationale**: Meets FR-005/006/007 exactly; `Array.prototype.sort` is stable, so ties keep insertion order. With no due dates, output equals insertion order (SC-002).
- **Alternatives**: one comparator over mixed items (easy to break the "non-overdue keep order" rule).

## D6: Error handling
- **Decision**: `add` throws `InvalidDueDateError` (an `Error` subclass with `code: "INVALID_DUE_DATE"`) whose message includes the offending value; validation happens before an id is assigned or anything is stored. Non-string, non-null values are invalid.
- **Rationale**: FR-003, SC-003.
- **Alternatives**: result objects (less idiomatic for a plain library).

## D7: Existing todos
- **Decision**: Todos lacking a `dueDate` property are read as `null` when listing (`todo.dueDate ?? null`).
- **Rationale**: FR-008.
