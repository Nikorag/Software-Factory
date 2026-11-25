# Quickstart: validating due dates

Prerequisites: Node.js, repo root as working directory, no installs needed.

## Run the tests
```sh
npm test        # node --test; expect all tests in tests/ to pass
```

## Manual scenario (after implementation)
```sh
node --input-type=module -e '
import { createTodoStore } from "./src/todos.js";
const s = createTodoStore();
s.add({ title: "A" });
s.add({ title: "B", dueDate: "2026-11-24" });
s.add({ title: "C", dueDate: "2026-12-02" });
console.log(s.list({ now: new Date(2026, 10, 25) }).map(t => t.title).join(","));
try { s.add({ title: "D", dueDate: "2026-13-40" }); } catch (e) { console.log(e.code); }
console.log(s.list().length);
'
```
Expected output: `B,A,C`, then `INVALID_DUE_DATE`, then `3`.

## Spec to check mapping
| Spec item | Check |
|---|---|
| US1-1/2 | add with/without date; `dueDate` is the string / `null` |
| US1-3, FR-003 | invalid inputs throw; list length unchanged |
| US2-1, FR-005/007 | example above |
| US2-2, FR-006 | multiple overdue are ascending by date; ties keep order |
| US2-3, FR-004 | due today is not overdue |
| US2-4, SC-002 | no dates gives insertion order |
| FR-002 edge cases | `2027-02-29`, `2026-12-01T10:00`, `20261201`, `""`, ` 2026-12-01` rejected |
