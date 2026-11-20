# visasm

基于 LLVM 22 BOLT 的**机器码基本块（BB）级**运行时分析与可视化工具。

visasm 不修改 LLVM 前端/中端，也不在 IR 上插桩。它复用 BOLT 的机器码级 instrumentation
统计每个**汇编基本块**的执行次数，再借助 BOLT 自身的反汇编与 profile 匹配能力生成机器
CFG，最后输出一个可交互的单文件 HTML 报告（热力 CFG + 汇编 + 源码行）。

## 工作原理

```
目标 ELF 二进制
   │  llvm-bolt -instrument          # MC 层为每个 BB 插入计数器
   ▼
插桩后的二进制 ──运行──▶ prof.fdata   # BOLT runtime 退出时写出
   │
   │  llvm-bolt --data=prof.fdata --print-cfg --print-debug-info
   ▼
包含每 BB 执行次数/边计数/反汇编/DWARF 行号的 CFG 转储
   │  visasm 解析 + 布局渲染
   ▼
report.html（自包含，可直接分享）
```

关键点：计数与 CFG 都来自 BOLT 对最终机器码的处理，因此报告中每个节点就是一条汇编
基本块，而不是中端 IR 基本块。

## 环境要求

- Python 3.9+
- LLVM 22 的 `llvm-bolt`，且构建时启用 instrument runtime
  （需要 `libbolt_rt_instr.a`，visasm 会自动在 llvm-bolt 同级的
  `lib/` 或 `bolt_rt-bins/lib/` 下查找）
- 目标程序为未 strip 的 ELF，并保留重定位信息（例如 `clang -O2 -g -Wl,-q`）

`llvm-bolt` 不在 PATH 时，可用 `--llvm-bin <目录>` 指定，或设置环境变量
`VISASM_LLVM_BIN=<目录>`。

如果本机的 LLVM 22 构建没有 BOLT，可单独构建（以 aarch64 为例）：

```bash
cmake -S ~/llvm-project-22.1.8/bolt -B ~/bolt-build -G Ninja \
  -DLLVM_DIR=~/llvm-project-22.1.8/build/lib/cmake/llvm \
  -DCMAKE_BUILD_TYPE=Release \
  -DBOLT_TARGETS_TO_BUILD=AArch64 \
  -DBOLT_ENABLE_RUNTIME=ON
ninja -C ~/bolt-build llvm-bolt
```

## 安装

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -e .
visasm --version
```

也可以不安装，直接 `python3 -m visasm.cli ...`。

## 快速开始

```bash
# 编译一个带重定位信息的程序
clang -O2 -g -Wl,-q -o demo demo.c

# 一条命令完成：插桩 -> 运行 -> 生成报告
visasm profile ./demo -o report.html --json model.json -- 100000
```

打开 `report.html` 即可查看。

## 命令参考

### `visasm instrument`

在机器码层插入每基本块计数器。

```bash
visasm instrument <binary> [-o OUT] [--profile FDATA] [--bolt-opt OPT]...
```

| 选项 | 说明 |
| --- | --- |
| `-o, --output` | 插桩后二进制，默认 `<binary>.inst` |
| `--profile` | 运行后 profile 写出路径，默认 `<output>.fdata` |
| `--bolt-opt` | 追加传给 llvm-bolt 的参数，可重复 |

### `visasm run`

运行插桩后的二进制并检查 profile 是否生成。

```bash
visasm run <instrumented> [--profile FDATA] -- <程序参数...>
```

### `visasm report`

对已有 profile 生成报告（无需重新运行程序）。

```bash
visasm report <binary> --data FDATA [-o report.html] [--json model.json]
                [--func 正则] [--no-source]
```

| 选项 | 说明 |
| --- | --- |
| `--data` | 插桩运行产生的 fdata；省略则所有计数为 unknown |
| `-o, --output` | HTML 输出，默认 `<binary>.visasm.html`（当前目录） |
| `--json` | 同时导出解析后的结构化模型 |
| `--func` | 只输出匹配的符号（传给 BOLT `--print-only`） |
| `--no-source` | 不读取 DWARF 行号，可显著加快大二进制处理 |

### `visasm profile`

`instrument + run + report` 的组合命令。

```bash
visasm profile <binary> [-o report.html] [--json model.json]
                [--workdir DIR] [--profile FDATA] [--func 正则]
                [--no-source] [--bolt-opt OPT]... -- <程序参数...>
```

所有子命令都支持 `--llvm-bin <目录>` 与 `-v/--verbose`。

## 测试

```bash
.venv/bin/python -m pip install pytest
.venv/bin/python -m pytest -q
```

端到端测试会用 `clang` 编译 `tests/fixtures/demo.c`，执行完整
`instrument -> run -> report` 流程；缺少 LLVM/BOLT 时自动跳过。
可用 `VISASM_CLANG` 指定编译器。

## 目录结构

```
visasm/
  cli.py          # 命令行入口与子命令
  bolt.py         # llvm-bolt 调用封装
  model.py        # --print-cfg 解析器与数据模型
  report.py       # HTML 报告生成
  assets/         # 报告模板、样式、交互脚本
tests/
  test_parser.py  # 解析器单元测试
  test_e2e.py     # 完整流水线测试
```

## 已知限制

- 仅面向 ELF 平台（当前在 Linux/aarch64 验证，BOLT 支持 x86-64）。
- 每次运行会覆盖 profile 文件，暂不支持多次运行合并。
- 调用图只包含 BOLT 能解析的直接调用/尾调用；间接调用（函数指针、虚调用）不产生边。
- 报告将反汇编与模型内嵌在单个 HTML 中，二进制很大时文件会相应变大；
  可用 `--func` 或 `--no-source` 控制体积与耗时。
