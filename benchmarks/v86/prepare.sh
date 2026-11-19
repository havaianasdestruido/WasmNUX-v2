#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
mkdir -p browser-results/assets
bios=browser-results/assets/seabios.bin
hash=73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98
if ! printf '%s  %s\n' "$hash" "$bios" | sha256sum -c --status; then
  temp=$(mktemp "$bios.XXXXXX")
  trap 'rm -f -- "$temp"' EXIT
  curl -fsSL --retry 3 'https://api.github.com/repos/copy/v86/contents/bios/seabios.bin?ref=315b2b0b758703ef0e6cc7b4088d6068f83f3c20' \
    | python3 -c 'import base64,json,sys; sys.stdout.buffer.write(base64.b64decode(json.load(sys.stdin)["content"]))' > "$temp"
  printf '%s  %s\n' "$hash" "$temp" | sha256sum -c --status
  mv -- "$temp" "$bios"
fi
as --32 benchmarks/v86/loop.S -o browser-results/assets/loop.o
ld -m elf_i386 -T benchmarks/v86/link.ld -o browser-results/assets/loop.elf browser-results/assets/loop.o
