# WasmNUX benchmark report

```
date     2026-11-19T16:41:29.426Z
runtime  node 22.22.3 on linux/x64, 2 cpus, 3940 MB
git      arena/8368d687-wasmnux-v2@061bd0e (dirty)
wasm     threads, atomics, atomicWait, simd, bulkMemory, memory64, tailCalls, exceptions, sharedGrowable
         crossOriginIsolated=null isWorker=false isNode=true
```

## jit

| case        | variant               | best ms | metric |  value | vs ref | instructions |
| ----------- | --------------------- | ------: | ------ | -----: | -----: | -----------: |
| arith-loop  | interpreter           |   134.8 | MIPS   |   59.4 |  x1.00 |      8000006 |
| arith-loop  | jit globals/trap      |     3.8 | MIPS   | 2123.1 | x35.77 |      8000006 |
| arith-loop  | jit globals/trap +opt |     3.7 | MIPS   | 2160.2 | x36.39 |      8000006 |
| arith-loop  | jit globals/inline    |     4.0 | MIPS   | 2012.2 | x33.90 |      8000006 |
| arith-loop  | jit memory/inline     |     2.5 | MIPS   | 3203.4 | x53.96 |      8000006 |
| arith-loop  | jit tail-chain        |     3.7 | MIPS   | 2133.5 | x35.94 |      8000006 |
| memory-copy | interpreter           |    91.2 | MIPS   |   44.9 |  x1.00 |      4097509 |
| memory-copy | jit globals/trap      |     2.1 | MIPS   | 1937.1 | x43.12 |      4097571 |
| memory-copy | jit globals/trap +opt |     2.4 | MIPS   | 1716.0 | x38.19 |      4097571 |
| memory-copy | jit globals/inline    |     2.1 | MIPS   | 1919.3 | x42.72 |      4097571 |
| memory-copy | jit memory/inline     |     1.4 | MIPS   | 2901.4 | x64.58 |      4097571 |
| memory-copy | jit tail-chain        |     2.0 | MIPS   | 2056.0 | x45.76 |      4097571 |
| divmod      | interpreter           |   129.4 | MIPS   |   61.8 |  x1.00 |      8000010 |
| divmod      | jit globals/trap      |     3.7 | MIPS   | 2177.1 | x35.22 |      8000010 |
| divmod      | jit globals/trap +opt |     3.7 | MIPS   | 2165.2 | x35.03 |      8000010 |
| divmod      | jit globals/inline    |     4.2 | MIPS   | 1906.8 | x30.85 |      8000010 |
| divmod      | jit memory/inline     |     3.2 | MIPS   | 2490.9 | x40.30 |      8000010 |
| divmod      | jit tail-chain        |     3.6 | MIPS   | 2199.3 | x35.58 |      8000010 |
| branchy     | interpreter           |    98.8 | MIPS   |   51.6 |  x1.00 |      5100215 |
| branchy     | jit globals/trap      |     4.3 | MIPS   | 1175.5 | x22.78 |      5100215 |
| branchy     | jit globals/trap +opt |     4.4 | MIPS   | 1155.9 | x22.40 |      5100215 |
| branchy     | jit globals/inline    |     4.4 | MIPS   | 1171.3 | x22.70 |      5100215 |
| branchy     | jit memory/inline     |     4.3 | MIPS   | 1173.6 | x22.74 |      5100215 |
| branchy     | jit tail-chain        |     4.3 | MIPS   | 1180.9 | x22.88 |      5100215 |
| calls       | interpreter           |    57.5 | MIPS   |   41.8 |  x1.00 |      2400786 |
| calls       | jit globals/trap      |    10.1 | MIPS   |  237.2 |  x5.68 |      2400947 |
| calls       | jit globals/trap +opt |    10.4 | MIPS   |  231.2 |  x5.53 |      2400947 |
| calls       | jit globals/inline    |    10.6 | MIPS   |  225.5 |  x5.40 |      2400947 |
| calls       | jit memory/inline     |     8.4 | MIPS   |  284.9 |  x6.82 |      2400947 |
| calls       | jit tail-chain        |    10.5 | MIPS   |  228.0 |  x5.46 |      2400947 |
| atomics     | interpreter           |   117.1 | MIPS   |   42.7 |  x1.00 |      5000008 |
| atomics     | jit globals/trap      |     9.4 | MIPS   |  529.2 | x12.40 |      5000008 |
| atomics     | jit globals/trap +opt |     7.9 | MIPS   |  631.1 | x14.78 |      5000008 |
| atomics     | jit globals/inline    |     7.9 | MIPS   |  634.1 | x14.85 |      5000008 |
| atomics     | jit memory/inline     |     7.8 | MIPS   |  637.3 | x14.93 |      5000008 |
| atomics     | jit tail-chain        |     7.9 | MIPS   |  631.8 | x14.80 |      5000008 |
| matrix      | interpreter           |    27.0 | MIPS   |   55.2 |  x1.00 |      1490047 |
| matrix      | jit globals/trap      |   0.971 | MIPS   | 1534.3 | x27.78 |      1490157 |
| matrix      | jit globals/trap +opt |     1.1 | MIPS   | 1394.4 | x25.25 |      1490157 |
| matrix      | jit globals/inline    |     1.0 | MIPS   | 1489.8 | x26.98 |      1490157 |
| matrix      | jit memory/inline     |   0.603 | MIPS   | 2471.9 | x44.77 |      1490157 |
| matrix      | jit tail-chain        |     1.0 | MIPS   | 1445.7 | x26.18 |      1490157 |
| device-poll | interpreter           |     2.1 | MIPS   |   47.7 |  x1.00 |       100007 |
| device-poll | jit globals/trap      |     4.0 | MIPS   |   24.9 |  x0.52 |       100010 |
| device-poll | jit globals/trap +opt |     4.0 | MIPS   |   24.8 |  x0.52 |       100010 |
| device-poll | jit globals/inline    |     4.1 | MIPS   |   24.2 |  x0.51 |       100016 |
| device-poll | jit memory/inline     |     3.8 | MIPS   |   26.5 |  x0.56 |       100016 |
| device-poll | jit tail-chain        |     4.0 | MIPS   |   24.8 |  x0.52 |       100010 |

