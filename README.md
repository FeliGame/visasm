# visasm

visasm 用 LLVM 22 BOLT 从 ELF 机器码提取基本块（BB）和控制流图（CFG），生成包含汇编和 DWARF 源码映射的交互式 HTML 报告。

| 命令 | 用途 | 额外依赖 |
| --- | --- | --- |
| `visasm profile` | 用 BOLT 统计执行次数，查看热点 CFG 和调用图 | BOLT |
| `visasm trace` | 用 QEMU 记录 BB 入口时间戳，拖动或播放执行时序 | [QEMU](docs/qemu-setup.md) |

## 公共环境

Python 3.9+
profile功能需要llvm-bolt 和保留重定位信息的原始 ELF。
trace功能需要QEMU 和 llvm-objdump。

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e .
clang -O2 -g -Wl,-q -o demo tests/fixtures/demo.c
```

## BB 热点分析

```bash
visasm profile ./demo -- 2000
```

打开 `visasm-output/profile/demo/report.html`。**Overview** 展示热点函数和 BB 执行次数，**Call graph** 展示 BOLT 解析的直接调用和尾调用。

- `--work-dir DIR` 指定插桩 ELF 和 fdata 的存放目录。默认在 `visasm-output/profile/<binary>/` 下为每次运行创建一个 `run-*` 子目录。
- `--fdata-out FILE` 指定生成的 fdata 路径，默认文件名为 `profile.fdata`。
- `--function FILTER` 通过 BOLT 的 `--print-only` 筛选报告中的函数。
- `--bolt-opt OPT` 追加 BOLT 插桩参数，可重复。以 `-` 开头的值用 `--bolt-opt=OPT` 传入。

profile 功能可以拆分为下述3步，并单独执行：BOLT 插桩、运行和报告生成，或复用已有 fdata。

```bash
visasm instrument ./demo
visasm run visasm-output/profile/demo/demo.inst \
  --expect-fdata visasm-output/profile/demo/profile.fdata -- 2000
visasm report ./demo --fdata visasm-output/profile/demo/profile.fdata
```

`instrument` 支持 `--output`、`--fdata-out` 和 `--bolt-opt`。`report` 省略 `--fdata` 时生成静态 CFG 报告。

如果已有 LLVM 22 构建，可单独构建带插桩运行库的 BOLT。以下示例使用 AArch64。

```bash
cmake -S ~/llvm-project-22.1.8/bolt -B ~/bolt-build -G Ninja \
  -DLLVM_DIR=~/llvm-project-22.1.8/build/lib/cmake/llvm \
  -DCMAKE_BUILD_TYPE=Release \
  -DBOLT_TARGETS_TO_BUILD=AArch64 \
  -DBOLT_ENABLE_RUNTIME=ON
ninja -C ~/bolt-build llvm-bolt
export VISASM_BOLT_BIN="$HOME/bolt-build/bin"
```

## BB 执行时序

首次使用请按 [QEMU 用户态环境安装教程](docs/qemu-setup.md) 配置依赖和下面的两个路径。时序采集支持 64 位 Linux 上的 AArch64 和 x86-64 ELF。

```bash
visasm trace ./demo --qemu "$QEMU_BIN" --qemu-include "$QEMU_INCLUDE" \
  --function 'main|classify' -- 2000
```

打开 `visasm-output/trace/demo/report.html`。

- `--qemu PATH` 指定启用插件的 QEMU 用户态程序。默认按目标 ELF 架构在 PATH 中查找。
- `--qemu-include DIR` 指定包含同版本 `qemu-plugin.h` 的目录。
- `--function REGEX` 仅采集 BOLT 函数名匹配的 BB。
- `--fdata FILE` 将同一 ELF 的已有 BOLT 热点计数合入时序报告。

## 通用报告选项

两条命令均支持 `-o/--output FILE` 指定 HTML 路径，`--json FILE` 另存结构化数据，`--title TITLE` 设置标题，`--no-source` 跳过 DWARF 源码映射。目标程序的参数放在 `--` 后面。完整选项见 `visasm profile --help` 和 `visasm trace --help`。

## 分步采集热点



## 源码与测试

`visasm/profile/` 放置热点分析命令，`visasm/trace/` 放置时序采集代码、QEMU 插件和时间轴界面。两者共用 BOLT CFG 解析和 HTML 报告基础组件。

```bash
python -m pip install pytest
python -m pytest -q
```

端到端测试使用 `clang` 编译示例，可通过 `VISASM_CLANG` 指定编译器。提供启用插件的 QEMU 和头文件后，测试会包含时序采集。
