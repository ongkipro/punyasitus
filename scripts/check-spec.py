#!/usr/bin/env python3
"""Validate this standalone planning pack; never claim runtime correctness."""

import re
import sys
from pathlib import Path


def check(root):
    errors = []
    ignored_dirs = {'node_modules', '.git', '.astro', '.wrangler', 'dist', '.delivery'}
    markdown = sorted(
        p for p in root.rglob('*.md')
        if not (set(p.relative_to(root).parts) & ignored_dirs)
        and 'archive' not in p.relative_to(root).parts[:2]
    )  # docs/archive is frozen, non-authoritative
    texts = {path: path.read_text(encoding='utf-8') for path in markdown}
    prd = texts.get(root / 'PRD.md', '')
    index = texts.get(root / 'TASKS.md', '')
    # DEC-048: TASKS.md is the queue index; full contracts live in docs/tasks/*.md.
    contract_files = sorted((root / 'docs' / 'tasks').glob('*.md'))
    queue = '\n'.join(texts.get(path, '') for path in contract_files)
    for path in [root / 'TASKS.md', *contract_files]:
        if len(texts.get(path, '').encode('utf-8')) > 50_000:
            errors.append(f'{path.name}: over the 50 KB hot-file budget')
    records = dict(re.findall(r'^### (TASK-\d{3}):[^\n]*\n(.*?)(?=^### |^\*\*|^## |\Z)', index, re.M | re.S))
    declarations = re.findall(r'^- \*\*(REQ-\d{3})\*\*', prd, re.M)
    requirements = set(declarations)
    if len(requirements) != len(declarations):
        errors.append('Duplicate requirement declarations')
    blocks = re.findall(r'^### (TASK-\d{3}):[^\n]*\n(.*?)(?=^### TASK-|\Z)', queue, re.M | re.S)
    tasks = dict(blocks)
    if len(tasks) != len(blocks):
        errors.append('Duplicate task declarations')
    if not requirements or not tasks:
        errors.append('Missing requirement or task declarations')
    covered = set()
    graph = {}
    fields = ['Requirement', 'Constraints', 'Risk Level', 'Allowed Paths',
              'Protected Paths', 'Canonical Contract Owners', 'Accepted Invariants',
              'Depends On', 'Verification', 'Visual Contract', 'Reopen Conditions',
              'Rollback/Migration State', 'Non-Scope', 'Escalation Conditions']
    for task, body in tasks.items():
        values = {}
        for field in fields:
            matches = re.findall(r'^- \*\*' + re.escape(field) + r':\*\* (.+)$', body, re.M)
            if len(matches) != 1:
                errors.append(f'{task}: expected one nonempty {field}')
            values[field] = matches[0] if matches else ''
        if not re.fullmatch(r'REQ-\d{3}', values['Requirement']):
            errors.append(f'{task}: expected exactly one primary requirement')
        refs = set(re.findall(r'REQ-\d{3}', values['Requirement'] + ' ' + values['Constraints']))
        covered.update(refs)
        for ref in refs - requirements:
            errors.append(f'{task}: unknown requirement {ref}')
        graph[task] = re.findall(r'TASK-\d{3}', values['Depends On'])
        allowed_paths = re.findall(r'`([^`]+)`', values['Allowed Paths'])
        protected_paths = re.findall(r'`([^`]+)`', values['Protected Paths'])
        for field, paths in (('Allowed Paths', allowed_paths), ('Protected Paths', protected_paths)):
            if not paths or re.sub(r'`[^`]+`|[,\s]', '', values[field]):
                errors.append(f'{task}: {field} must contain only quoted paths')
            if any(path.startswith(('/', '~')) or '..' in path.split('/')
                   or re.search(r'\s', path) for path in paths):
                errors.append(f'{task}: unsafe {field}')
        protected_roots = [p.removesuffix('/**') for p in protected_paths if not p.startswith(('.env', '**/.env'))]
        if any(a == r or a.startswith(r + '/') for a in allowed_paths for r in protected_roots):
            if values['Risk Level'].strip() not in ('R3', 'R4'):
                errors.append(f'{task}: touches Protected Paths so Risk Level must be R3+')
        for dep in graph[task]:
            if dep not in tasks:
                errors.append(f'{task}: unknown dependency {dep}')
        if 'Done when' not in values['Verification'] or '`pnpm ' not in values['Verification']:
            errors.append(f'{task}: missing executable completion contract')
    if set(records) != set(tasks):
        errors.append(f'TASKS.md index and docs/tasks differ: {sorted(set(records) ^ set(tasks))}')
    for task, body in records.items():
        if task not in tasks:
            continue
        requirement = re.search(r'^- \*\*Requirement:\*\* (REQ-\d{3})', body, re.M)
        depends = re.search(r'^- \*\*Depends On:\*\* (.+)$', body, re.M)
        link = re.search(r'\]\((docs/tasks/[^)]+\.md)\)', body)
        contract_req = re.search(r'^- \*\*Requirement:\*\* (.+)$', tasks[task], re.M)
        if not requirement or not contract_req or requirement.group(1) != contract_req.group(1).strip():
            errors.append(f'{task}: index Requirement differs from contract')
        if not depends or sorted(re.findall(r'TASK-\d{3}', depends.group(1))) != sorted(graph.get(task, [])):
            errors.append(f'{task}: index Depends On differs from contract')
        if not link or not re.search(r'^### ' + task + ':', texts.get(root / link.group(1), ''), re.M):
            errors.append(f'{task}: index link does not point at its contract file')
    for requirement in requirements - covered:
        errors.append(f'{requirement}: no primary/constraint task coverage')
    visited, active = set(), set()

    def visit(task):
        if task in active:
            errors.append(f'Dependency cycle at {task}')
            return
        if task in visited:
            return
        active.add(task)
        for dep in graph.get(task, []):
            visit(dep)
        active.remove(task)
        visited.add(task)

    for task in graph:
        visit(task)
    # These edges encode audited security/design prerequisites, not task ordering.
    required_edges = {
        'TASK-003': {'TASK-025', 'TASK-026', 'TASK-028'},
        'TASK-025': {'TASK-032'},
        'TASK-026': {'TASK-049'},
        'TASK-034': {'TASK-050'},
        'TASK-048': {'TASK-049'},
        'TASK-015': {'TASK-051'},
        'TASK-016': {'TASK-051'},
        'TASK-017': {'TASK-051'},
        'TASK-056': {'TASK-055', 'TASK-059'},
        'TASK-057': {'TASK-032', 'TASK-056', 'TASK-059'},
        'TASK-058': {'TASK-025', 'TASK-026', 'TASK-059'},
        'TASK-059': {'TASK-002', 'TASK-025', 'TASK-055'},
    }
    for task, prerequisites in required_edges.items():
        for prerequisite in prerequisites - set(graph.get(task, [])):
            errors.append(f'{task}: missing required prerequisite {prerequisite}')
    reachable = set()
    pending = ['TASK-038']
    while pending:
        task = pending.pop()
        if task not in reachable:
            reachable.add(task)
            pending.extend(graph.get(task, []))
    deferred = {
        t for t, b in tasks.items()
        if re.search(r'^- \*\*Milestone:\*\* Release 1\.1\b', b, re.M)
    }
    for task in (tasks.keys() - deferred) - reachable:
        errors.append(f'{task}: absent from release dependency closure')
    for task in deferred & reachable:
        errors.append(f'{task}: deferred Release 1.1 task must not be in TASK-038 closure')
    milestones = {t: (re.search(r'^- \*\*Milestone:\*\* (M1|M2)', b, re.M) or [None, None])[1] for t, b in tasks.items()}
    for task, deps in graph.items():
        if milestones.get(task) == 'M1':
            for dep in deps:
                if milestones.get(dep) == 'M2':
                    errors.append(f'{task}: M1 task depends on M2 task {dep}')
    for path, text in texts.items():
        if len(re.findall(r'^```', text, re.M)) % 2:
            errors.append(f'{path.name}: unbalanced code fences')
        for target in re.findall(r'(?<!!)\[[^\]]+\]\(([^)]+)\)', text):
            if re.match(r'^[a-z]+://', target) or target.startswith('#'):
                continue
            destination = target.split('#', 1)[0]
            if destination and not (path.parent / destination).exists():
                errors.append(f'{path.name}: broken link {target}')
    return errors, len(requirements), len(tasks), len(markdown)


if __name__ == '__main__':
    root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
    errors, requirements, tasks, documents = check(root)
    for error in errors:
        print('ERROR:', error)
    print(f'{requirements} requirements; {tasks} tasks; {documents} Markdown files; {len(errors)} structural errors')
    print('Scope: structure and traceability only; application/provider behavior is not tested.')
    raise SystemExit(bool(errors))