<details><summary>JIT compile cost</summary>

| case        | variant               | regions | blocks | wasm bytes | compile ms | instantiate ms |
| ----------- | --------------------- | ------: | -----: | ---------: | ---------: | -------------: |
| arith-loop  | jit globals/trap      |       1 |      2 |        622 |       0.12 |           0.06 |
| arith-loop  | jit globals/trap +opt |       1 |      2 |        622 |       0.09 |           0.31 |
| arith-loop  | jit globals/inline    |       1 |      2 |        633 |       0.10 |           0.32 |
| arith-loop  | jit memory/inline     |       1 |      2 |        356 |       0.07 |           0.04 |
| arith-loop  | jit tail-chain        |       1 |      2 |        638 |       0.10 |           0.34 |
| memory-copy | jit globals/trap      |       1 |      4 |        844 |       0.17 |           0.09 |
| memory-copy | jit globals/trap +opt |       1 |      4 |        844 |       0.24 |           0.09 |
| memory-copy | jit globals/inline    |       1 |      4 |        903 |       0.65 |           0.07 |
| memory-copy | jit memory/inline     |       1 |      4 |        892 |       0.15 |           0.05 |
| memory-copy | jit tail-chain        |       1 |      4 |        860 |       0.12 |           0.08 |
| divmod      | jit globals/trap      |       1 |      2 |        682 |       0.10 |           0.07 |
| divmod      | jit globals/trap +opt |       1 |      2 |        682 |       0.10 |           0.06 |
| divmod      | jit globals/inline    |       1 |      2 |        693 |       0.12 |           0.07 |
| divmod      | jit memory/inline     |       1 |      2 |        486 |       0.11 |           0.04 |
| divmod      | jit tail-chain        |       1 |      2 |        698 |       0.12 |           0.06 |
| branchy     | jit globals/trap      |       1 |      5 |        701 |       0.11 |           0.06 |
| branchy     | jit globals/trap +opt |       1 |      5 |        701 |       0.13 |           0.06 |
| branchy     | jit globals/inline    |       1 |      5 |        712 |       0.14 |           0.07 |
| branchy     | jit memory/inline     |       1 |      5 |        493 |       0.10 |           0.04 |
| branchy     | jit tail-chain        |       1 |      5 |        717 |       0.15 |           0.07 |
| calls       | jit globals/trap      |       4 |     10 |       2870 |       0.23 |           0.16 |
| calls       | jit globals/trap +opt |       4 |     10 |       2870 |       0.42 |           0.24 |
| calls       | jit globals/inline    |       4 |     10 |       3130 |       0.31 |           0.16 |
| calls       | jit memory/inline     |       4 |     10 |       2310 |       0.17 |           0.08 |
| calls       | jit tail-chain        |       4 |     10 |       2934 |       0.29 |           0.16 |
| atomics     | jit globals/trap      |       1 |      2 |        681 |       0.25 |           0.14 |
| atomics     | jit globals/trap +opt |       1 |      2 |        681 |       0.07 |           0.05 |
| atomics     | jit globals/inline    |       1 |      2 |        716 |       0.09 |           0.04 |
| atomics     | jit memory/inline     |       1 |      2 |        471 |       0.05 |           0.03 |
| atomics     | jit tail-chain        |       1 |      2 |        697 |       0.07 |           0.05 |
| matrix      | jit globals/trap      |       1 |      6 |       1078 |       0.09 |           0.08 |
| matrix      | jit globals/trap +opt |       1 |      6 |       1078 |       0.11 |           0.06 |
| matrix      | jit globals/inline    |       1 |      6 |       1161 |       0.09 |           0.06 |
| matrix      | jit memory/inline     |       1 |      6 |       1516 |       0.11 |           0.05 |
| matrix      | jit tail-chain        |       1 |      6 |       1094 |       0.12 |           0.07 |
| device-poll | jit globals/trap      |       2 |      8 |       1424 |       0.15 |           0.09 |
| device-poll | jit globals/trap +opt |       2 |      8 |       1424 |       0.17 |           0.08 |
| device-poll | jit globals/inline    |       2 |      8 |       1482 |       0.15 |           0.08 |
| device-poll | jit memory/inline     |       2 |      8 |       1020 |       0.16 |           0.06 |
| device-poll | jit tail-chain        |       2 |      8 |       1456 |       0.14 |           0.11 |

