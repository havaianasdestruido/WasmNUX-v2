# WasmNUX benchmark report

```
date     2026-11-19T16:59:29.893Z
runtime  node 22.22.3 on linux/x64, 2 cpus, 3940 MB
git      arena/8368d687-wasmnux-v2@fdb7d92 (dirty)
wasm     threads, atomics, atomicWait, simd, bulkMemory, memory64, tailCalls, exceptions, sharedGrowable
         crossOriginIsolated=null isWorker=false isNode=true
```

## jit

| case        | variant               | best ms | metric |  value | vs ref | instructions |
| ----------- | --------------------- | ------: | ------ | -----: | -----: | -----------: |
| arith-loop  | interpreter           |   156.5 | MIPS   |   51.1 |  x1.00 |      8000006 |
| arith-loop  | jit globals/trap      |     3.7 | MIPS   | 2137.4 | x41.81 |      8000006 |
| arith-loop  | jit globals/trap +opt |     3.6 | MIPS   | 2198.3 | x43.01 |      8000006 |
| arith-loop  | jit globals/inline    |     3.7 | MIPS   | 2174.8 | x42.55 |      8000006 |
| arith-loop  | jit memory/inline     |     2.3 | MIPS   | 3543.0 | x69.31 |      8000006 |
| arith-loop  | jit tail-chain        |     3.5 | MIPS   | 2273.8 | x44.48 |      8000006 |
| memory-copy | interpreter           |    74.1 | MIPS   |   55.3 |  x1.00 |      4097509 |
| memory-copy | jit globals/trap      |     2.1 | MIPS   | 1980.4 | x35.83 |      4097571 |
| memory-copy | jit globals/trap +opt |     2.0 | MIPS   | 2019.2 | x36.54 |      4097571 |
| memory-copy | jit globals/inline    |     2.1 | MIPS   | 1934.1 | x35.00 |      4097571 |
| memory-copy | jit memory/inline     |     1.4 | MIPS   | 2843.7 | x51.46 |      4097571 |
| memory-copy | jit tail-chain        |     2.4 | MIPS   | 1677.3 | x30.35 |      4097571 |
| divmod      | interpreter           |   127.4 | MIPS   |   62.8 |  x1.00 |      8000010 |
| divmod      | jit globals/trap      |     4.3 | MIPS   | 1840.0 | x29.29 |      8000010 |
| divmod      | jit globals/trap +opt |     4.4 | MIPS   | 1813.2 | x28.87 |      8000010 |
| divmod      | jit globals/inline    |     4.3 | MIPS   | 1863.8 | x29.67 |      8000010 |
| divmod      | jit memory/inline     |     3.4 | MIPS   | 2320.0 | x36.94 |      8000010 |
| divmod      | jit tail-chain        |     4.2 | MIPS   | 1927.6 | x30.69 |      8000010 |
| branchy     | interpreter           |   110.9 | MIPS   |   46.0 |  x1.00 |      5100215 |
| branchy     | jit globals/trap      |     4.6 | MIPS   | 1099.8 | x23.90 |      5100215 |
| branchy     | jit globals/trap +opt |     4.4 | MIPS   | 1155.7 | x25.12 |      5100215 |
| branchy     | jit globals/inline    |     5.1 | MIPS   | 1004.0 | x21.82 |      5100215 |
| branchy     | jit memory/inline     |     4.3 | MIPS   | 1197.9 | x26.04 |      5100215 |
| branchy     | jit tail-chain        |     5.0 | MIPS   | 1011.3 | x21.98 |      5100215 |
| calls       | interpreter           |    57.9 | MIPS   |   41.4 |  x1.00 |      2400786 |
| calls       | jit globals/trap      |    10.4 | MIPS   |  230.2 |  x5.56 |      2400947 |
| calls       | jit globals/trap +opt |    10.3 | MIPS   |  232.0 |  x5.60 |      2400947 |
| calls       | jit globals/inline    |    11.2 | MIPS   |  214.4 |  x5.18 |      2400947 |
| calls       | jit memory/inline     |     9.1 | MIPS   |  262.7 |  x6.34 |      2400947 |
| calls       | jit tail-chain        |    10.7 | MIPS   |  224.8 |  x5.43 |      2400947 |
| atomics     | interpreter           |    99.2 | MIPS   |   50.4 |  x1.00 |      5000008 |
| atomics     | jit globals/trap      |     8.3 | MIPS   |  603.1 | x11.97 |      5000008 |
| atomics     | jit globals/trap +opt |     8.3 | MIPS   |  603.1 | x11.97 |      5000008 |
| atomics     | jit globals/inline    |     8.3 | MIPS   |  603.4 | x11.97 |      5000008 |
| atomics     | jit memory/inline     |     8.0 | MIPS   |  628.0 | x12.46 |      5000008 |
| atomics     | jit tail-chain        |     8.0 | MIPS   |  627.6 | x12.45 |      5000008 |
| matrix      | interpreter           |    27.7 | MIPS   |   53.8 |  x1.00 |      1490047 |
| matrix      | jit globals/trap      |   0.949 | MIPS   | 1570.5 | x29.17 |      1490157 |
| matrix      | jit globals/trap +opt |   0.961 | MIPS   | 1550.3 | x28.79 |      1490157 |
| matrix      | jit globals/inline    |     1.1 | MIPS   | 1315.2 | x24.43 |      1490157 |
| matrix      | jit memory/inline     |   0.590 | MIPS   | 2525.7 | x46.91 |      1490157 |
| matrix      | jit tail-chain        |   0.998 | MIPS   | 1493.3 | x27.73 |      1490157 |
| device-poll | interpreter           |     2.4 | MIPS   |   42.5 |  x1.00 |       100007 |
| device-poll | jit globals/trap      |     4.1 | MIPS   |   24.5 |  x0.58 |       100010 |
| device-poll | jit globals/trap +opt |     4.1 | MIPS   |   24.5 |  x0.58 |       100010 |
| device-poll | jit globals/inline    |     4.4 | MIPS   |   22.5 |  x0.53 |       100016 |
| device-poll | jit memory/inline     |     4.1 | MIPS   |   24.3 |  x0.57 |       100016 |
| device-poll | jit tail-chain        |     4.7 | MIPS   |   21.2 |  x0.50 |       100010 |

