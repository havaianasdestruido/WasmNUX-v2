# WasmNUX benchmark report

```
date     2026-11-19T17:29:33.676Z
runtime  node 22.22.3 on linux/x64, 2 cpus, 3940 MB
git      arena/8368d687-wasmnux-v2@5a271c0
wasm     threads, atomics, atomicWait, simd, bulkMemory, memory64, tailCalls, exceptions, sharedGrowable
         crossOriginIsolated=null isWorker=false isNode=true
```

## jit

| case        | variant               | best ms | metric |  value | vs ref | instructions |
| ----------- | --------------------- | ------: | ------ | -----: | -----: | -----------: |
| arith-loop  | interpreter           |   157.8 | MIPS   |   50.7 |  x1.00 |      8000006 |
| arith-loop  | jit globals/trap      |     4.2 | MIPS   | 1910.1 | x37.69 |      8000006 |
| arith-loop  | jit globals/trap +opt |     3.8 | MIPS   | 2095.0 | x41.33 |      8000006 |
| arith-loop  | jit globals/inline    |     4.0 | MIPS   | 2024.6 | x39.94 |      8000006 |
| arith-loop  | jit memory/inline     |     2.5 | MIPS   | 3193.0 | x63.00 |      8000006 |
| arith-loop  | jit tail-chain        |     3.8 | MIPS   | 2092.9 | x41.29 |      8000006 |
| memory-copy | interpreter           |    91.3 | MIPS   |   44.9 |  x1.00 |      4097509 |
| memory-copy | jit globals/trap      |     2.1 | MIPS   | 1980.1 | x44.14 |      4097571 |
| memory-copy | jit globals/trap +opt |     2.1 | MIPS   | 1966.2 | x43.83 |      4097571 |
| memory-copy | jit globals/inline    |     2.5 | MIPS   | 1657.6 | x36.95 |      4097571 |
| memory-copy | jit memory/inline     |     1.4 | MIPS   | 2886.5 | x64.34 |      4097571 |
| memory-copy | jit tail-chain        |     2.0 | MIPS   | 2051.9 | x45.74 |      4097571 |
| divmod      | interpreter           |   153.0 | MIPS   |   52.3 |  x1.00 |      8000010 |
| divmod      | jit globals/trap      |     4.1 | MIPS   | 1946.9 | x37.24 |      8000010 |
| divmod      | jit globals/trap +opt |     3.7 | MIPS   | 2186.8 | x41.83 |      8000010 |
| divmod      | jit globals/inline    |     3.7 | MIPS   | 2147.7 | x41.08 |      8000010 |
| divmod      | jit memory/inline     |     3.4 | MIPS   | 2373.3 | x45.39 |      8000010 |
| divmod      | jit tail-chain        |     3.8 | MIPS   | 2115.0 | x40.45 |      8000010 |
| branchy     | interpreter           |    85.3 | MIPS   |   59.8 |  x1.00 |      5100215 |
| branchy     | jit globals/trap      |     4.5 | MIPS   | 1146.1 | x19.16 |      5100215 |
| branchy     | jit globals/trap +opt |     4.5 | MIPS   | 1121.7 | x18.75 |      5100215 |
| branchy     | jit globals/inline    |     4.4 | MIPS   | 1157.9 | x19.36 |      5100215 |
| branchy     | jit memory/inline     |     3.8 | MIPS   | 1329.1 | x22.22 |      5100215 |
| branchy     | jit tail-chain        |     5.1 | MIPS   | 1004.5 | x16.79 |      5100215 |
| calls       | interpreter           |    52.1 | MIPS   |   46.1 |  x1.00 |      2400786 |
| calls       | jit globals/trap      |    10.0 | MIPS   |  239.5 |  x5.20 |      2400947 |
| calls       | jit globals/trap +opt |    10.4 | MIPS   |  230.8 |  x5.01 |      2400947 |
| calls       | jit globals/inline    |    11.5 | MIPS   |  208.4 |  x4.52 |      2400947 |
| calls       | jit memory/inline     |     8.0 | MIPS   |  301.7 |  x6.55 |      2400947 |
| calls       | jit tail-chain        |    10.6 | MIPS   |  226.8 |  x4.92 |      2400947 |
| atomics     | interpreter           |   120.8 | MIPS   |   41.4 |  x1.00 |      5000008 |
| atomics     | jit globals/trap      |    10.1 | MIPS   |  497.3 | x12.01 |      5000008 |
| atomics     | jit globals/trap +opt |     9.9 | MIPS   |  505.1 | x12.20 |      5000008 |
| atomics     | jit globals/inline    |     9.9 | MIPS   |  503.2 | x12.15 |      5000008 |
| atomics     | jit memory/inline     |     9.5 | MIPS   |  527.0 | x12.73 |      5000008 |
| atomics     | jit tail-chain        |     9.5 | MIPS   |  524.8 | x12.67 |      5000008 |
| matrix      | interpreter           |    28.5 | MIPS   |   52.2 |  x1.00 |      1490047 |
| matrix      | jit globals/trap      |   0.933 | MIPS   | 1597.0 | x30.60 |      1490157 |
| matrix      | jit globals/trap +opt |     1.1 | MIPS   | 1330.1 | x25.48 |      1490157 |
| matrix      | jit globals/inline    |   0.966 | MIPS   | 1543.1 | x29.56 |      1490157 |
| matrix      | jit memory/inline     |   0.642 | MIPS   | 2322.6 | x44.50 |      1490157 |
| matrix      | jit tail-chain        |   0.945 | MIPS   | 1576.1 | x30.20 |      1490157 |
| device-poll | interpreter           |     2.7 | MIPS   |   36.9 |  x1.00 |       100007 |
| device-poll | jit globals/trap      |     4.1 | MIPS   |   24.3 |  x0.66 |       100010 |
| device-poll | jit globals/trap +opt |     4.1 | MIPS   |   24.2 |  x0.66 |       100010 |
| device-poll | jit globals/inline    |     4.1 | MIPS   |   24.3 |  x0.66 |       100016 |
| device-poll | jit memory/inline     |     4.0 | MIPS   |   24.9 |  x0.67 |       100016 |
| device-poll | jit tail-chain        |     4.0 | MIPS   |   24.8 |  x0.67 |       100010 |