</details>

## wasm

| case           | variant                     | best ms | metric                           | value | vs ref |                                                                                                                                                                                                                                 instructions |
| -------------- | --------------------------- | ------: | -------------------------------- | ----: | -----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: |
| features       | probe                       |     5.0 | probe ms (lower better)          |  4.96 |  x1.00 |                                                                                                                                                                                                                                            1 |
| features       | probe                       |         |                                  |       |        | threads=true sharedMemoryGrowable=true atomics=true atomicWait=true simd=true bulkMemory=true memory64=true tailCalls=true exceptions=true maxMemory32Pages=65536 maxSharedMemoryPages=1024 hardwareConcurrency=2 isWorker=false isNode=true |
| memory-reserve | 4 GiB max, 1 page committed |   0.007 | reserve ms (lower better)        | 0.007 |  x1.00 |                                                                                                                                                                                                                                        65536 |
| memory-reserve | 4 GiB max, shared           |   0.006 | reserve ms (lower better)        | 0.006 |  x0.93 |                                                                                                                                                                                                                                        65536 |
| memory-reserve | 256 MiB committed           |   0.010 | reserve ms (lower better)        | 0.010 |  x1.48 |                                                                                                                                                                                                                                         4096 |
| memory-reserve | 256 MiB committed, shared   |   0.007 | reserve ms (lower better)        | 0.007 |  x0.99 |                                                                                                                                                                                                                                         4096 |
| memory-reserve | 4 GiB max, 1 page committed |         |                                  |       |        |                                                                                                                                                                                               ok=true initialPages=1 requestedMaxPages=65536 |
| memory-reserve | 4 GiB max, shared           |         |                                  |       |        |                                                                                                                                                                                               ok=true initialPages=1 requestedMaxPages=65536 |
| memory-reserve | 256 MiB committed           |         |                                  |       |        |                                                                                                                                                                                             ok=true initialPages=4096 requestedMaxPages=4096 |
| memory-reserve | 256 MiB committed, shared   |         |                                  |       |        |                                                                                                                                                                                             ok=true initialPages=4096 requestedMaxPages=4096 |
| module-compile | 256 instructions            |   0.003 | compile ms (lower better)        | 0.003 |  x1.00 |                                                                                                                                                                                                                                          256 |
| module-compile | 4096 instructions           |   0.006 | compile ms (lower better)        | 0.006 |  x2.08 |                                                                                                                                                                                                                                         4096 |
| module-compile | 32768 instructions          |   0.045 | compile ms (lower better)        | 0.045 | x16.90 |                                                                                                                                                                                                                                        32768 |
| module-compile | 256 instructions            |         |                                  |       |        |                                                                                                                                                                                                             moduleBytes=936 nsPerInsn=10.996 |
| module-compile | 4096 instructions           |         |                                  |       |        |                                                                                                                                                                                                            moduleBytes=14376 nsPerInsn=2.373 |
| module-compile | 32768 instructions          |         |                                  |       |        |                                                                                                                                                                                                            moduleBytes=114730 nsPerInsn=2.67 |
| atomics-micro  | micro x1000000              |    25.2 | wasm atomic ns/op (lower better) |  9.68 |  x1.00 |                                                                                                                                                                                                                                      1000000 |
| atomics-micro  | micro x1000000              |         |                                  |       |        |                                                                                                                                                    jsAtomicsAddNs=10.086 jsCmpxchgNs=10.723 wasmAtomicAddNs=9.677 wasmPlainStoreLoadNs=0.293 |

