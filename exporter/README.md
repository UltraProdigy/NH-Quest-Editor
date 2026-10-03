# Exporter

A Forge 1.7.10 mod that runs inside a real GTNH client and exports recipes, item data and rendered icons for the
quest editor site.

It is based on `gtnh-calc-oracle` from [gtnh-factory-flow](https://github.com/jackwrichards/gtnh-factory-flow)
(commit `cc6ac0448b596cc63e0b06f634c068cc2b38d8ee`, `tools/dataset-pipeline/gtnh-calc-oracle`), used under the MIT
license in `LICENSE`. `scripts/install-ae2fc-nei-compat-shim.sh` comes from the same repository.

## Changes from upstream

- `gtnh.oracle.waitForWorld`: when `true`, the autorun waits until the client is in a world with a player before
  counting `gtnh.oracle.autorunDelayTicks`.
- `gtnh.oracle.iconRenderer`: `oracle` (default) keeps the original render path; `nei` draws icons through
  `GuiContainerManager.drawItem`.

## Building

```
./gradlew build
```

The mod jar is written to `build/libs/`. The export workflow in `.github/workflows/export-poc.yml` builds and runs it.
