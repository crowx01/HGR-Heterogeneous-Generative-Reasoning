# termonster AI Hub — what we imported into the fleet

Source read: `/usr/bin/termonster` v0.3.3, `~/.config/termonster/` (settings.json, usage.jsonl,
engine.json, agents/), and `termonster mcp` tools/list. This is the part of the AI Hub worth
keeping for the HGR delegation workflow. The rest of the CLI (GUI terminal, themes, installer)
is out of scope.

## 1. What the AI Hub is

A multi-provider agent subsystem inside the terminal. Three moving parts matter to us:

- **Provider chain** (`settings.json -> ai.order`): `claude-cli -> gemini-cli -> codex-cli -> ollama -> anthropic`.
  An ordered failover list. Local (ollama) sits second-to-last, before the paid `anthropic` API.
- **Cost ledger** (`usage.jsonl`, and per-chat `usage`): every call logs
  `{in, out, cacheRead, cacheWrite, cost, turns}` with `model`, `company`, `source`.
- **MCP server** (`termonster mcp`, registered then removed with the uninstall): tools `terminal_context`, `read_output`,
  `run_command` (user-approval-gated, runs in the real terminal), `open_tab`.
- **Agent/mission store** (`agents/chats/*.json`, `agents/missions/`): each session = `Meta{id,agent,
  model,mode,cwd,used,status,usage}` + an `Events[]` stream (`user/init/text/done`). Maps 1:1 to our
  per-mission ledger.

## 2. Imported into the fleet (removed)

termonster has been UNINSTALLED from the box. The MCP registration, the `local` lane, and the
`termonster_local` pool were REMOVED from the fleet config. What remains:

- The generic `cost_model` block in `models.json` (the real-$ salary dimension, see section 4).
- The enforced `cost_salary_usd` wall in `economy.mjs`.
- The routing lessons in this doc (sections 3 and 4).

## 3. Workflow + flowchart

```
request
  |
  v
decompose (Opus)
  |
  v
pick lane  --- economy.mjs pick: free-first, then intelligence, skip choked/over-salary
  |
  v
can afford?  --no--> handover_to[]  --exhausted--> escalate to user
  | yes
  v
dispatch via <implementer>-delegate
  |
  v
spend: ledger.dispatches[model]++   AND   ledger.costs[model] += $cost   <-- imported
  |
  v
choke on 429/empty-output --> follow handover_to[]   (local ollama = last free hop before paid API)
  |
  v
Opus reviews + lands
```

The AI Hub's `ai.order` is the same shape as our `handover_to[]`: an ordered chain that ends at a
paid API, with a free local hop just before it. We already had the chain; the Hub confirms the
ordering principle (local before paid) and the health-check-on-add idea (its "Models and API
services" checks a provider is reachable when you add it — that is our `pool_status.status`).

## 4. Salary implementation — the real import

Our `economy.mjs` gates purely on **dispatch count**:

```
canAfford = !choked && (dispatches[model] < salary_dispatches)
```

It is blind to how expensive a dispatch is. The Hub's `usage.jsonl` tracks the thing we are blind
to: **actual $ cost per call, cache-aware**. The decisive observation:

> one Opus "hi" cost **$0.30**, almost entirely from **30411 cacheWrite tokens** — `cacheWrite`
> dominates cost, not `in`/`out`.

So a single deep-tier dispatch can cost 50x a code-tier one, and a count wall cannot see it.

**Enforced in `economy.mjs`:**

- `spend` accumulates `ledger.costs[model] += --cost` (the dollar cost of the dispatch).
- `isEligible` adds a second wall: stop when `ledger.costs[model] >= model.cost_salary_usd`
  (optional, per model; `models.json -> cost_model` holds the provenance and fields).
- `status` reports `cost_spent` alongside dispatch count.

This gives the fleet a cost cap per model per mission, in dollars, on top of the count cap — which
is what the Hub's ledger does and our engine does not.

### Zero-dollar policy

All fleet pools are free-tier. `openrouter_free`, `gemini_direct`, `cohere_trial` and `agy_antigravity` are free or metered-quota pools, so no model spends out-of-pocket dollars. `openai` and `deepseek` are dead and carry no spend.

A universal `cost_salary_usd: 0.01` tripwire is set on every model in `models.json`. Free runs record $0, so `0 >= 0.01` is false and the model stays eligible. The first real recorded cost pushes `ledger.costs[model]` to the threshold, and the existing `economy.mjs` dollar wall freezes that model.

The orchestrator Claude runs on a flat subscription, so it adds no extra metered spend.
