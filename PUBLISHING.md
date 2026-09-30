# 解语花发布契约

> 这是本项目的发布事实源。准备 push、tag、打安装包或创建 GitHub Release 前，先读完本文件；不要根据别的插件或旧版本的目录结构猜流程。

## 1. 固定信息

- GitHub 仓库：`moononnn/hanako-jieyuhua`
- 外传白名单：产品名「解语花」、平台名「Hana / HanaAgent」、公开 owner `moononnn`、署名 `moononnn & 小花`；唯一允许对外出现的伙伴名称为「小花」；公开仓库地址为 `https://github.com/moononnn/hanako-jieyuhua`。其他私人姓名、伙伴名称、真实邮箱和本机路径均不得外传。
- 默认分支：`main`
- 版本唯一来源：`manifest.json` 的 `version`
- Git tag：`v<manifest.version>`
- CI：`.github/workflows/ci.yml`，push 到 `main` 后触发
- Release 标题：`vX.Y.Z —<一句话概括本版主要内容>`
- Release 附件：`jiegehua-vX.Y.Z.zip`
- 当前仓库无 `package.json`，JavaScript 只使用 Node 内置模块和项目内相对 import；Python 悬浮球依赖用户环境中的 PyQt6。

## 2. 版本与发布档位

- 每个完成的用户可感知修复/功能：`PENDING_CHANGES.md` 记一条，`manifest.json` patch +1。
- 真正发布时：把有效账本内容并入 `CHANGELOG.md`，再清空 `PENDING_CHANGES.md`，保留文件头。
- 小改动只 push + tag，不创建 Release；功能级更新、用户等着的修复和交互流程变化走完整 Release。
- 本项目发布前必须保留上一版 tag 和 Release，不覆盖、不复用版本号。

## 3. 干净安装包的明确范围

发布包只从已提交 HEAD 按以下白名单生成，不直接复制正式插件目录：

### 必须包含

- 根文件：`manifest.json`、`index.js`、`README.md`、`LICENSE`、`NOTICE`、`COMMERCIAL-LICENSE.md`、`CHANGELOG.md`
- 目录：`assets/`、`extensions/`、`lib/`、`python/`、`routes/`、`skills/`、`tools/`

### 必须排除

- `.git/`、`.github/`
- `tests/`、`TESTING.md`
- `PENDING_CHANGES.md`、`PROJECT_LOG.md`
- `.gitignore`、施工方案、交接文档和其他本地开发资料
- `data.json`、`preferences.json`、`*.log`、`node_modules/`
- `_backups/`、`__pycache__/`、`*.pyc`、`.bak`、临时文件
- 任何用户数据、凭据、运行时状态和本地测试入口

### 打包约束

- 暂存目录放在工作台的临时目录，不能放插件目录，也不能把 C 盘当产物目录。
- 用 `git ls-files` 配合上面的白名单复制，防止 ignored 文件混入。
- 用 .NET `System.IO.Compression.ZipFile` 创建 zip；不要使用 `Compress-Archive`，也不要用 tar 直接作为最终安装包。
- zip 根部直接是插件文件，不允许 `./` 前缀或额外的父目录层级。
- `PUBLISHING.md` 是开发契约，不进入安装包。

## 4. 固定验证命令

在准备提交前，先在正式目录运行：

```powershell
node --test --test-concurrency=1 tests/*.test.js
python tests/run_all.py
node <plugin-dev-guide>/scripts/check-file-budget.js
```

本仓库的文件预算脚本位于插件开发 skill；若项目目录没有 `scripts/check-file-budget.js`，使用已安装 skill 中的脚本路径。

Windows 上运行 Python 测试前设置 `PYTHONDONTWRITEBYTECODE=1`；语法检查用下面的内存编译，不运行会写入 `__pycache__` 的 `py_compile`。

还要运行：

```powershell
node --check lib/data.js
node --check lib/zhujian.js
node --check routes/api.js
node --check routes/ui.js
node --check tests/ask-flower.test.js
python -c "from pathlib import Path; compile(Path('python/zhujian_app.py').read_text(encoding='utf-8'), 'python/zhujian_app.py', 'exec')"
git diff --check
```

外传红线检查必须覆盖待提交内容和 Release 正文：不得出现私人姓名、其他助手姓名或真实邮箱；不把本地测试入口、用户数据和凭据带进包。

## 5. 固定发布顺序

只在用户明确同意上传后执行完整链路：

1. 读本文件、`PENDING_CHANGES.md`、`CHANGELOG.md` 和用户确认过的 Release 正文。
2. 核对 `manifest.json`、CHANGELOG 新小节、tag 和 Release 标题都使用同一个完整版本号。
3. 按逻辑边界提交：功能/测试一笔，发布文案/记录一笔；提交邮箱必须是 GitHub noreply。
4. `git push origin main`。
5. 用 `gh run list` 找到本次 HEAD 对应的 CI，再用 `gh run watch <run-id> --exit-status` 等到成功；失败就停下修复。
6. CI 成功后创建并推送 tag：

```powershell
git tag -a vX.Y.Z -m "vX.Y.Z — 一句话概括本版主要内容"
git push origin vX.Y.Z
```

7. 在工作台新建带版本号的发布暂存目录，按第 3 节白名单生成包；在解压后的最终包上运行 Node/Python 验证。
8. 对暂存目录和解压目录运行 `compare-release-tree.mjs`，必须得到 `Release tree identity: MATCH`。
9. 派一个只读审查伙伴独立复核 zip 内容、manifest 路径、依赖、全新安装和旧数据兼容；有阻塞项就停下。
10. 计算 zip SHA-256，把 hash 写入 Release 正文，然后创建 Release：

```powershell
gh release create vX.Y.Z `
  "<工作台临时目录>\jiegehua-vX.Y.Z.zip" `
  --repo moononnn/hanako-jieyuhua `
  --verify-tag `
  --title "vX.Y.Z — 一句话概括本版主要内容" `
  --notes-file "<Release 正文文件>"
```

11. 下载远端附件重新计算 SHA-256，必须与本地一致；核对 Release 为正式发布状态且只有一个正确附件。
12. 把验证证据、Release URL、附件大小、SHA-256 和保留的审查产物写入 `PROJECT_LOG.md`；确认账本已清空。

## 6. 立即停止的条件

- CI 未完成或失败
- manifest、CHANGELOG、tag、zip、Release 标题版本不一致
- 测试、语法、文件预算或树哈希失败
- 包里出现测试、日志、用户数据、凭据、备份或临时文件
- 外传红线命中
- Release 已存在、tag 已存在但不指向当前 HEAD
- 用户没有明确同意 push / tag / 创建 Release

## 7. 最终交付必须报告

只报告已经核实的事实：

- commit、tag、CI run 和 Release URL
- zip 文件名、大小、SHA-256
- 包内容审查和安装/升级模拟结果
- 未执行的检查及原因
- 保留的审查产物路径

不要把“正在探索发布流程”当成执行过程交给用户；缺少本项目事实时，先补齐本契约，再开始下一次发布。
