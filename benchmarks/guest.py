#!/usr/bin/env python3
"""Run named workloads on a prepared Debian guest (or a labeled control)."""
import argparse
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import subprocess
import tempfile
import time

NUMBER = r'(\d+(?:\.\d+)?)'


def parse_metrics(kind, output):
    pattern = {
        'coremark': rf'^CoreMark 1\.0\s*:\s*{NUMBER}',
        'dhrystone': rf'Dhrystones per Second:\s*{NUMBER}',
        'sysbench': rf'events per second:\s*{NUMBER}',
    }.get(kind)
    if pattern:
        match = re.search(pattern, output, re.MULTILINE)
        if not match:
            raise ValueError(f'{kind} completion score missing')
        unit = 'eventsPerSecond' if kind == 'sysbench' else 'iterationsPerSecond'
        return {unit: float(match[1])}
    if kind == 'fio':
        record = json.loads(output)
        jobs = record['jobs']
        if len(jobs) != 1 or jobs[0]['error']:
            raise ValueError('fio profile requires exactly one successful job')
        job = jobs[0]
        return {mode: {key: job[mode][key] for key in ('bw_bytes', 'iops', 'io_bytes')}
                for mode in ('read', 'write')}
    if kind == 'gcc':
        return {}  # Wall time covers the actual bootstrap target.
    raise ValueError(f'unknown workload: {kind}')


def command(argv, cwd=None, timeout=120):
    if not isinstance(argv, list) or not argv or not all(isinstance(arg, str) and arg for arg in argv):
        raise ValueError('command must be a nonempty list of nonempty strings')
    started = time.monotonic()
    env = {**os.environ, 'LC_ALL': 'C'}
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        with subprocess.Popen(argv, cwd=cwd, stdout=stdout, stderr=stderr, start_new_session=True, env=env) as child:
            try:
                code = child.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
                raise
        elapsed = (time.monotonic() - started) * 1000
        if stdout.tell() > 16 * 1024**2:
            raise ValueError('benchmark stdout is over 16 MiB')
        stdout.seek(0)
        if code:
            stderr.seek(max(0, stderr.tell()-2048))
            raise ValueError(f'exit {code}: {stderr.read().decode(errors="replace")}')
        return elapsed, stdout.read().decode(errors='replace')


def workload(name, kind, argv, cwd=None, timeout=120):
    base = {'name': name, 'kind': kind, 'argv': argv}
    try:
        elapsed, output = command(argv, cwd, timeout)
        metrics = parse_metrics(kind, output)
    except FileNotFoundError as error:
        return {**base, 'status': 'unavailable', 'reason': str(error)}
    except (subprocess.TimeoutExpired, ValueError, KeyError, IndexError) as error:
        return {**base, 'status': 'failed', 'reason': str(error)}
    return {**base, 'status': 'measured', 'elapsedMs': elapsed, 'metrics': metrics}


def suite(args, scratch):
    fio = str(Path(scratch) / 'test.fio')
    tests = [
        ('coremark', 'coremark', [args.coremark]),
        ('dhrystone', 'dhrystone', [args.dhrystone]),
        ('sysbench', 'sysbench', ['sysbench', 'cpu', f'--threads={args.jobs}', '--time=10', 'run']),
    ]
    fixture = f'--filename={fio}'
    fio_args = [fixture, '--size=64M', '--numjobs=1', '--ioengine=sync', '--iodepth=1', '--direct=1', '--output-format=json']
    # The read tests never create their own data. If prefill fails, report that
    # dependency rather than benchmarking sparse reads or file allocation.
    write = workload('fio-sequential-write-flush', 'fio', ['fio', '--name=seqwrite', '--rw=write', '--bs=1M', '--end_fsync=1', *fio_args])
    for name, mode, bs in [('fio-sequential-read','read','1M'), ('fio-random-read','randread','4k')]:
        argv = ['fio', f'--name={name}', f'--rw={mode}', f'--bs={bs}', '--allow_file_create=0', *fio_args]
        if write['status'] == 'measured':
            tests.append((name, 'fio', argv))
    results = [workload(*spec) for spec in tests] + [write]
    if write['status'] != 'measured':
        results.extend({'name': n, 'kind':'fio', 'status':'unavailable', 'reason':'sequential prefill did not complete'}
                       for n in ('fio-sequential-read', 'fio-random-read'))
    gcc = ['make', f'-j{args.jobs}', 'bootstrap']
    # Configure a fresh, out-of-tree GCC build before invoking this harness.
    if args.gcc_build is None:
        results.append({'name':'gcc-bootstrap', 'kind':'gcc', 'status':'unavailable', 'reason':'no clean configured GCC build directory'})
    else:
        results.append(workload('gcc-bootstrap', 'gcc', gcc, cwd=args.gcc_build, timeout=args.gcc_timeout))
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--commit', required=True, help='full source commit SHA of the tested revision')
    parser.add_argument('--target', required=True, help='e.g. WasmNUX, QEMU-TCG, native control')
    parser.add_argument('--jobs', type=int, default=1)
    parser.add_argument('--coremark', default='coremark')
    parser.add_argument('--dhrystone', default='dhrystone')
    parser.add_argument('--gcc-build', type=Path)
    parser.add_argument('--gcc-timeout', type=int, default=4 * 60 * 60)
    parser.add_argument('--disk-dir', type=Path, required=True, help='scratch filesystem to test; must not be tmpfs for disk comparisons')
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9a-f]{40}', args.commit) or min(args.jobs, args.gcc_timeout) < 1:
        parser.error('expected a full git SHA, positive jobs and positive GCC timeout')
    # Some machines have the unrelated Python "fio" executable; parsing the
    # expected JSON and requiring a successful storage job prevents false data.
    if shutil.which('fio') is None:
        print('fio not installed; recording unavailable storage workloads')
    with tempfile.TemporaryDirectory(prefix='wnx-fio-', dir=args.disk_dir.resolve()) as scratch:
        results = suite(args, scratch)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({'schema':1, 'commit':args.commit, 'target':args.target,
                                    'environment':{'platform':platform.platform(), 'jobs':args.jobs},
                                    'results':results}, indent=2) + '\n')
    return int(any(r['status'] == 'failed' for r in results))


if __name__ == '__main__':
    raise SystemExit(main())
