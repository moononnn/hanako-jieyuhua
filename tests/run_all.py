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
    # 绝不生成 .pyc：火绒会把 zhujian_app 的字节码缓存误报成
    # Trojan/Python.ShellLoader，弹拦截、删文件、污染上传包。
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    result = subprocess.run(
        [sys.executable, "-m", "unittest", str(test_file)],
        cwd=ROOT,
        env=env,
    )
    if result.returncode != 0:
        raise SystemExit(result.returncode)

print(f"\n全量 Python 测试通过：{len(TESTS)} 个测试文件", flush=True)

# 收口自查：不管环境变量有没有生效，插件目录里都不该留下字节码缓存。
# 火绒把 app 模块的 .pyc 误报成 Trojan/Python.ShellLoader，会直接删文件并弹拦截
# （2026-09-30 由隔离区记录定案）；这里主动报出来，别等安全软件来删。
SKIP_DIRS = {"_backups", "node_modules", ".git"}
stray = [
    p for p in ROOT.rglob("*.pyc")
    if not SKIP_DIRS.intersection(p.parts)
]
if stray:
    print("\n[！] 发现残留字节码缓存，火绒可能随后拦截并删除：", flush=True)
    for p in stray:
        print(f"    {p}", flush=True)
    print("    处理：删掉这些 __pycache__ 目录，并确认 PYTHONDONTWRITEBYTECODE=1 已生效。", flush=True)
    raise SystemExit(1)
print("字节码缓存自查通过：无 .pyc 残留", flush=True)
