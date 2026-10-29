# File reference

Every file under `engine/`, and under each the functions or CLI commands it exposes with a one-line note on what each does.

## engine/config.json

The lane map. Each lane name maps to an object with `implementer` (which CLI), `model`, and optionally `provider` and `readOnly`. A lane is a named routing slot that binds one CLI to one model. Lanes present: `review-main`, `review-debate`, `feature`, `complex`, `tests`, `fast`, `ui`, `grind`, `patch`, `deep-free`, `flash-free`, `kilo`, `cohere`, `aider-nim`, `aider-nim-code`, `aider-sn`, `aider-sn-code`.

## engine/economy.mjs

The salary and quota ledger CLI. Node, no dependencies. Run as `node engine/economy.mjs <command> [args]`.

### CLI commands
- `pick --role <role> --mission <id>`: prints the best eligible model for the role without spending.
- `spend --role <role> --mission <id>` or `spend --model <id> --mission <id>`: increments `dispatches[model]` and `pool_used[pool]`, then saves the ledger.
- `choke --model <id> --mission <id> [--why <str>] [--pool]`: adds the model (and, with `--pool`, every model sharing its `quota_pool`) to the chokes list, records a handover to the first eligible model in its `handover_to`, and saves.
- `status --mission <id>`: prints per-pool used/limit/remaining, plus spent dispatches and chokes.

### Functions
- `loadModels()`: reads and parses `models.json`.
- `loadTemplate()`: reads and parses `ledger.template.json`.
- `ledgerPath(mission)`: returns the path `ledger.<mission>.json`.
- `loadLedger(mission)`: loads the mission ledger, creating it from the template (with the started date and empty dispatches, pool_used, chokes, handovers) when it does not exist.
- `saveLedger(mission, ledger)`: writes the ledger back to disk.
- `parseLimit(limit)`: turns a number, or a string such as `"~1000/mo, 20 RPM"`, into an integer; returns Infinity when it finds no number.
- `isEligible(model, ledger, modelsData)`: false if the model tier is DEAD, if it is in the ledger chokes, if its used dispatches reached `salary_dispatches` (string `"inf"` means Infinity), or if its `quota_pool` hit the pool limit; otherwise true.
- `roleChain(role)`: returns the fallback chain from a role along `deep -> analysis -> code -> grind`, sliced from the given role onward.
- `pickBest(role, ledger, modelsData)`: walks the role chain; for each role filters eligible models and sorts by intelligence descending, then free-first, then smaller pool limit, then id; returns the first match or null.
- `formatPick(model, ledger, modelsData)`: builds the JSON summary (model id, cli, lane, quota_pool, salary_remaining, pool_remaining, handover_to).
- `cmdPick`, `cmdSpend`, `cmdChoke`, `cmdStatus`: the command handlers behind the CLI verbs above.
- `parseArgs(argv)`: parses `--flag value` pairs into an object.
- `main()`: dispatches on the first argument to the matching command handler.

### Environment overrides
- `CONFIG_DIR` (default `/home/kali/.config/delegate-skills`), `MODELS_FILE`, `TEMPLATE_FILE`.

## engine/consensus.mjs

The parallel fan-out engine. Given one brief, it dispatches that brief to several fleet lanes at once and collects every result into one file.

## engine/live-tier.mjs

The live tiering engine. Enumerates free models across keyed providers and CLI catalogs, probes each
with a test prompt, drops paid imposters and non-serving models, scores intelligence (rubric plus a
parameter-size heuristic), tiers T1 to T4, derives salary from each quota pool, builds cross-pool
fallback chains, and rewrites free_models.json and models.json. Reads provider keys from the local
env file at runtime. Flags: --no-probe (skip probing), --dry (preview without writing). Intended to
run on a schedule (for example cron every 4 hours).

### CLI
`node engine/consensus.mjs --brief <file> --lanes <l1,l2,...> [--cd <dir>] [--out-dir <dir>] [--timeout <dur>] [--mission <name>]`
- `--brief <file>`: required, the brief text file.
- `--lanes <csv>`: required, comma-separated lane names from `config.json`.
- `--cd <dir>`: working root passed to each relay (default: current directory).
- `--out-dir <dir>`: where `consensus.json` and the per-lane subdirectories are written (default: a fresh temp dir).
- `--timeout <dur>`: passed through to each relay.
- `--mission <name>`: label recorded in `consensus.json` and used for metering.
- `-h`, `--help`: print help and exit.

### Behavior and functions
- For each lane it looks up the lane in `config.json`, resolves the implementer relay at `~/.claude/skills/<implementer>-delegate/scripts/relay.mjs`, spawns `node relay.mjs` in parallel, waits for all, reads each lane's `result.json`, and writes one combined `consensus.json` (schema `delegate-consensus.v1`).
- A lane can end as `unknown_lane`, `no_relay`, `no_result`, `bad_result`, or the relay's own status (such as `completed`). The process exits 0 if any lane completed.
- `economyIdFor(implementer, model, modelsDb)`: fuzzy-matches a lane model to an economy DB id (same implementer prefix, id ends with the model's last path segment); returns null when there is no match.
- Metering is best-effort: when a lane has a matching economy id and `--mission` is set, it runs `economy.mjs spend` for that dispatch so the fan-out cannot drain a shared pool invisibly; otherwise the lane is recorded unmetered.
- `parseArgv(argv)`, `parseArgs(a)`: argument parsing and validation (errors when `--brief` or `--lanes` is missing or the brief file is absent).
- `main()`: runs the fan-out and writes the combined output.

## engine/economy.test.mjs

The test suite for `economy.mjs`. Run it with `node engine/economy.test.mjs`. It covers eligibility (DEAD tier, chokes, salary cap, pool cap), the role fallback chain, pick ordering, and the spend and choke state transitions.

## engine/models.json

The model intelligence and salary database, version `model-economy.v3`.
- `quotas`: one entry per shared pool, with window, limit, shared_by, source, and note. Pools include `openrouter_free` (one 50/day pool shared by opencode, cline, and aider on the same key), `gemini_direct` (Google AI Studio free tier), `cohere_trial` (about 1000/month), `agy_antigravity` (about 10 per 5 days), `kilo_subscription` (Kilo Code account pool, status UNCONFIGURED until `kilo auth login`), and `openai` and `deepseek` marked dead.
- `tiers`: `T1_deep`, `T2_strong`, `T3_code`, `T4_grind`, mapped to roles deep, analysis, code, grind.
- `models`: each with `id`, `cli`, `tier`, `intelligence` (0 to 100), `role`, `salary_dispatches`, `quota_pool`, `lane`, and `handover_to`.

## engine/free_models.json

A wider roster of free models grouped by pool. Used to pick additional lanes for a fan-out from the pools that are up.

## engine/pool_status.json

A point-in-time snapshot of each pool. Each pool has a `status` (`UP`, `UP_THROTTLED`, `EXHAUSTED`, `DOWN_429`), a note, and a rank, plus a roster of models with their pool status. It is a snapshot, not live state; re-check a provider before trusting it.

## engine/ledger.template.json

The per-mission ledger template. The orchestrator copies it to `ledger.<mission>.json` at mission start. Fields: `mission_id`, `started`, `objective`, `dispatches`, `chokes`, `handovers`, `status`.

## engine/RULES-token-thrift.md

The output contract every delegated implementer follows: caveman-ultra density (no preamble or recap), keep code, commands, paths, ids, and error strings byte-exact, keep authorization and destructive-action warnings in clear prose, and return structured results as compact single-line JSON, with model-to-model handoffs in a `HANDOFF.json` object rather than prose.
