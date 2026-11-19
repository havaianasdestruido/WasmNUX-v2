#!/usr/bin/env python3
"""Run explicitly provisioned guest graphics adapters; never substitute host GL."""
import argparse
import json
import math
from pathlib import Path
import re
import subprocess

from guest import command

PATHS = ('virgl', 'venus', 'webgpu-mesa', 'software')


def matrix(plan):
    unknown = set(plan) - set(PATHS)
    if unknown:
        raise ValueError(f'unknown graphics paths: {unknown}')
    results = {}
    for path in PATHS:
        case = plan.get(path)
        if case is None:
            results[path] = {'status':'unavailable', 'reason':'guest adapter unprovisioned'}
            continue
        try:
            label = case['configuration']
            if not isinstance(label, str) or not label.strip():
                raise ValueError('missing guest configuration')
            _, output = command(case['argv'], timeout=case.get('timeout', 1200))
            sample = json.loads(output)
            tests = sample['conformance']
            frames = sample['frameTimesMs']
            if not isinstance(tests, dict) or not tests or not all(isinstance(name, str) and type(ok) is bool for name, ok in tests.items()):
                raise ValueError('conformance must map named tests to boolean outcomes')
            if not isinstance(frames, list) or not frames or any(type(ms) not in (float, int) or not math.isfinite(ms) or ms <= 0 for ms in frames):
                raise ValueError('expected positive per-frame times in milliseconds')
            results[path] = {'status':'measured', 'configuration':label, 'conformance':tests, 'frameTimesMs':frames}
        except (OSError, KeyError, ValueError, TypeError, subprocess.TimeoutExpired) as error:
            results[path] = {'status':'failed', 'reason':str(error)}
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('plan', type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9a-f]{40}', args.commit):
        parser.error('expected a full git SHA')
    results = matrix(json.loads(args.plan.read_text()))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({'schema':1, 'commit':args.commit, 'paths':results}, indent=2)+'\n')
    return int(any(r['status'] == 'failed' for r in results.values()))


if __name__ == '__main__':
    raise SystemExit(main())
