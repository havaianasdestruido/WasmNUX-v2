# ADR-0012: Debian tracking — stable, with scripted access to testing/sid

- **Status:** Accepted (Phase 0)
- **Related:** ADR-0005, ADR-0006, ADR-0011

## Context

The product claim is "real Debian" (§1.3): an unmodified userland where `apt`
works. But _which_ Debian? The base image is built once, chunked and
content-addressed (ADR-0005), cached in the browser for weeks or months, and
shared between instances. Debian meanwhile moves continuously: `stable` gets
point releases and security updates, `testing` rolls daily, `sid` rolls faster.

The three real options are: pin to `stable` and let users upgrade inside the
guest; build rolling images continuously; or track `testing`/`sid` by default for
freshness.

There is also an operational constraint that decides more than taste does: the
base image is a **build artefact we host**, and every suite we track is another
image to build, sign, chunk, test, and keep downloadable. Each one multiplies CI
time and storage, and each one is a compatibility matrix we owe users
(Phase 8's tiered harness).

## Decision

- **Track `stable`.** The default base image is built from the current stable
  suite, and the image manifest records the exact suite, snapshot date, and
  package versions used, so a build is reproducible.
- **Upgrades happen inside the guest, with `apt`.** `apt update && apt
dist-upgrade` moves an instance to the next point release or the next stable,
  writing to the COW overlay (ADR-0005). We do not ship a new base image to
  deliver a security update; the guest updates itself the way any Debian system
  does.
- **`testing` and `sid` are available by script**, not by default:
  `scripts/utils/apt/switch_suite.sh {stable,testing,sid}` rewrites sources and
  pins what must be pinned (`pin_kernel.sh` keeps the kernel from being dragged
  along by a suite switch, per ADR-0006). This is a documented, supported escape
  hatch with a warning, not an unsupported configuration.
- **Base images are rebuilt on a schedule and on stable point releases**, and
  every rebuild is a new content-addressed chunk set, so an existing instance
  keeps its bytes and a new instance gets the fresh ones. Chunk content
  addressing makes old and new bases coexist in one cache.
- **Release upgrades are tested in CI as a guest-side operation** (Phase 8:
  "`apt dist-upgrade` stable → next stable inside the guest"), because that is
  the path users actually take.
- **The compatibility dashboard (Phase 8) reports against stable.** Numbers for
  `testing`/`sid` are best-effort and labelled as such.

**Rejected: rolling images.** Every CI run would produce a different base, so a
performance or compatibility regression could not be attributed to our change —
it might be a package that moved upstream. It also multiplies hosting and makes
"reproduce this bug" impossible without the exact chunk set. Reproducibility is
worth more than freshness here, and freshness is available inside the guest
anyway.

**Rejected: tracking `testing`/`sid` by default.** It would make the default
experience the one Debian itself warns about, and Phase 8's compatibility
numbers would describe a moving target. Users who want it can have it in one
command.

## Consequences

**Positive**

- A reproducible, signed, chunked base per stable point release: bugs are
  attributable, benchmarks are comparable commit-to-commit, and the KPI gates
  (ADR-0002, Spike A) mean something.
- Users get security updates at Debian's cadence through the mechanism Debian
  provides, with no involvement from us.
- The shared OPFS package cache (ADR-0008) makes `dist-upgrade` cheap on a
  second instance.
- One compatibility matrix to maintain publicly, with the escape hatch documented
  rather than hidden.

**Negative / costs**

- **Stable is older software.** Anyone wanting a current compiler or driver
  switches suites and accepts the consequences; that has to be said plainly in
  the docs.
- **The overlay grows on every upgrade**, since the base is immutable. Discard
  and overlay compaction (ADR-0005) become a real requirement rather than an
  optimisation, and a long-lived instance that has been `dist-upgrade`d twice may
  be carrying a mostly-rewritten filesystem on top of a base it no longer uses.
  A "rebase onto new base image" operation is a likely follow-up.
- **We still owe a build pipeline**: debootstrap `minbase`, curated package set,
  chunking, hashing, compression, signed manifest (Phase 2's image pipeline),
  run per stable point release.
- **Two kernels × one suite** (ADR-0006) is the supported matrix; anything else
  is user-configured and unsupported.

## Follow-ups

- [ ] `scripts/utils/apt/switch_suite.sh` and `pin_kernel.sh` (Phase 1/2, with the §8 script conventions: idempotent, `--dry-run`, non-interactive, package lists in `packages/*.list`).
- [ ] Record suite + snapshot date + package versions in the image manifest.
- [ ] Overlay compaction / rebase-onto-new-base operation.
- [ ] CI job: boot the current stable base, run `apt update && apt dist-upgrade`, assert a clean boot afterwards.
