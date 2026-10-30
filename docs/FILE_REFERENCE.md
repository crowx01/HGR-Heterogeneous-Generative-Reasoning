# File Reference

## engine/route.mjs
Pre-dispatch refresh and best-UP-model-per-role selection. Lane resolution and substitution. Honors CONFIG_DIR. Flags: --role, --lane, --json, --no-refresh.

## engine/mission.mjs
Sequential salary and handover mission driver. Flags: --brief, --role, --mission, --cd, --out-dir, --max-steps, --timeout, --self-test.

## engine/guard.mjs
Snapshot critical files before dispatch and restore if mutated. snapshotCritical(dir) -> {restore()}.

## engine/infer.mjs
Shared inferPool(implementer, model) and inferRole(lane) used by route.mjs and consensus.mjs.