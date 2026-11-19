# ADR-0011: Licensing — permissive core, GPL components isolated

- **Status:** Accepted (Phase 0)
- **Related:** ADR-0005, ADR-0006, ADR-0008, ADR-0012

## Context

WasmNUX is three different things with three different licensing realities:

1. **Our code** — emulator core, JIT, host runtime, terminal renderer, relay,
   image tooling.
2. **Debian's contents** — the kernel (GPL-2.0), glibc (LGPL), Mesa, systemd,
   and the whole archive, each under its own licence, delivered to the guest by
   `apt`.
3. **Our dependencies** — today: typescript (Apache-2.0), vitest (MIT),
   prettier (MIT), tsx (MIT), playwright-core (Apache-2.0), esbuild (MIT), and
   `8086emu` 1.5.1 (MIT) used _only_ as a benchmark comparator.

The goal that constrains everything is §1.7: `@wasmnux/core` is embeddable by
other sites. An embedder will not ship a copyleft runtime inside their own
product, so a copyleft core would end embeddability — and the image pipeline
would still have to isolate the GPL parts anyway.

## Decision

- **The core is Apache-2.0.** `LICENSE` at the repository root is Apache-2.0
  (already in place), chosen over MIT for its explicit patent grant, which
  matters for a project implementing ISA semantics and shipping a JIT.
- **GPL components are not linked into our code; they are _data_.** The kernel,
  glibc, Mesa and the rest live in the guest image, fetched by `apt` or built by
  the image pipeline, and are distributed under their own terms with their own
  notices. Nothing in `core/`, `host/`, `relay/` or `benchmarks/` links against
  them.
- **The tuned `wasmnux` kernel (ADR-0006) is GPL-2.0**, built reproducibly from
  Debian sources plus a published config delta, with complete corresponding
  source offered alongside the binary — as Debian itself does.
- **Any guest-side code we write that runs in the kernel's address space or
  links GPL libraries is GPL**, and lives in `guest/`, clearly separated. The
  `wnxd` agent and `wnx` CLI are user-space programs talking over virtio-vsock;
  they are ours to license permissively, but §2 lists them as Rust built against
  glibc — if any of them ends up linking a GPL library, that component's licence
  follows the library.
- **A `NOTICE` per workspace and a generated SBOM per release** (§10: pinned
  toolchains, locked dependencies, SBOM per release), so the third-party licence
  set is a build artefact, not a hand-maintained file.
- **Benchmark comparators are devDependencies only.** `8086emu` is MIT and is
  imported by `benchmarks/suites/baseline.ts` for speed comparison; it is never
  shipped in a product bundle. Any future GPL comparator (e.g. a QEMU-derived
  baseline) must stay out of `dependencies` and out of any distributed artefact.
- **`coi-serviceworker` or its replacement** (ADR-0010) must be permissively
  licensed or vendored under a compatible licence, since it ships to every
  static-host deployment.

**Rejected: copyleft core (GPL/AGPL).** It ends embeddability (§1.7), and it
does not buy anything for the Debian side, whose licences are unaffected by ours.
AGPL in particular would make a hosted WasmNUX service a derivative work of
itself in a way that deters the self-hosting story ADR-0008 depends on.

**Rejected: MIT instead of Apache-2.0.** Nearly equivalent in practice, but
Apache-2.0's express patent grant and its clearer contribution terms are worth
having for a project whose value is a JIT and an ISA implementation.

## Consequences

**Positive**

- Embeddable: a site can ship `@wasmnux/core` under Apache-2.0 without opening
  their own source.
- Debian content is handled the way Debian handles it — by distribution, with
  notices and source offers — instead of by relicensing, which is impossible.
- Contributors get a clear rule: our code is Apache-2.0; code destined for the
  guest kernel's address space is GPL and lives in `guest/`.

**Negative / obligations**

- **We owe a source-offer and build-reproducibility pipeline for the tuned
  kernel**, and for any GPL guest component we ship from our apt repo.
- **A licence check belongs in CI**: every new dependency is reviewed for
  compatibility, and the SBOM is generated per release. Nothing enforces this
  yet — it is a Phase 0 follow-up, not done.
- **Trademark/name care**: Apache-2.0 does not grant trademark rights, so a fork
  cannot call itself WasmNUX; worth stating in CONTRIBUTING.
- **Debian's own policy on non-free firmware** interacts with ADR-0001's
  architecture choice: riscv64 needs little to none, which is a quiet argument
  for it and should be checked in Phase 8's exclusion list.
- Some useful libraries are GPL-only (certain filesystem or crypto code). The
  rule above means we cannot use them in the core; we must find permissive
  equivalents or implement the piece ourselves.

## Follow-ups

- [ ] CI licence check (allowlist: Apache-2.0, MIT, BSD-2/3, ISC, Unicode) failing on anything else in `dependencies`.
- [ ] `NOTICE` files per workspace, generated from the dependency tree.
- [ ] SBOM generation (CycloneDX or SPDX) wired into the release job.
- [ ] DCO or CLA decision for contributions (see `CONTRIBUTING.md`).
