import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TESTS = sorted(pathlib.Path(__file__).resolve().parent.glob("test_*.py"))

for test_file in TESTS:
    print(f"\n=== {test_file.name} ===", flush=True)
    env = os.environ.copy()
    env["PYTHONPATH"] = str(test_file.parent) + os.pathsep + env.get("PYTHONPATH", "")
    result = subprocess.run(
        [sys.executable, "-m", "unittest", str(test_file)],
        cwd=ROOT,
        env=env,
    )
    if result.returncode != 0:
        raise SystemExit(result.returncode)

print(f"\n全量 Python 测试通过：{len(TESTS)} 个测试文件", flush=True)
