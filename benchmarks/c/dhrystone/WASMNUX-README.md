# Dhrystone 2.1 (vendored)

Unmodified copy of the extracted **Dhrystone Version 2.1 (C)** sources, copied
from `Keith-S-Thompson/dhrystone` (`v2.1/`), itself extracted from Reinhold P.
Weicker's original 1988 postings — see that repository's README.md.

Dhrystone was released by Weicker for free benchmarking use; it is the de-facto
public-domain standard. No warranty is granted or implied.

Build recipe used by `benchmarks/harness/run.mjs`:

    gcc -O2 -std=gnu89 -w -fcommon -DTIME dhry_1.c dhry_2.c -o dhrystone -lm

`-DTIME` selects the `time()` clock (1 s resolution). Runs are sized so the
measured time exceeds 2 seconds; the harness parses "Dhrystones per Second".
