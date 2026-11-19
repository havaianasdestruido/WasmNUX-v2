# ADR-0011: Apache-2.0 core; independent guest licensing

**Status:** Accepted.

**Decision.** Retain the repository's existing Apache License 2.0 for original core, host and tooling code. This is a single license, not an automatic MIT dual license. Keep GPL/LGPL guest artifacts and drivers separately built, documented and distributed under their own licenses and source-provision requirements. Review dependencies and generated artifacts before bundling; see [NOTICE.md](../../NOTICE.md).

**Alternatives.** MIT would also be permissive but changes the existing terms and lacks an explicit patent grant. A copyleft core could deter embedding and does not remove obligations for third-party artifacts.

**Validation.** Record licenses and versions, preserve notices and track source obligations in the image build. Pin toolchains/dependencies and ship an SBOM with releases. No Debian kernel, Mesa binary or firmware image is included in this Phase 0 PR.
