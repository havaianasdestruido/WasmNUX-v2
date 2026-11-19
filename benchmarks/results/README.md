# Reference measurements

This directory contains selected raw benchmark reports. The report's `commit` is the clean source commit tested; the report is added in a later commit to avoid a self-referential SHA. `dirty: false` indicates no source changes at benchmark start. CI also publishes per-commit benchmark artifacts with 90-day retention. See the [Phase 0 evidence review](../../docs/phase-0.md) for interpretation and gaps.

Schema 1 browser reports included post-work litmus and result handling in SMP `elapsedMs`; do not use that field to compare worker counts. Schema 2 reports stop SMP timing at the last worker’s workload completion.