<details><summary>JIT compile cost</summary>

| case        | variant               | regions | blocks | wasm bytes | compile ms | instantiate ms |
| ----------- | --------------------- | ------: | -----: | ---------: | ---------: | -------------: |
| arith-loop  | jit globals/trap      |       1 |      2 |        622 |       0.10 |           0.06 |
| arith-loop  | jit globals/trap +opt |       1 |      2 |        622 |       0.09 |           0.09 |
| arith-loop  | jit globals/inline    |       1 |      2 |        633 |       0.10 |           0.09 |
| arith-loop  | jit memory/inline     |       1 |      2 |        356 |       0.08 |           0.04 |
| arith-loop  | jit tail-chain        |       1 |      2 |        638 |       0.10 |           0.06 |
| memory-copy | jit globals/trap      |       1 |      4 |        844 |       0.25 |           0.08 |
| memory-copy | jit globals/trap +opt |       1 |      4 |        844 |       0.22 |           0.07 |
| memory-copy | jit globals/inline    |       1 |      4 |        903 |       0.19 |           0.09 |
| memory-copy | jit memory/inline     |       1 |      4 |        892 |       0.12 |           0.05 |
| memory-copy | jit tail-chain        |       1 |      4 |        860 |       0.13 |           0.07 |
| divmod      | jit globals/trap      |       1 |      2 |        682 |       0.13 |           0.09 |
| divmod      | jit globals/trap +opt |       1 |      2 |        682 |       0.12 |           0.06 |
| divmod      | jit globals/inline    |       1 |      2 |        693 |       0.21 |           0.11 |
| divmod      | jit memory/inline     |       1 |      2 |        486 |       0.08 |           0.04 |
| divmod      | jit tail-chain        |       1 |      2 |        698 |       0.12 |           0.08 |
| branchy     | jit globals/trap      |       1 |      5 |        701 |       0.23 |           0.06 |
| branchy     | jit globals/trap +opt |       1 |      5 |        701 |       0.19 |           0.08 |
| branchy     | jit globals/inline    |       1 |      5 |        712 |       0.23 |           0.10 |
| branchy     | jit memory/inline     |       1 |      5 |        493 |       0.11 |           0.83 |
| branchy     | jit tail-chain        |       1 |      5 |        717 |       0.18 |           0.08 |
| calls       | jit globals/trap      |       4 |     10 |       2870 |       0.25 |           0.12 |
| calls       | jit globals/trap +opt |       4 |     10 |       2870 |       0.68 |           0.25 |
| calls       | jit globals/inline    |       4 |     10 |       3130 |       0.23 |           0.11 |
| calls       | jit memory/inline     |       4 |     10 |       2310 |       0.16 |           0.08 |
| calls       | jit tail-chain        |       4 |     10 |       2934 |       0.27 |           0.15 |
| atomics     | jit globals/trap      |       1 |      2 |        681 |       0.08 |           0.06 |
| atomics     | jit globals/trap +opt |       1 |      2 |        681 |       0.10 |           0.09 |
| atomics     | jit globals/inline    |       1 |      2 |        716 |       0.12 |           0.07 |
| atomics     | jit memory/inline     |       1 |      2 |        471 |       0.08 |           0.04 |
| atomics     | jit tail-chain        |       1 |      2 |        697 |       0.09 |           0.07 |
| matrix      | jit globals/trap      |       1 |      6 |       1078 |       0.10 |           0.08 |
| matrix      | jit globals/trap +opt |       1 |      6 |       1078 |       0.18 |           0.07 |
| matrix      | jit globals/inline    |       1 |      6 |       1161 |       0.17 |           0.08 |
| matrix      | jit memory/inline     |       1 |      6 |       1516 |       0.11 |           0.05 |
| matrix      | jit tail-chain        |       1 |      6 |       1094 |       0.15 |           0.09 |
| device-poll | jit globals/trap      |       2 |      8 |       1424 |       0.16 |           0.15 |
| device-poll | jit globals/trap +opt |       2 |      8 |       1424 |       0.17 |           0.10 |
| device-poll | jit globals/inline    |       2 |      8 |       1482 |       0.15 |           0.10 |
| device-poll | jit memory/inline     |       2 |      8 |       1020 |       0.08 |           0.05 |
| device-poll | jit tail-chain        |       2 |      8 |       1456 |       0.19 |           0.11 |

