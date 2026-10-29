# Installation

## Prerequisites
Install Node 18 or newer, git, and a shell. The implementer CLIs are optional and installed per lane you plan to use.

## Get the code
Clone the repository and navigate into it:

```
git clone https://github.com/crowx01/HGR-Heterogeneous-Generative-Reasoning
cd HGR-Heterogeneous-Generative-Reasoning
```

## Point the engine at a config directory
The engine reads `CONFIG_DIR` (default `/home/kali/.config/delegate-skills`). You have two options:

- Set `CONFIG_DIR` to the repo's `engine/` directory, or
- Copy the engine data files (`config.json`, `models.json`, `free_models.json`, `pool_status.json`, `ledger.template.json`) into `/home/kali/.config/delegate-skills`.

Note: `economy.mjs` honors `CONFIG_DIR`, `MODELS_FILE`, `TEMPLATE_FILE`, but `consensus.mjs` currently hardcodes `/home/kali/.config/delegate-skills` and the `~/.claude/skills` relay path. This is mentioned in the README Limitations.

## Install the relay skills
Each `*-delegate` skill provides a `scripts/relay.mjs` that `consensus.mjs` spawns, resolved at `~/.claude/skills/<implementer>-delegate/scripts/relay.mjs`. Install the delegate skills there. These skills come from `amElnagdy/delegate-skills`.

## Install the implementer CLIs
Install only the CLIs you plan to route to. Here are the commands for each CLI:

### opencode
```
npm i -g opencode-ai
opencode auth login
```

### aider
```
python -m pip install aider-chat
```
Provider key is set in the environment.

### cline
Install the Cline CLI, then:
```
cline auth
```

### agy (Google Antigravity CLI)
Follow the Antigravity CLI docs and complete first-launch auth, then verify with:
```
agy help
```

### crush (Charmbracelet Crush)
Install per the Crush project docs, then verify with:
```
crush models
```

### kilo (Kilo Code CLI)
Install with `npm i -g @kilocode/cli`, then authenticate with `kilo auth login`. Kilo is a fork of opencode. It authenticates through its own login and does not use environment API keys (only aider uses environment keys). Use its free models (for example `kilo/kilo-auto/free`); the `kilo/~...-latest` hosted aliases need paid Kilo Gateway credits.

## Verify the install
Run the test suite:

```
node engine/economy.test.mjs
```

All tests should pass. Then, run a no-spend pick:

```
node engine/economy.mjs pick --role deep --mission demo
```

This should return a JSON line naming a model. You can also run:

```
node engine/economy.mjs status --mission demo
```

to see the ledger.

## Troubleshooting
- A bare `opencode run` errors without a model. Pass `--model` or a lane.
- A `429` or spent pool triggers a choke and handover, which is expected.
- Snapshot files (`pool_status.json`, `free_models.json`) record a past moment, not live state.

For more details, refer to [docs/FILE_REFERENCE.md](docs/FILE_REFERENCE.md).