#!/usr/bin/env python3
"""EZNess 一键打包（Windows x64）。

    python build.py              完整流程：隐私检查 → 前端构建 → 安装包 + 免安装压缩包 → 产物审计
    python build.py --skip-build 跳过前端构建（dist 已经是新的）
    python build.py --no-clean   保留 output/ 里的旧产物
    python build.py --smoke      打完后在干净数据目录里启动一次，确认能起来

产物都在 output/：
    EZNess-Setup-<版本>.exe      安装包（按用户安装，可改目录，自带卸载）
    EZNess-<版本>-x64.zip        免安装压缩包，解压即用

只会用 Python 标准库；electron-builder 装在 .packaging-tools/ 里，
不往项目 node_modules 里塞构建工具。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

if hasattr(sys.stdout, "reconfigure") and not sys.stdout.isatty():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "output"
TOOLS = ROOT / ".packaging-tools"
UNPACKED = OUTPUT / "win-unpacked"
APP_NAME = "EZNess"
EB_VERSION = "26.18.0"

TEXT_SUFFIXES = {
    ".js", ".cjs", ".mjs", ".jsx", ".ts", ".tsx", ".json", ".py",
    ".html", ".css", ".md", ".mts", ".yml", ".yaml", ".txt", ".nsh",
}

# 个人数据的痕迹。源码里出现 = 打包会带出去；产物里出现 = 有东西漏进去了。
# 这里不写死本机的用户名或数据目录：用运行时拿到的用户主目录和项目路径当黑名单，
# 换一台机器打包也能查同一类东西，仓库里也不会留下个人信息。
HOME_DIR = str(Path.home())
PERSONAL_TOKENS = [
    HOME_DIR,
    HOME_DIR.replace("\\", "/"),
    str(ROOT),
    ROOT.as_posix(),
]
# 兜底：Windows 用户目录下带具体用户名的路径都算本机痕迹。文档里的示例路径
#（系统盘、工具盘之类）不算，所以不按「绝对盘符路径」一刀切。
PERSONAL_PATTERNS = [
    ("本机用户目录", re.compile(r"[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s\"'`)]+", re.IGNORECASE)),
]
SECRET_PATTERNS = [
    ("疑似 API Key", re.compile(r"\bsk-[A-Za-z0-9]{20,}")),
    ("疑似 Bearer Token", re.compile(r"Bearer\s+[A-Za-z0-9._\-]{20,}")),
]

# 这些名字只属于用户数据目录，绝不该出现在安装包里。
FORBIDDEN_NAMES = {
    "system-config.json", "settings.json", "usage.json", "kb-config.json",
    "warehouse-config.json", "model-prices.json", "ezrag", "ezstorge",
    "eznessdata", "voice-models", "prompts.json", "prompt-seeds.json",
}
# 曾经的出厂提示词模板 id。现在一个模板都不随包分发，装完提示词页必须是空的；
# 这几个 id 留着当哨兵，谁再把模板编回产物就会被拦住。
PROMPT_IDS = [
    "prompt-meeting-notes", "prompt-code-review", "prompt-requirement-breakdown",
    "prompt-structured-intake", "prompt-sql-tuning",
]
FORBIDDEN_SUFFIXES = (".jsonl",)

# 装完必须存在：程序文件、原生依赖和随包分发的法律文件。
REQUIRED_PATHS = [
    "EZNess.exe",
    "resources/app/package.json",
    "resources/app/LICENSE",
    "resources/app/THIRD_PARTY_NOTICES.md",
    "resources/app/electron/main.js",
    "resources/app/electron/assets/icon.ico",
    "resources/app/dist/index.html",
    "resources/app/node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node",
    "resources/app/node_modules/sherpa-onnx-win-x64",
    "resources/app/node_modules/pdfmarkdown-ppocrv5-models",
    "resources/app/node_modules/@img/sharp-win32-x64",
]
# 打 Windows x64 包时不该出现的东西：别的平台二进制、开发依赖。
FORBIDDEN_PATHS = [
    "resources/app/node_modules/onnxruntime-node/bin/napi-v6/darwin",
    "resources/app/node_modules/onnxruntime-node/bin/napi-v6/linux",
    "resources/app/node_modules/onnxruntime-node/bin/napi-v6/win32/arm64",
    "resources/app/node_modules/vite",
    "resources/app/node_modules/typescript",
]


class BuildError(RuntimeError):
    pass


def say(text: str = "") -> None:
    # 控制台是老代码页（GBK）时，个别符号编不出来也不能让打包崩掉。
    try:
        print(text, flush=True)
    except UnicodeEncodeError:
        encoding = sys.stdout.encoding or "utf-8"
        print(text.encode(encoding, "replace").decode(encoding, "replace"), flush=True)


def step(text: str) -> None:
    say("")
    say(f"== {text}")


def run(cmd, cwd: Path = ROOT, env=None, check: bool = True) -> int:
    say("   $ " + " ".join(str(part) for part in cmd))
    code = subprocess.run([str(part) for part in cmd], cwd=str(cwd), env=env).returncode
    if check and code != 0:
        raise BuildError(f"命令失败（退出码 {code}）：{' '.join(str(p) for p in cmd)}")
    return code


def child_env() -> dict:
    env = os.environ.copy()
    # 这台机器的用户级环境变量会让 electron 变成普通 node。
    env.pop("ELECTRON_RUN_AS_NODE", None)
    env.setdefault("ELECTRON_MIRROR", "https://npmmirror.com/mirrors/electron/")
    env.setdefault(
        "ELECTRON_BUILDER_BINARIES_MIRROR",
        "https://npmmirror.com/mirrors/electron-builder-binaries/",
    )
    env["CSC_IDENTITY_AUTO_DISCOVERY"] = "false"
    return env


def app_version() -> str:
    return str(json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"])


# ---------------------------------------------------------------- 检查


def preflight() -> None:
    step("环境检查")
    if os.name != "nt":
        raise BuildError("这个脚本只打 Windows 包，请在 Windows 上运行。")
    for rel in ["package.json", "electron/main.js", "build/icon.ico", "LICENSE", "THIRD_PARTY_NOTICES.md"]:
        if not (ROOT / rel).exists():
            raise BuildError(f"缺少 {rel}，先运行 npm install / npm run build。")
    for tool in ["node", "npm"]:
        if not shutil.which(tool):
            raise BuildError(f"找不到 {tool}，先把 Node.js 装好并加入 PATH。")
    if not (ROOT / "node_modules").is_dir():
        raise BuildError("node_modules 不存在，先运行 npm install。")
    say(f"   项目目录：{ROOT}")
    say(f"   版本号：{app_version()}")


def privacy_scan_source() -> None:
    step("隐私检查（源码）")
    roots = [ROOT / "electron", ROOT / "src", ROOT / "build"]
    extra = [ROOT / "index.html", ROOT / "package.json", ROOT / "electron-builder.yml"]
    hits: list[str] = []

    def scan(path: Path) -> None:
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            return
        for token in PERSONAL_TOKENS:
            if token in text:
                hits.append(f"{path.relative_to(ROOT)}: 含个人路径/账号痕迹 “{token}”")
        for label, pattern in PERSONAL_PATTERNS:
            match = pattern.search(text)
            if match:
                hits.append(f"{path.relative_to(ROOT)}: 含{label} “{match.group()[:60]}”")
        for label, pattern in SECRET_PATTERNS:
            for match in pattern.finditer(text):
                hits.append(f"{path.relative_to(ROOT)}: {label} {match.group()[:8]}…")

    for base in roots:
        for path in base.rglob("*"):
            if path.is_file() and path.suffix.lower() in TEXT_SUFFIXES:
                scan(path)
    for path in extra:
        if path.is_file():
            scan(path)

    if hits:
        for hit in hits[:20]:
            say("   [X]  " + hit)
        raise BuildError(f"源码里有 {len(hits)} 处不能打包的内容，先清掉再打。")
    say("   [OK] 没有个人路径、账号或密钥痕迹")


# ---------------------------------------------------------------- 构建


def ensure_builder() -> Path:
    local = ROOT / "node_modules" / ".bin" / "electron-builder.cmd"
    if local.exists():
        return local
    tools_bin = TOOLS / "node_modules" / ".bin" / "electron-builder.cmd"
    if not tools_bin.exists():
        say("   第一次运行：把 electron-builder 装进 .packaging-tools/（不动项目依赖）")
        TOOLS.mkdir(parents=True, exist_ok=True)
        manifest = TOOLS / "package.json"
        if not manifest.exists():
            manifest.write_text(
                json.dumps({"name": "ezness-packaging-tools", "private": True}, indent=2),
                encoding="utf-8",
            )
        run(
            [shutil.which("npm"), "install", "--prefix", str(TOOLS), "--no-audit",
             "--no-fund", "--loglevel=error", f"electron-builder@{EB_VERSION}"],
            env=child_env(),
        )
    if not tools_bin.exists():
        raise BuildError("electron-builder 安装失败，检查网络或 npm 源。")
    return tools_bin


def build_renderer() -> None:
    step("前端构建（tsc + vite）")
    run([shutil.which("npm"), "run", "build"], env=child_env())
    index = ROOT / "dist" / "index.html"
    if not index.exists():
        raise BuildError("dist/index.html 没生成，vite 构建没有真正完成。")
    say(f"   [OK] dist/ 已更新（{index.stat().st_size} 字节的 index.html）")


def clean_output() -> None:
    step("清理 output/")
    if not OUTPUT.exists():
        say("   output/ 还不存在，跳过")
        return
    if OUTPUT.parent != ROOT or OUTPUT.name != "output":
        raise BuildError(f"拒绝清理意外路径：{OUTPUT}")
    shutil.rmtree(OUTPUT)
    say("   [OK] 旧的安装包和压缩包已删除")


def package_app() -> None:
    step("electron-builder 打包（nsis + zip，x64）")
    builder = ensure_builder()
    run([builder, "--win", "--x64"], env=child_env())


# ---------------------------------------------------------------- 审计


def cleanup_noise() -> None:
    """electron-builder 会顺手写几个用不上的文件，output/ 只留真产物。"""
    for pattern in ("builder-debug.yml", "*.blockmap"):
        for path in OUTPUT.glob(pattern):
            path.unlink(missing_ok=True)


def audit_package() -> None:
    step("产物审计（确认没有夹带个人数据）")
    if not UNPACKED.is_dir():
        raise BuildError("没找到 output/win-unpacked，打包没有真正完成。")

    problems: list[str] = []

    for rel in REQUIRED_PATHS:
        if not (UNPACKED / rel).exists():
            problems.append(f"缺少必需文件：{rel}")
    for rel in FORBIDDEN_PATHS:
        if (UNPACKED / rel).exists():
            problems.append(f"混进了不该打包的内容：{rel}")

    scanned = 0
    for path in UNPACKED.rglob("*"):
        rel = path.relative_to(UNPACKED).as_posix()
        name = path.name.lower()
        in_node_modules = "/node_modules/" in "/" + rel
        # 第三方包里偶尔有同名的小文件，只对数据目录名做严格判断。
        strict = name in {"eznessdata", "ezrag", "ezstorge", "voice-models", "system-config.json"}
        if strict or (not in_node_modules and (name in FORBIDDEN_NAMES or name.endswith(FORBIDDEN_SUFFIXES))):
            problems.append(f"用户数据文件被打进去了：{rel}")
            continue
        if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        # node_modules 里的第三方文案属于正常内容，只查我们自己写的部分。
        if in_node_modules:
            continue
        scanned += 1
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for token in PERSONAL_TOKENS:
            if token in text:
                problems.append(f"{rel} 含个人路径/账号痕迹 “{token}”")
        for label, pattern in PERSONAL_PATTERNS:
            match = pattern.search(text)
            if match:
                problems.append(f"{rel} 含{label} “{match.group()[:60]}”")
        for label, pattern in SECRET_PATTERNS:
            if pattern.search(text):
                problems.append(f"{rel} 含{label}")
        for prompt_id in PROMPT_IDS:
            if prompt_id in text:
                problems.append(f"{rel} 里编进了提示词模板（{prompt_id}）")

    if problems:
        for item in problems[:30]:
            say("   [X]  " + item)
        raise BuildError(f"审计发现 {len(problems)} 个问题，这版不能发布。")
    say(f"   [OK] {scanned} 个文本文件 + 全部文件名校验通过，没有个人数据和密钥")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def report() -> None:
    step("产物")
    version = app_version()
    artifacts = [
        OUTPUT / f"EZNess-Setup-{version}.exe",
        OUTPUT / f"{APP_NAME}-{version}-x64.zip",
    ]
    missing = [path.name for path in artifacts if not path.exists()]
    if missing:
        raise BuildError(f"预期产物缺失：{', '.join(missing)}")
    for path in artifacts:
        size = path.stat().st_size / (1024 * 1024)
        say(f"   {path.name:<32} {size:7.1f} MB   sha256 {sha256(path)[:16]}…")
    say("")
    say("   安装包：双击安装，装到当前用户目录，可自选路径，卸载不会删你的数据。")
    say("   压缩包：解压到任意文件夹；想连数据一起带走，就在 exe 旁边建 EznessData 文件夹。")


def free_port() -> int:
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def smoke_test() -> None:
    step("干净数据目录启动测试")
    exe = UNPACKED / "EZNess.exe"
    if not exe.exists():
        raise BuildError("没有 EZNess.exe，跳过不了也跑不了。")
    temp = Path(tempfile.mkdtemp(prefix="ezness-smoke-"))
    port = free_port()
    env = child_env()
    env["EZNESS_DATA_ROOT"] = str(temp / "data")
    say(f"   临时数据目录：{env['EZNESS_DATA_ROOT']}")
    proc = subprocess.Popen(
        [str(exe), f"--user-data-dir={temp / 'userdata'}", f"--remote-debugging-port={port}"],
        cwd=str(UNPACKED),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    deadline = time.time() + 45
    page_url = ""
    try:
        import json as jsonlib
        import urllib.request

        while time.time() < deadline:
            if proc.poll() is not None:
                output = (proc.stdout.read() or b"").decode("utf-8", "replace")
                raise BuildError(f"启动后立刻退出（退出码 {proc.returncode}）：\n{output[-2000:]}")
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/json/list", timeout=2
                ) as response:
                    pages = jsonlib.load(response)
                urls = [str(page.get("url", "")) for page in pages if page.get("type") == "page"]
                page_url = next((url for url in urls if "dist/index.html" in url), "")
                if page_url:
                    break
            except Exception:
                pass
            time.sleep(1)
        if not page_url:
            raise BuildError("窗口起来了但界面没加载出来（找不到 dist/index.html 页面）")
        say("   [OK] 界面已从 dist/index.html 加载")
        time.sleep(5)
        if proc.poll() is not None:
            raise BuildError(f"运行几秒后退出（退出码 {proc.returncode}）")
        say("   [OK] 进程稳定，没有崩溃")
    finally:
        if proc.poll() is None:
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        shutil.rmtree(temp, ignore_errors=True)


def main() -> int:
    args = set(sys.argv[1:])
    say("EZNess 打包")
    try:
        preflight()
        privacy_scan_source()
        if "--skip-build" not in args:
            build_renderer()
        else:
            say("")
            say("== 前端构建：按 --skip-build 跳过")
            if not (ROOT / "dist" / "index.html").exists():
                raise BuildError("dist/index.html 不存在，去掉 --skip-build 重新构建。")
        if "--no-clean" not in args:
            clean_output()
        package_app()
        cleanup_noise()
        audit_package()
        report()
        if "--smoke" in args:
            smoke_test()
    except BuildError as error:
        say("")
        say(f"打包失败：{error}")
        return 1
    say("")
    say("完成。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
