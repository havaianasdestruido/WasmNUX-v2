# ADR-0012: Track Debian stable, opt in to testing/sid

**Status:** Accepted.

**Decision.** Track Debian stable, currently Debian 13 (`trixie`). Pin each image build to a suite codename and a reproducible archive snapshot/digest, not a floating `stable` alias; update images for security/release maintenance. User instances upgrade in-guest via normal apt procedures, not a mutation of the immutable base under a writable overlay. Testing and sid are explicit, separately exercised operations.

**Alternatives.** Rolling-only images impose changes on users and reduce reproducibility. Pinning a snapshot forever misses security updates. Silently rebasing guest overlays risks incompatible block histories.

**Validation.** Publish source/version manifests and matched package-index coverage. Test fresh stable boots, security updates, opt-in suite switching, release upgrades and snapshot rollback on real guests.
