#!/usr/bin/env python3
"""Exercise pack validation against isolated in-memory negative fixtures."""

import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('check_spec', ROOT / 'scripts/check-spec.py')
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)


class SpecChecks(unittest.TestCase):
    def test_current_pack(self):
        self.assertEqual(CHECKER.check(ROOT)[0], [])

    def assert_detected(self, filename, transform, expected):
        original = Path.read_text

        def read(path, *args, **kwargs):
            value = original(path, *args, **kwargs)
            return transform(value) if path == ROOT / filename else value

        with patch.object(Path, 'read_text', read):
            errors = CHECKER.check(ROOT)[0]
        self.assertTrue(any(expected in error for error in errors), errors)

    def test_cycle(self):
        self.assert_detected('docs/tasks/wave-1.md', lambda s: s.replace(
            '- **Depends On:** TASK-023', '- **Depends On:** TASK-001', 1),
            'Dependency cycle')

    def test_unknown_dependency(self):
        self.assert_detected('docs/tasks/wave-1.md', lambda s: s.replace(
            '- **Depends On:** TASK-023', '- **Depends On:** TASK-999', 1),
            'unknown dependency')

    def test_unknown_requirement(self):
        self.assert_detected('docs/tasks/wave-1.md', lambda s: s.replace(
            '- **Requirement:** REQ-001', '- **Requirement:** REQ-999', 1),
            'unknown requirement')

    def test_broken_link(self):
        self.assert_detected('README.md', lambda s: s + '\n[missing](absent-file.md)\n',
                             'broken link')

    def test_release_closure(self):
        self.assert_detected('docs/tasks/wave-6.md', lambda s: s.replace(
            'TASK-069, TASK-070, TASK-076', 'TASK-069, TASK-076', 1),
            'TASK-070: absent from release dependency closure')

    def test_required_edge(self):
        self.assert_detected('docs/tasks/wave-4.md', lambda s: s.replace(
            'TASK-025, TASK-002, TASK-032, TASK-049', 'TASK-025, TASK-002, TASK-032', 1),
            'missing required prerequisite TASK-049')

    def test_prose_path(self):
        self.assert_detected('docs/tasks/release-1.1.md', lambda s: s.replace(
            '- **Protected Paths:**', '- **Protected Paths:** protect secrets;', 1),
            'must contain only quoted paths')

    def test_unsafe_path(self):
        self.assert_detected('docs/tasks/release-1.1.md', lambda s: s.replace(
            '- **Protected Paths:**', '- **Protected Paths:** `../outside`,', 1),
            'unsafe Protected Paths')

    def test_protected_overlap_requires_r3(self):
        self.assert_detected('docs/tasks/release-1.1.md', lambda s: s.replace(
            '- **Risk Level:** R3', '- **Risk Level:** R2', 1),
            'touches Protected Paths so Risk Level must be R3+')

    def test_deferred_release_excluded_from_gate(self):
        self.assert_detected('docs/tasks/wave-6.md', lambda s: s.replace(
            '- **Depends On:** TASK-014, TASK-018', '- **Depends On:** TASK-062, TASK-014, TASK-018', 1),
            'TASK-062: deferred Release 1.1 task must not be in TASK-038 closure')


    def test_m1_depends_on_m2(self):
        self.assert_detected('docs/tasks/wave-5c.md', lambda s: s.replace(
            '- **Depends On:** TASK-032, TASK-087', '- **Depends On:** TASK-032, TASK-087, TASK-083', 1),
            'TASK-104: M1 task depends on M2 task TASK-083')

    def test_index_dependency_drift(self):
        self.assert_detected('TASKS.md', lambda s: s.replace(
            '- **Depends On:** TASK-023', '- **Depends On:** TASK-024', 1),
            'index Depends On differs from contract')

    def test_index_missing_task(self):
        self.assert_detected('TASKS.md', lambda s: s.replace(
            '### TASK-023:', '### TASK-923:', 1),
            'TASKS.md index and docs/tasks differ')

    def test_hot_file_budget(self):
        self.assert_detected('TASKS.md', lambda s: s + 'x' * 50_000,
                             'over the 50 KB hot-file budget')

if __name__ == '__main__':
    unittest.main()
