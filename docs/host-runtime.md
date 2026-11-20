# Experimental browser host primitives

## SMP

`runBrowserSmp(options, workerUrl)` accepts the same `SmpRunOptions` data shape as
Node `runSmp`. Build `host/src/workers/hart.ts` as a module worker; `npm run build`
produces `dist/web/hart.js`. Supply its trusted same-origin URL explicitly.
COOP `same-origin`, COEP `require-corp` and a secure context are required.

Each worker runs the **same** `core/src/smp/hart.ts`, Machine, interpreter and
SmpChannel as the Node transport. Shared Wasm RAM and the reservation/write lock
coordinate guest AMOs and LR/SC; all harts finish loading before execution.
Only startup and final results use messages; instructions do not use RPC.
The controller always terminates its workers on success, error or timeout.

Browser limits: 1–16 harts, 64 KiB–256 MiB page-aligned RAM, word-aligned RAM base, unsigned RV32
entry/stack addresses, nonnegative safe-integer instruction budget, wall timeout
1–2147483647 ms (default 60 seconds). These are per-run limits, not global quotas.
The browser API deliberately rejects unaligned RAM sizes instead of rounding.
The existing Node API and type imports remain compatible.

**Not supported:** JIT SMP, shared CLINT/PLIC/UART, IPIs, coordinated WFI, general
host/DMA integration, full RVWMO conformance, untrusted guest execution. Per-hart
Machine devices are still separate. Returned RAM is only safe for host inspection
once the run completes; do not expose raw mutable RAM while harts are running.

Evidence: existing Node SMP tests plus real Chromium tests in
`host/test/browser-checks.ts`: three repetitions of four harts doing 1000 AMOs
or LR/SC-protected increments each, with exact counter/lock checks, loader-error
propagation, invalid-input rejection and infinite-loop timeout cleanup.

## OPFS snapshots (not a disk)

`openOpfsSnapshot(name)` opens `wasmnux-snapshots-v1/<name>` in OPFS.
Names are 1–64 ASCII letters/digits/underscore/hyphen, with no path traversal.
`replace(bytes)` owns a copy before awaiting, obtains a same-origin Web Lock,
opens a temporary writable, writes the complete replacement, then closes it.
`read()` uses the same lock and returns owned bytes. All cooperating tabs/workers
must use this API/lock namespace; arbitrary same-origin code is not isolated.

Publication relies on OPFS `FileSystemFileHandle.createWritable()` replacement
semantics: staged writes do not change the previous file before successful close.
Failures opening/writing or before close preserve the old file; abort is attempted
without masking the original error. A crash **during** close can leave old or new
contents: a caller that loses the acknowledgement must reopen to determine which.
No in-place overwrite of a confirmed file or independent metadata map is used.
Shorter and empty replacements truncate the previous tail.

Each snapshot is capped at 16 MiB; reads check file size before allocating.
This is intentionally unsuitable for a Debian image. There is no global disk
quota, cap on instance names, compaction, signed image import,
virtio-blk, chunk map, sync access handle or guest fsync acknowledgement.
Each store now caps outstanding operations at four (see sector backend below).
Callers must bound aggregate request concurrency; this API is not an untrusted RPC service.
It neither requests persistent-storage permission nor prevents origin eviction.
Browser/OS crash and power-loss durability are **unvalidated**, not inferred from
an application-level close. Preserve important data outside the origin.

`SnapshotStore` exposes a small backend and exclusive-executor interface for
fault tests. Custom backends must implement atomic replacement and serialize
all users of the same file; arbitrary in-place file APIs do not meet this contract.
No prototype storage format from PRs #1–#4 is imported or silently migrated.
`HOST_PLACEHOLDER` remains exported for source compatibility but is deprecated;
it is not a capability probe.

