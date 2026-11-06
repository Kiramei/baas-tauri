# Documentation benchmark evidence

Historical Windows and Linux measurement records live here alongside the
documentation's Android benchmark fixtures. These files are documentation
evidence and are not imported by the desktop, Android or WebUI application.

The JSON records moved from the repository's former root `benchmarks/`
directory retain their original file names and measurement data. Personal
machine paths in historical records are redacted; source hashes in aggregate
records refer to the sanitized files. Other source paths and commands describe
the checkout used at measurement time, not the current directory layout.
For example, `benchmarks/native-transport-linux-2026-10-20.json` recorded inside
the combined result now lives at
`docs/benchmarks/native-transport-linux-2026-10-20.json`.

Published website downloads remain in `docs/public/benchmarks/`, whose public
URLs remain `/benchmarks/...`. The documentation's measurement and publication
scripts remain in `docs/scripts/`. Development probes and transport tests keep
their existing source locations so their original commands still work.

See [the documentation guide](../README.md) for current measurements and
[the Linux validation notes](../shared-memory-linux-validation-2026-10-19.md)
for the archived transport comparison and its scope.
