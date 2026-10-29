Added live-tier.mjs, a live tiering engine. Each run it
enumerates every free model across the keyed providers and the CLI catalogs, sends a test prompt to
each, drops paid imposters and models that do not serve, scores intelligence with a rubric plus a
parameter-size heuristic, tiers them T1 to T4, derives each salary from its quota pool, and builds
cross-pool fallback chains, then writes free_models.json and models.json. A cron job runs it every 4
hours so the economy stays live. The economy now holds live-verified free models only.

# Economy walls and relay auto-recording

- Live-enumerated every free model across all keyed providers and CLIs and tiered them into the economy. free_models.json now holds 185 free models across 8 pools: NVIDIA NIM 62, Cloudflare Workers AI 37, Gemini 32, OpenRouter 16, Cohere 13, Kilo gateway 13, SambaNova 6, agy 6. models.json grew to 182 tiered entries (T1 deep 8, T2 strong 15, T3 code 40, T4 grind 119) with cross-pool fallback chains. Together (key expired), DeepInfra (pay per token), Hugging Face, Moonshot, DeepSeek, and cline (no list command) are excluded.

- crush removed from the fleet (binary, delegate skill, and all engine config); aider gained NVIDIA NIM and SambaNova free-model lanes (aider-nim, aider-nim-code, aider-sn, aider-sn-code) sourced from provider keys in the aider env file.
- The termonster AI Hub was evaluated and removed. Its cost model and routing intelligence were absorbed into the economy (see `docs/termonster-ai-hub.md`).
- `economy.mjs` now enforces three walls: dispatch count (`salary_dispatches`), token budget (`token_salary`), and dollars (`cost_salary_usd`). All three are optional per model.
- Zero-dollar policy: every model carries `cost_salary_usd: 0.01`, all pools are free tier, and any real recorded cost freezes that model.
- The relays (opencode, agy, aider, cline, kilo) take a `--mission` flag and record each completed dispatch into the mission ledger via `economy.mjs spend`. opencode also reports tokens and cost; the other four are dispatch-only. Recording requires an explicit `--model`.

Layout: `relays/<cli>/relay.mjs` are the per-CLI relays; `relays/opencode/tokens.mjs` and its test parse opencode token and cost output.