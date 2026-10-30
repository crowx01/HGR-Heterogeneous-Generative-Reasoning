# End-to-End Dispatch Flow

1. **Brief Authoring**: Author a brief as a JSON file with `output_format` and `output_schema`.
2. **Pre-Dispatch**: `route.mjs` refreshes `pool_status`. If `pool_status` is more than 6 hours stale, a full re-tier is performed; otherwise, a cheap `--status` scan is done. Failures fall back to stale status without crashing.
3. **Model Selection**: Select the best UP model per role. Lanes with EXHAUSTED/DOWN pools auto-substitute to the best UP model of the same role. Pools with elapsed reset timestamps are considered recovered.
4. **Dispatch**: Dispatch models via their `<cli>-delegate` relay. `mission.mjs` adds a budget, completion protocol, and tooling preamble. `consensus.mjs` prepends the tooling directive to each lane's wrapped brief.
5. **Salary and Handover**: Each model receives a salary (dispatch budget). On failure (quota/429, budget exhaustion, economy ineligibility, or INCOMPLETE/HANDOFF.md emission), the work hands over to the next-in-lane model. `HANDOFF.md` accumulates per step, with a visited-set preventing re-dispatch loops. The chain terminates as stuck or at max-steps.
6. **Economy Ledger**: Records dispatches, costs, tokens, chokes, and handovers in a per-mission file with a lock to prevent parallel lane update conflicts.
7. **Critical-File Guard**: `guard.mjs` restores `models.json` and `config.json` if any dispatch mutates them.
8. **Review**: Opus or a reviewer inspects the returned JSON and lands the result.