<details><summary>JIT compile cost</summary>

| case        | variant               | regions | blocks | wasm bytes | compile ms | instantiate ms |
| ----------- | --------------------- | ------: | -----: | ---------: | ---------: | -------------: |
| arith-loop  | jit globals/trap      |       1 |      2 |        622 |       0.09 |           0.50 |
| arith-loop  | jit globals/trap +opt |       1 |      2 |        622 |       0.12 |           0.07 |
| arith-loop  | jit globals/inline    |       1 |      2 |        633 |       0.17 |           0.10 |
| arith-loop  | jit memory/inline     |       1 |      2 |        356 |       0.11 |           0.05 |
| arith-loop  | jit tail-chain        |       1 |      2 |        638 |       0.08 |           0.05 |
| memory-copy | jit globals/trap      |       1 |      4 |        844 |       0.12 |           0.07 |
| memory-copy | jit globals/trap +opt |       1 |      4 |        844 |       0.20 |           0.06 |
| memory-copy | jit globals/inline    |       1 |      4 |        903 |       0.23 |           0.10 |
| memory-copy | jit memory/inline     |       1 |      4 |        892 |       0.13 |           0.04 |
| memory-copy | jit tail-chain        |       1 |      4 |        860 |       0.13 |           0.07 |
| divmod      | jit globals/trap      |       1 |      2 |        682 |       0.13 |           0.09 |
| divmod      | jit globals/trap +opt |       1 |      2 |        682 |       0.13 |           0.07 |
| divmod      | jit globals/inline    |       1 |      2 |        693 |       0.60 |           0.08 |
| divmod      | jit memory/inline     |       1 |      2 |        486 |       0.06 |           0.04 |
| divmod      | jit tail-chain        |       1 |      2 |        698 |       0.17 |           0.09 |
| branchy     | jit globals/trap      |       1 |      5 |        701 |       0.10 |           0.07 |
| branchy     | jit globals/trap +opt |       1 |      5 |        701 |       0.11 |           0.06 |
| branchy     | jit globals/inline    |       1 |      5 |        712 |       0.31 |           0.10 |
| branchy     | jit memory/inline     |       1 |      5 |        493 |       0.09 |           0.08 |
| branchy     | jit tail-chain        |       1 |      5 |        717 |       0.17 |           0.07 |
| calls       | jit globals/trap      |       4 |     10 |       2870 |       0.21 |           0.13 |
| calls       | jit globals/trap +opt |       4 |     10 |       2870 |       0.38 |           0.20 |
| calls       | jit globals/inline    |       4 |     10 |       3130 |       0.25 |           0.18 |
| calls       | jit memory/inline     |       4 |     10 |       2310 |       0.19 |           0.10 |
| calls       | jit tail-chain        |       4 |     10 |       2934 |       0.21 |           0.14 |
| atomics     | jit globals/trap      |       1 |      2 |        681 |       0.08 |           0.10 |
| atomics     | jit globals/trap +opt |       1 |      2 |        681 |       0.07 |           0.05 |
| atomics     | jit globals/inline    |       1 |      2 |        716 |       0.08 |           0.05 |
| atomics     | jit memory/inline     |       1 |      2 |        471 |       0.14 |           0.07 |
| atomics     | jit tail-chain        |       1 |      2 |        697 |       0.08 |           0.05 |
| matrix      | jit globals/trap      |       1 |      6 |       1078 |       0.11 |           0.07 |
| matrix      | jit globals/trap +opt |       1 |      6 |       1078 |       0.13 |           0.07 |
| matrix      | jit globals/inline    |       1 |      6 |       1161 |       1.63 |           0.10 |
| matrix      | jit memory/inline     |       1 |      6 |       1516 |       1.95 |           0.05 |
| matrix      | jit tail-chain        |       1 |      6 |       1094 |       0.10 |           0.11 |
| device-poll | jit globals/trap      |       2 |      8 |       1424 |       0.17 |           0.10 |
| device-poll | jit globals/trap +opt |       2 |      8 |       1424 |       0.16 |           0.09 |
| device-poll | jit globals/inline    |       2 |      8 |       1482 |       0.17 |           0.09 |
| device-poll | jit memory/inline     |       2 |      8 |       1020 |       0.09 |           0.05 |
| device-poll | jit tail-chain        |       2 |      8 |       1456 |       0.19 |           0.11 |