</details>

## wasm

| case           | variant                     | best ms | metric                           | value | vs ref |                                                                                                                                                                                                                                  instructions |
| -------------- | --------------------------- | ------: | -------------------------------- | ----: | -----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: |
| features       | probe                       |   0.126 | probe ms (lower better)          |  0.13 |  x1.00 |                                                                                                                                                                                                                                             1 |
| features       | probe                       |         |                                  |       |        | threads=true sharedMemoryGrowable=true atomics=true atomicWait=true simd=true bulkMemory=true memory64=true tailCalls=true exceptions=true maxMemory32Pages=65536 maxSharedMemoryPages=65536 hardwareConcurrency=2 isWorker=false isNode=true |
| memory-reserve | 4 GiB max, 1 page committed |   0.006 | reserve ms (lower better)        | 0.006 |  x1.00 |                                                                                                                                                                                                                                         65536 |
| memory-reserve | 4 GiB max, shared           |   0.006 | reserve ms (lower better)        | 0.006 |  x0.98 |                                                                                                                                                                                                                                         65536 |
| memory-reserve | 256 MiB committed           |   0.009 | reserve ms (lower better)        | 0.009 |  x1.47 |                                                                                                                                                                                                                                          4096 |
| memory-reserve | 256 MiB committed, shared   |   0.006 | reserve ms (lower better)        | 0.006 |  x1.08 |                                                                                                                                                                                                                                          4096 |
| memory-reserve | 4 GiB max, 1 page committed |         |                                  |       |        |                                                                                                                                                                                                ok=true initialPages=1 requestedMaxPages=65536 |
| memory-reserve | 4 GiB max, shared           |         |                                  |       |        |                                                                                                                                                                                                ok=true initialPages=1 requestedMaxPages=65536 |
| memory-reserve | 256 MiB committed           |         |                                  |       |        |                                                                                                                                                                                              ok=true initialPages=4096 requestedMaxPages=4096 |
| memory-reserve | 256 MiB committed, shared   |         |                                  |       |        |                                                                                                                                                                                              ok=true initialPages=4096 requestedMaxPages=4096 |
| module-compile | 256 instructions            |   0.003 | compile ms (lower better)        | 0.003 |  x1.00 |                                                                                                                                                                                                                                           256 |
| module-compile | 4096 instructions           |   0.006 | compile ms (lower better)        | 0.006 |  x1.94 |                                                                                                                                                                                                                                          4096 |
| module-compile | 32768 instructions          |   0.052 | compile ms (lower better)        | 0.052 | x16.49 |                                                                                                                                                                                                                                         32768 |
| module-compile | 256 instructions            |         |                                  |       |        |                                                                                                                                                                                                              moduleBytes=936 nsPerInsn=15.625 |
| module-compile | 4096 instructions           |         |                                  |       |        |                                                                                                                                                                                                             moduleBytes=14376 nsPerInsn=2.111 |
| module-compile | 32768 instructions          |         |                                  |       |        |                                                                                                                                                                                                            moduleBytes=114730 nsPerInsn=3.195 |
| atomics-micro  | micro x1000000              |    30.3 | wasm atomic ns/op (lower better) |  9.46 |  x1.00 |                                                                                                                                                                                                                                       1000000 |
| atomics-micro  | micro x1000000              |         |                                  |       |        |                                                                                                                                                     jsAtomicsAddNs=10.219 jsCmpxchgNs=11.029 wasmAtomicAddNs=9.462 wasmPlainStoreLoadNs=0.307 |

