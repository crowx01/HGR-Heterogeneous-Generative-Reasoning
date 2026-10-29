# Economy walls and relay auto-recording

- crush removed from the fleet (binary, delegate skill, and all engine config); aider gained NVIDIA NIM and SambaNova free-model lanes (aider-nim, aider-nim-code, aider-sn, aider-sn-code) sourced from provider keys in the aider env file.
- The termonster AI Hub was evaluated and removed. Its cost model and routing intelligence were absorbed into the economy (see `docs/termonster-ai-hub.md`).
- `economy.mjs` now enforces three walls: dispatch count (`salary_dispatches`), token budget (`token_salary`), and dollars (`cost_salary_usd`). All three are optional per model.
- Zero-dollar policy: every model carries `cost_salary_usd: 0.01`, all pools are free tier, and any real recorded cost freezes that model.
- The relays (opencode, agy, aider, cline, kilo) take a `--mission` flag and record each completed dispatch into the mission ledger via `economy.mjs spend`. opencode also reports tokens and cost; the other four are dispatch-only. Recording requires an explicit `--model`.

Layout: `relays/<cli>/relay.mjs` are the per-CLI relays; `relays/opencode/tokens.mjs` and its test parse opencode token and cost output.
