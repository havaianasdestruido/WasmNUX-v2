#!/usr/bin/env python3
"""Compare Debian binary package name sets from matching suite/component indices."""
import argparse
import gzip
import hashlib
import json
import lzma
from pathlib import Path
import re


def collect(paths, arch):
    packages = set()
    metadata = []
    for path in sorted(set(paths)):
        open_index = {'.gz': gzip.open, '.xz': lzma.open}.get(path.suffix, open)
        with open_index(path, 'rt', encoding='utf-8') as index:
            fields = {}
            for line in index:
                if not line.strip():
                    add_package(fields, packages, arch)
                    fields = {}
                    continue
                for name in ('Package', 'Architecture'):
                    if line.startswith(name + ': '):
                        fields[name] = line.split(': ', 1)[1].strip()
            add_package(fields, packages, arch)
        with path.open('rb') as stream:
            metadata.append({'path': str(path), 'sha256': hashlib.file_digest(stream, 'sha256').hexdigest()})
    if not packages:
        raise ValueError(f'no packages for {arch}')
    return packages, metadata


def add_package(fields, packages, arch):
    if fields.get('Package') and fields.get('Architecture') in (arch, 'all'):
        packages.add(fields['Package'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for arch in ('amd64', 'arm64', 'riscv64'):
        parser.add_argument(f'--{arch}', type=Path, nargs='+', required=True)
    parser.add_argument('--suite', required=True, help='codename and snapshot timestamp (use matching apt indices)')
    parser.add_argument('--commit', required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch('[0-9a-f]{40}', args.commit):
        parser.error('expected a full git SHA')
    packages, inputs = {}, {}
    for arch in ('amd64', 'arm64', 'riscv64'):
        packages[arch], inputs[arch] = collect(getattr(args, arch), arch)
    baseline = packages['amd64']
    results = {arch:{'count':len(names), 'fractionOfAmd64Present':len(names & baseline)/len(baseline),
                     'missingVsAmd64':sorted(baseline-names), 'extraVsAmd64':sorted(names-baseline)}
               for arch, names in packages.items()}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({'schema':1, 'commit':args.commit, 'suite':args.suite,
                                    'inputs':inputs, 'results':results}, indent=2)+'\n')


if __name__ == '__main__':
    main()