</details>

## wasm

| case           | variant                     | best ms | metric                           | value | vs ref |                                                                                                                                                                                                                                  instructions |
| -------------- | --------------------------- | ------: | -------------------------------- | ----: | -----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: |
| features       | probe                       |   0.126 | probe ms (lower better)          |  0.13 |  x1.00 |                                                                                                                                                                                                                                             1 |
| features       | probe                       |         |                                  |       |        | threads=true sharedMemoryGrowable=true atomics=true atomicWait=true simd=true bulkMemory=true memory64=true tailCalls=true exceptions=true maxMemory32Pages=65536 maxSharedMemoryPages=65536 hardwareConcurrency=2 isWorker=false isNode=true |
| memory-reserve | 4 GiB max, 1 page committed |   0.006 | reserve ms (lower better)        | 0.006 |  x1.00 |                                                                                                                                                                                                                                         65536 |
| memory-reserve | 4 GiB max, shared           |   0.006 | reserve ms (lower better)        | 0.006 |  x0.99 |                                                                                                                                                                                                                                         65536 |
| memory-reserve | 256 MiB committed           |   0.009 | reserve ms (lower better)        | 0.009 |  x1.54 |                                                                                                                                                                                                                                          4096 |
| memory-reserve | 256 MiB committed, shared   |   0.008 | reserve ms (lower better)        | 0.008 |  x1.39 |                                                                                                                                                                                                                                          4096 |
| memory-reserve | 4 GiB max, 1 page committed |         |                                  |       |        |                                                                                                                                                                                                ok=true initialPages=1 requestedMaxPages=65536 |
| memory-reserve | 4 GiB max, shared           |         |                                  |       |        |                                                                                                                                                                                                ok=true initialPages=1 requestedMaxPages=65536 |
| memory-reserve | 256 MiB committed           |         |                                  |       |        |                                                                                                                                                                                              ok=true initialPages=4096 requestedMaxPages=4096 |
| memory-reserve | 256 MiB committed, shared   |         |                                  |       |        |                                                                                                                                                                                              ok=true initialPages=4096 requestedMaxPages=4096 |
| module-compile | 256 instructions            |   0.003 | compile ms (lower better)        | 0.003 |  x1.00 |                                                                                                                                                                                                                                           256 |
| module-compile | 4096 instructions           |   0.007 | compile ms (lower better)        | 0.007 |  x2.05 |                                                                                                                                                                                                                                          4096 |
| module-compile | 32768 instructions          |   0.062 | compile ms (lower better)        | 0.062 | x18.86 |                                                                                                                                                                                                                                         32768 |
| module-compile | 256 instructions            |         |                                  |       |        |                                                                                                                                                                                                              moduleBytes=936 nsPerInsn=12.738 |
| module-compile | 4096 instructions           |         |                                  |       |        |                                                                                                                                                                                                             moduleBytes=14376 nsPerInsn=6.724 |
| module-compile | 32768 instructions          |         |                                  |       |        |                                                                                                                                                                                                            moduleBytes=114730 nsPerInsn=3.223 |
| atomics-micro  | micro x1000000              |    32.9 | wasm atomic ns/op (lower better) |  9.42 |  x1.00 |                                                                                                                                                                                                                                       1000000 |
| atomics-micro  | micro x1000000              |         |                                  |       |        |                                                                                                                                                      jsAtomicsAddNs=13.12 jsCmpxchgNs=11.363 wasmAtomicAddNs=9.416 wasmPlainStoreLoadNs=0.299 |

