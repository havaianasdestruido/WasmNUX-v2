import gzip
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'benchmarks'))
from boot import probe
from coverage import collect
from gpu_paths import matrix
from guest import parse_metrics, workload


class BenchmarkTests(unittest.TestCase):
    def test_scores_and_fio_failure(self):
        self.assertEqual(parse_metrics('coremark', 'CoreMark 1.0 : 200.42 / cc'), {'iterationsPerSecond':200.42})
        self.assertEqual(parse_metrics('dhrystone', 'Dhrystones per Second:  196'), {'iterationsPerSecond':196})
        self.assertEqual(parse_metrics('sysbench', 'events per second: 15.0'), {'eventsPerSecond':15})
        stats = {'bw_bytes':1234, 'iops':8, 'io_bytes':90000}
        self.assertEqual(parse_metrics('fio', json.dumps({'jobs':[{'error':0, 'read':stats, 'write':stats}]})), {'read':stats,'write':stats})
        with self.assertRaises(ValueError):
            parse_metrics('fio', '{"jobs":[{"error":1}]}')
        with self.assertRaises(ValueError):
            parse_metrics('coremark', 'garbage')

    def test_workload_statuses(self):
        self.assertEqual(workload('x','sysbench',['/nonexistent'])['status'], 'unavailable')
        self.assertEqual(workload('x','sysbench',[sys.executable,'-c','print("nonsense")'])['status'], 'failed')
        self.assertEqual(workload('x','sysbench',[sys.executable,'-c','print("events per second: 4")'])['status'], 'measured')
        self.assertEqual(workload('x','gcc',[sys.executable,'-c','import time; time.sleep(5)'], timeout=.02)['status'], 'failed')

    def test_boot_exact_marker_across_chunks_and_crlf(self):
        self.assertGreater(probe([sys.executable,'-u','-c',
            'import time; print("NOT_READY"); print("x"*12000+"READY"); print("RE",end=""); time.sleep(.03); print("ADY\\r")'], b'READY', 2)['elapsedMs'], 0)
        with self.assertRaises(ValueError):
            probe([sys.executable,'-c','print("NOT_READY")'], b'READY', 1)
        with self.assertRaises(TimeoutError):
            probe([sys.executable,'-c','import time; time.sleep(5)'], b'READY', .05)

    def test_first_visit_requires_browser_byte_accounting(self):
        launch = lambda text: [sys.executable, '-c', f'print({text!r})']
        self.assertEqual(probe(launch('WNX_TRANSFER_BYTES=2345\nREADY'), b'READY', 1, require_bytes=True)['transferBytes'], 2345)
        with self.assertRaises(ValueError):
            probe(launch('READY'), b'READY', 1, require_bytes=True)

    def test_graphics_matrix_keeps_unprovisioned_paths_visible(self):
        sample = {'conformance':{'smoke':True,'subset-2':False}, 'frameTimesMs':[12.1,14]}
        results = matrix({'software':{'configuration':'software fixture',
                                      'argv':[sys.executable,'-c',f'print({json.dumps(sample)!r})']}})
        self.assertEqual(results['virgl']['status'], 'unavailable')
        self.assertEqual(results['software']['conformance'], sample['conformance'])
        self.assertEqual(matrix({'software':{'configuration':'invalid data','argv':[sys.executable,'-c','print("{}")']}})['software']['status'], 'failed')

    def test_archive_package_sets_filter_arch_dedup_and_hash(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'Packages.gz'
            with gzip.open(path, 'wt') as index:
                index.write('Package: common\nArchitecture: all\n\nPackage: wrong\nArchitecture: amd64\n\n'
                            'Package: native\nArchitecture: riscv64\n\nPackage: native\nArchitecture: riscv64')
            packages, metadata = collect([path,path], 'riscv64')
            self.assertEqual(packages, {'common','native'})
            self.assertEqual(len(metadata), 1)
            self.assertEqual(len(metadata[0]['sha256']), 64)
