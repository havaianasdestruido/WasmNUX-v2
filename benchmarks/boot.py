#!/usr/bin/env python3
"""Time a boot/resume launcher until a guest emits an exact serial marker."""
import argparse
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import time


def probe(argv, marker, timeout, require_bytes=False):
    if not argv or not marker or b'\n' in marker or timeout <= 0:
        raise ValueError('expected a launcher, one-line marker and positive timeout')
    prefix = b'WNX_TRANSFER_BYTES='
    transfer_bytes = None
    start = time.monotonic()
    with subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True) as child:
        try:
            with selectors.DefaultSelector() as io:
                io.register(child.stdout, selectors.EVENT_READ)
                tail = b''
                dropping = False
                while (left := start + timeout - time.monotonic()) > 0:
                    if not io.select(left):
                        break
                    data = os.read(child.stdout.fileno(), 8192)
                    if not data:
                        raise ValueError('launcher closed stdout before readiness marker')
                    parts = (tail + data).split(b'\n')
                    for index, line in enumerate(parts[:-1]):
                        if dropping and index == 0:
                            continue
                        line = line.removesuffix(b'\r')
                        if require_bytes and line.startswith(prefix):
                            number = line.removeprefix(prefix)
                            if transfer_bytes is not None or not re.fullmatch(rb'[0-9]{1,16}', number):
                                raise ValueError('invalid or duplicate first-visit byte count')
                            transfer_bytes = int(number)
                        if line == marker:
                            info = {'elapsedMs':(time.monotonic() - start) * 1000}
                            if require_bytes:
                                if transfer_bytes is None:
                                    raise ValueError('first-visit launcher did not report transfer bytes before readiness')
                                info['transferBytes'] = transfer_bytes
                            return info
                    max_line = max(len(marker), len(prefix)+16 if require_bytes else 0) + 1
                    dropping = (dropping and len(parts) == 1) or len(parts[-1]) > max_line
                    tail = b'' if dropping else parts[-1]
            raise TimeoutError('readiness marker was not observed')
        finally:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--target', required=True)
    parser.add_argument('--mode', choices=['resume-warm','cold-warm-cache','first-visit'], required=True)
    parser.add_argument('--marker', default='WNX_LOGIN_READY')
    parser.add_argument('--timeout', type=float, default=90)
    parser.add_argument('--samples', type=int, default=5)
    parser.add_argument('launcher', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    launcher = args.launcher[1:] if args.launcher[:1] == ['--'] else args.launcher
    if args.samples < 1 or not re.fullmatch(r'[0-9a-f]{40}', args.commit) or not launcher:
        parser.error('expected positive samples, full git SHA and a launcher after --')
    samples = []
    for _ in range(args.samples):
        try:
            samples.append({'status':'measured', **probe(launcher, args.marker.encode(), args.timeout, require_bytes=args.mode == 'first-visit')})
        except (OSError, ValueError) as error:
            samples.append({'status':'failed', 'reason':str(error)})
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({'schema':1, 'commit':args.commit, 'target':args.target, 'mode':args.mode,
                                    'launcher':launcher, 'marker':args.marker, 'samples':samples}, indent=2) + '\n')
    return int(any(r['status'] == 'failed' for r in samples))


if __name__ == '__main__':
    raise SystemExit(main())
