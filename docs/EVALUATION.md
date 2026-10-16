# AgentShield evaluation

Measured on 2026-10-16 at commit `e9b65ed` (Node 22.13.1, win32 10.0.26200 x64). Regenerate with `npm run build && npm run eval`.

These numbers are for **our own test set**, written by the team. They are not a claim about unseen attacks. The Rule of Two exists because detection will miss things.

| Measure | Result |
|---|---|
| Attack corpus: cases that reach their expected level | **85 / 85** (100.0%) |
| Mutated attacks (generated disguises of the shell attacks) | **367 / 367** (100.0%) |
| Benign corpus: blocks | **0 / 100** (must be 0) |
| Benign corpus: asks | **0 / 100** (must be 0) |
| Scenarios S1 to S10 matching their expected result | **10 / 10** (asserted in `test/server.test.ts`) |
| Engine latency, in process | p50 0.07 ms, p95 0.19 ms over 5550 evaluations |
| Hook end to end, spawned like an agent app | p50 176 ms, p95 258 ms (of which Node start-up alone: 118 ms on this machine) |

## Attack corpus by category (top finding)

| Category | Reached expected level |
|---|---|
| DESTROY | 24 / 24 |
| EXEC | 7 / 7 |
| EXFIL | 14 / 14 |
| INJECT | 4 / 4 |
| PII | 1 / 1 |
| PRIV | 2 / 2 |
| SECRET | 8 / 8 |
| SUPPLY | 1 / 1 |
| TAMPER | 24 / 24 |

## Mutations

Each Bash attack in the corpus is rewritten with every Bash disguise below, and each PowerShell attack with every PowerShell disguise, where the disguise applies. The mutated command must still reach the level of the original.

| Disguise | Still caught |
|---|---|
| empty quotes in the command word | 51 / 51 |
| backslash in the command word | 51 / 51 |
| $IFS instead of spaces | 42 / 42 |
| wrapped in bash -c | 47 / 47 |
| sudo prefix | 54 / 54 |
| env assignment prefix | 55 / 55 |
| base64 piped into sh | 55 / 55 |
| -EncodedCommand | 8 / 8 |
| backtick in the cmdlet name | 2 / 2 |
| string concatenation and the call operator | 2 / 2 |

No mutated attack fell below its expected level.


## Known limits

- Rules see text, not meaning. New disguises and non-English instructions can be missed; the Rule of Two and the optional Gemini judge (raise-only) are the backstops.
- Leaks through allowed places (an allowed host, an issue comment, a gist on an allowed account) are only caught when the Rule of Two applies.
- Images are not scanned.
- On unmanaged machines a user can remove the hooks. Use the agent vendor's managed settings for enforcement.
- Claude Code keeps a blocked prompt in its local transcript. Rotate any key that was pasted.