Evidence: `host/test/snapshot.test.ts` injects open/write/pre-close failures,
checks reopen, input ownership, ordered concurrent calls, bounds and truncation.
Chromium tests use actual OPFS, Web Locks, eight concurrent worker writers and
termination after a staged write before close. These tests do not simulate a
physical power cut or prove general durable guest storage.

## Sector storage backend

`openOpfsBlockDevice(name, sectors, create = false)` wraps snapshots in a versioned
`WNXBLK01` whole-image format: a 512-byte header followed by 512-byte sectors.
The header stores sector count and sector size (little-endian u32 at offsets 8
and 12); remaining header bytes must be zero. Geometry is fixed on creation.
Names are 1–59 ASCII letters/digits/underscore/hyphen; the stored filename is
`disk-<name>`. Maximum capacity is 32767 sectors (16 MiB less the header).

`read`, `write` and `discard` validate integral sector ranges without bitwise
narrowing. Writes accept whole sectors only; discard persistently zeroes sectors
but does **not** free file space. `create` refuses to overwrite any nonempty file;
`open` rejects missing/corrupt/mismatched images rather than formatting them.
This format is new; there is no automatic prototype-format migration.

```ts
const disk = await openOpfsBlockDevice('scratch', 128, true);
await disk.write(2, new Uint8Array(512).fill(7));
const reopened = await openOpfsBlockDevice('scratch', 128);
const sector = await reopened.read(2, 1);
await reopened.discard(2, 1);
```

Each change uses `SnapshotStore.update` to lock the **entire read-modify-replace**
transaction, preventing independent workers from losing each other's sectors.
Update callbacks are synchronous/non-reentrant, must not perform external side
effects, and must return a bounded Uint8Array. A per-store limit of four outstanding
operations rejects excess work before snapshot input copying/lock acquisition;
callers must handle backpressure. This is not an origin-wide quota: independently
opened stores and retained read results are outside that admission budget.

Node and Chromium tests verify reopen, sector isolation, discard, geometry,
input ownership, failure recovery, and eight concurrent worker writers. Killing
a worker after staging an overwrite preserves the previously committed disk.

**Still experimental:** every write replaces the entire image (O(capacity)); no
sparse base, reclamation, virtio-blk frontend, queue integration, guest flush,
or durable power-loss guarantee. It is a functioning bounded host sector backend,
not yet a guest disk and not suitable for a Debian root filesystem.

## Coordinated host memory writes and syscall limits

`Machine.writeHostBytes(physicalAddress, bytes)` validates the full RAM range,
uses the SMP channel write lock, invalidates overlapping LR/SC reservations, and
invalidates the local uniprocessor JIT cache. Call it from a worker when SMP is
active: contention can use `Atomics.wait`, which is forbidden on the browser
main thread. This does not make multi-byte reads atomic. Direct typed-array or
GuestMemory writes still bypass the barrier; loading/resetting is a stopped-
machine operation, not a safe live mutation API.

The syscall input path now uses this barrier. Read/write syscalls cap transfer
at 64 KiB per guest instruction and return a partial count for larger requests;
callers must retry the remainder. Address arithmetic never wraps past 4 GiB.
This bounds one syscall's work, not total UART history or guest output over time.
Shared device state, interrupts and general host/DMA integration remain unfinished.

## Executable input contract

The ELF loader accepts static RISC-V ELF32 little-endian ET_EXEC with version 1,
52-byte headers, 32-byte program headers and zero ISA/ABI flags (the implemented
RV32IMA subset). Foreign MIPS images, dynamic/interpreter segments, unsupported
ISA/ABI flags, out-of-range segments, invalid alignment and non-executable or
unaligned entries are rejected. Earlier acceptance of EM_MIPS was incorrect;
convert/rebuild for RISC-V rather than relabeling foreign instructions.
All segment/heap bounds are checked before RAM is changed. SMP workers now use
the returned ELF e_entry, not the flat-image placement option. `core/test/elf.test.ts`
executes a synthetic static ELF in real Node workers; this is **not** kernel boot.
