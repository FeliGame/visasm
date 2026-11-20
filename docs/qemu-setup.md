# 安装 QEMU 用户态环境

下面以 **Ubuntu 26.04**（也可在 WSL 2 的 Ubuntu 26.04 中运行）为例，从系统依赖开始生成首份报告。请在同一个 Bash 终端中依次执行。示例程序使用宿主架构，可在 AArch64 或 x86-64 上运行。

**1. 安装构建依赖和 LLVM 22 BOLT**

```bash
sudo apt update
sudo apt install build-essential curl git file xz-utils ninja-build pkg-config \
  python3 python3-venv libglib2.0-dev zlib1g-dev clang-22 bolt-22

export VISASM_BOLT_BIN=/usr/lib/llvm-22/bin
"$VISASM_BOLT_BIN/llvm-bolt" --version
pkg-config --modversion glib-2.0
```

如果使用其他发行版或已有 LLVM 22 构建，用实际包含 `llvm-bolt` 的目录设置 `VISASM_BOLT_BIN`。这里的 BOLT 用来生成机器 CFG。

**2. 构建并验证启用插件的 QEMU**

下面从 QEMU 10.2.1 官方发布包构建宿主架构对应的用户态模拟器。已有 QEMU 时，如果 `-help` 列出 `-plugin`，且手头有同版本的 `qemu-plugin.h`，可直接将 `QEMU_BIN` 和 `QEMU_INCLUDE` 指向它们，从第 3 步继续。

```bash
QEMU_VERSION=10.2.1
QEMU_SRC="$HOME/qemu-$QEMU_VERSION"
QEMU_ARCH="$(uname -m)"

(
  set -e
  cd "$HOME"
  curl -fLO "https://download.qemu.org/qemu-$QEMU_VERSION.tar.xz"
  tar -xf "qemu-$QEMU_VERSION.tar.xz"
  mkdir -p "$QEMU_SRC/build-user"
  cd "$QEMU_SRC/build-user"
  ../configure --target-list="$QEMU_ARCH-linux-user" \
    --enable-plugins --without-default-features --disable-docs
  ninja -j "$(nproc)" "qemu-$QEMU_ARCH"
)

export QEMU_BIN="$QEMU_SRC/build-user/qemu-$QEMU_ARCH"
export QEMU_INCLUDE="$QEMU_SRC/include/qemu"
"$QEMU_BIN" --version
"$QEMU_BIN" -help | grep -F -- '-plugin'
ls -l "$QEMU_INCLUDE/qemu-plugin.h"
```

**3. 安装 visasm，编译示例并生成报告**

如果已获取 visasm 源码，直接在项目根目录从 `python3 -m venv .venv` 开始执行。

```bash
git clone https://github.com/FeliGame/visasm.git
cd visasm
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e .

clang-22 -O2 -g -Wl,-q -o demo tests/fixtures/demo.c
file ./demo
"$QEMU_BIN" ./demo 2000
visasm trace ./demo --qemu "$QEMU_BIN" --qemu-include "$QEMU_INCLUDE" \
  --function 'main|classify' -- 2000
```

在浏览器打开 `visasm-output/trace/demo/report.html`。在 **Overview** 查看两次运行的耗时，点击 **Timeline** 查看 BB 执行时序。

**跨架构运行**时，用 `file ./目标程序` 确认 ELF 架构，把第 2 步的 `QEMU_ARCH` 设为相应的 `aarch64` 或 `x86_64`。BOLT 也需支持该 ELF 架构。对动态链接的程序，在运行前将 `QEMU_LD_PREFIX` 设为目标架构的 sysroot。例如在 Ubuntu x86-64 上运行动态链接的 AArch64 ELF，可安装交叉 libc，并将目标程序用到的其他 ARM64 共享库放入同一 sysroot。

```bash
sudo apt install libc6-arm64-cross
export QEMU_LD_PREFIX=/usr/aarch64-linux-gnu
ls -l "$QEMU_LD_PREFIX/lib/ld-linux-aarch64.so.1"
```

[返回 visasm 用法](../README.md)
