# Delegation Economy

The delegation economy is a system for managing and dispatching models to perform tasks. It uses a roster of models defined in `models.json`, each with specific attributes such as `id`, `cli`, `tier`, `intelligence`, `role`, `salary_dispatches`, `quota_pool`, `lane`, `handover_to`, and `cost_salary_usd`.

## Pools

The system operates with five pools, representing different categories of models. The `pool_status.json` file provides live availability of these pools, but it is generated locally and not committed to the repository.

## Tools

- **route.mjs**: Pre-dispatch refresh and best-UP-model-per-role selection, with lane resolution/substitution. Honors `CONFIG_DIR`.
- **live-tier.mjs**: Full re-tiering and cheap pool scan with the `--status` flag.
- **consensus.mjs**: Parallel 1-brief to N-lane fan-out, auto-substitutes dead pools, and marks post-dispatch pool/lane status.
- **mission.mjs**: Sequential salary and handover driver.
- **economy.mjs**: Ledger accounting for dispatches, costs, tokens, chokes, and handovers, with file locking to prevent parallel lane update conflicts.
- **guard.mjs**: Snapshots and restores `models.json` and `config.json` around dispatches to prevent mutations.
- **infer.mjs**: Shared `inferPool` and `inferRole` functionality.

## Quickstart

To run a consensus fan-out:

```bash
node consensus.mjs --brief brief.json --lanes deep-free,cohere,kilo
```

To run a mission:

```bash
node mission.mjs --brief brief.json --role deep --mission my-mission
```

Briefs are authored as JSON files with explicit `output_format` and `output_schema`. Dispatched models are instructed to run real tools, not simulations.