## baseline

| case       | variant                   | best ms | metric |  value | vs ref |                               instructions |
| ---------- | ------------------------- | ------: | ------ | -----: | -----: | -----------------------------------------: |
| arith-loop | interpreter (ours)        |   117.8 | MIPS   |   67.9 |  x1.00 |                                    8000006 |
| arith-loop | jit globals/trap (ours)   |     3.6 | MIPS   | 2216.5 | x32.63 |                                    8000006 |
| arith-loop | 8086emu 1.5.1 (rust/wasm) |    48.4 | MIPS   |  165.3 |  x2.43 |                                    8000006 |
| arith-loop | interpreter (ours)        |         |        |        |        | result=-1188726464 imageBytes=40 stop=exit |
| arith-loop | jit globals/trap (ours)   |         |        |        |        | result=-1188726464 imageBytes=40 stop=exit |
| arith-loop | 8086emu 1.5.1 (rust/wasm) |         |        |        |        |   imageBytes=40 halted=true stoppedAtPc=40 |
| divmod     | interpreter (ours)        |   145.6 | MIPS   |   54.9 |  x1.00 |                                    8000010 |
| divmod     | jit globals/trap (ours)   |     3.8 | MIPS   | 2108.4 | x38.37 |                                    8000010 |
| divmod     | 8086emu 1.5.1 (rust/wasm) |    56.2 | MIPS   |  142.3 |  x2.59 |                                    8000010 |
| divmod     | interpreter (ours)        |         |        |        |        |  result=-960849228 imageBytes=72 stop=exit |
| divmod     | jit globals/trap (ours)   |         |        |        |        |  result=-960849228 imageBytes=72 stop=exit |
| divmod     | 8086emu 1.5.1 (rust/wasm) |         |        |        |        |   imageBytes=72 halted=true stoppedAtPc=72 |
| branchy    | interpreter (ours)        |    82.2 | MIPS   |   62.0 |  x1.00 |                                    5100215 |
| branchy    | jit globals/trap (ours)   |     4.9 | MIPS   | 1038.0 | x16.73 |                                    5100215 |
| branchy    | 8086emu 1.5.1 (rust/wasm) |    33.6 | MIPS   |  151.7 |  x2.44 |                                    5100215 |
| branchy    | interpreter (ours)        |         |        |        |        |      result=600000 imageBytes=80 stop=exit |
| branchy    | jit globals/trap (ours)   |         |        |        |        |      result=600000 imageBytes=80 stop=exit |
| branchy    | 8086emu 1.5.1 (rust/wasm) |         |        |        |        |  imageBytes=80 halted=false stoppedAtPc=44 |

<details><summary>JIT compile cost</summary>

| case       | variant                 | regions | blocks | wasm bytes | compile ms | instantiate ms |
| ---------- | ----------------------- | ------: | -----: | ---------: | ---------: | -------------: |
| arith-loop | jit globals/trap (ours) |       1 |      2 |        622 |       0.09 |           0.34 |
| divmod     | jit globals/trap (ours) |       1 |      2 |        682 |       0.12 |           4.54 |
| branchy    | jit globals/trap (ours) |       1 |      5 |        701 |       0.22 |           0.94 |

</details>

Measured in 17.2 s.