## baseline

| case       | variant                   | best ms | metric |  value | vs ref |                               instructions |
| ---------- | ------------------------- | ------: | ------ | -----: | -----: | -----------------------------------------: |
| arith-loop | interpreter (ours)        |   137.0 | MIPS   |   58.4 |  x1.00 |                                    8000006 |
| arith-loop | jit globals/trap (ours)   |     3.7 | MIPS   | 2165.8 | x37.09 |                                    8000006 |
| arith-loop | 8086emu 1.5.1 (rust/wasm) |    47.4 | MIPS   |  168.8 |  x2.89 |                                    8000006 |
| arith-loop | interpreter (ours)        |         |        |        |        | result=-1188726464 imageBytes=40 stop=exit |
| arith-loop | jit globals/trap (ours)   |         |        |        |        | result=-1188726464 imageBytes=40 stop=exit |
| arith-loop | 8086emu 1.5.1 (rust/wasm) |         |        |        |        |   imageBytes=40 halted=true stoppedAtPc=40 |
| divmod     | interpreter (ours)        |   119.9 | MIPS   |   66.7 |  x1.00 |                                    8000010 |
| divmod     | jit globals/trap (ours)   |     4.4 | MIPS   | 1819.3 | x27.28 |                                    8000010 |
| divmod     | 8086emu 1.5.1 (rust/wasm) |    58.0 | MIPS   |  137.9 |  x2.07 |                                    8000010 |
| divmod     | interpreter (ours)        |         |        |        |        |  result=-960849228 imageBytes=72 stop=exit |
| divmod     | jit globals/trap (ours)   |         |        |        |        |  result=-960849228 imageBytes=72 stop=exit |
| divmod     | 8086emu 1.5.1 (rust/wasm) |         |        |        |        |   imageBytes=72 halted=true stoppedAtPc=72 |
| branchy    | interpreter (ours)        |   100.7 | MIPS   |   50.6 |  x1.00 |                                    5100215 |
| branchy    | jit globals/trap (ours)   |     4.5 | MIPS   | 1127.4 | x22.26 |                                    5100215 |
| branchy    | 8086emu 1.5.1 (rust/wasm) |    38.3 | MIPS   |  133.1 |  x2.63 |                                    5100215 |
| branchy    | interpreter (ours)        |         |        |        |        |      result=600000 imageBytes=80 stop=exit |
| branchy    | jit globals/trap (ours)   |         |        |        |        |      result=600000 imageBytes=80 stop=exit |
| branchy    | 8086emu 1.5.1 (rust/wasm) |         |        |        |        |  imageBytes=80 halted=false stoppedAtPc=44 |

<details><summary>JIT compile cost</summary>

| case       | variant                 | regions | blocks | wasm bytes | compile ms | instantiate ms |
| ---------- | ----------------------- | ------: | -----: | ---------: | ---------: | -------------: |
| arith-loop | jit globals/trap (ours) |       1 |      2 |        622 |       0.08 |           2.39 |
| divmod     | jit globals/trap (ours) |       1 |      2 |        682 |       0.13 |           0.07 |
| branchy    | jit globals/trap (ours) |       1 |      5 |        701 |       0.14 |           0.07 |

</details>

Measured in 17.5 s.