## baseline

| case       | variant                   | best ms | metric |  value | vs ref |                               instructions |
| ---------- | ------------------------- | ------: | ------ | -----: | -----: | -----------------------------------------: |
| arith-loop | interpreter (ours)        |   133.3 | MIPS   |   60.0 |  x1.00 |                                    8000006 |
| arith-loop | jit globals/trap (ours)   |     4.4 | MIPS   | 1829.0 | x30.49 |                                    8000006 |
| arith-loop | 8086emu 1.5.1 (rust/wasm) |    49.9 | MIPS   |  160.3 |  x2.67 |                                    8000006 |
| arith-loop | interpreter (ours)        |         |        |        |        | result=-1188726464 imageBytes=40 stop=exit |
| arith-loop | jit globals/trap (ours)   |         |        |        |        | result=-1188726464 imageBytes=40 stop=exit |
| arith-loop | 8086emu 1.5.1 (rust/wasm) |         |        |        |        |   imageBytes=40 halted=true stoppedAtPc=40 |
| divmod     | interpreter (ours)        |   128.2 | MIPS   |   62.4 |  x1.00 |                                    8000010 |
| divmod     | jit globals/trap (ours)   |     3.8 | MIPS   | 2118.5 | x33.95 |                                    8000010 |
| divmod     | 8086emu 1.5.1 (rust/wasm) |    50.0 | MIPS   |  160.0 |  x2.56 |                                    8000010 |
| divmod     | interpreter (ours)        |         |        |        |        |  result=-960849228 imageBytes=72 stop=exit |
| divmod     | jit globals/trap (ours)   |         |        |        |        |  result=-960849228 imageBytes=72 stop=exit |
| divmod     | 8086emu 1.5.1 (rust/wasm) |         |        |        |        |   imageBytes=72 halted=true stoppedAtPc=72 |
| branchy    | interpreter (ours)        |    89.4 | MIPS   |   57.1 |  x1.00 |                                    5100215 |
| branchy    | jit globals/trap (ours)   |     4.5 | MIPS   | 1134.5 | x19.88 |                                    5100215 |
| branchy    | 8086emu 1.5.1 (rust/wasm) |    33.7 | MIPS   |  151.2 |  x2.65 |                                    5100215 |
| branchy    | interpreter (ours)        |         |        |        |        |      result=600000 imageBytes=80 stop=exit |
| branchy    | jit globals/trap (ours)   |         |        |        |        |      result=600000 imageBytes=80 stop=exit |
| branchy    | 8086emu 1.5.1 (rust/wasm) |         |        |        |        |  imageBytes=80 halted=false stoppedAtPc=44 |

<details><summary>JIT compile cost</summary>

| case       | variant                 | regions | blocks | wasm bytes | compile ms | instantiate ms |
| ---------- | ----------------------- | ------: | -----: | ---------: | ---------: | -------------: |
| arith-loop | jit globals/trap (ours) |       1 |      2 |        622 |       0.19 |           0.44 |
| divmod     | jit globals/trap (ours) |       1 |      2 |        682 |       0.15 |           0.09 |
| branchy    | jit globals/trap (ours) |       1 |      5 |        701 |       0.16 |           0.08 |

</details>

Measured in 18.0 s.
