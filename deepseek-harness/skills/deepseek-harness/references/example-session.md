# Worked example session

User: "连到我的 VM，把 /srv/api 作为工作区，看看测试为什么挂了"

```
1. ssh_connect { name: "dev", host: "10.0.0.8", username: "deploy", auth: "password", password: "..." }
   → connection "dev" connected, fingerprint recorded

2. workspace_open { name: "api", connection: "dev", remote_path: "/srv/api" }
   → current workspace = api, top-level listing shown

3. glob { pattern: "**/*_test.py" }           → find the test files
4. grep { pattern: "def test_", glob: "*.py", max_results: 50 }
5. run_cmd { command: "python -m pytest -x -q", timeout_seconds: 300 }
   → exit_code: 1, stderr shows assertion in tests/test_orders.py:42

6. read_file { path: "tests/test_orders.py", line_offset: 30, line_limit: 30 }
7. read_file { path: "src/orders.py" }        → locate the bug
8. edit_file { path: "src/orders.py", old_string: "...", new_string: "..." }

9. run_cmd { command: "python -m pytest -q", timeout_seconds: 300 }
   → exit_code: 0

10. download { remote_path: "reports/coverage.xml" }   → lands at /workspace/coverage.xml
```

## Guidelines shown in this example

- One tool call per step; report intermediate results briefly.
- Verify with the actual test command before claiming success.
- `edit_file` is always preceded by `read_file` of the same file.
- Use line slicing (`line_offset`/`line_limit`) on large files instead of
  dumping them whole.
