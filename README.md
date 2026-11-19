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

## 报告说明

- **Overview**：所有函数的入口次数、最热 BB、块执行次数之和、BB 数、profile 匹配率。
  点击表头可排序。
- **Function**：左侧函数列表按最热 BB 排序，支持正则过滤；主区域为分层布局的机器 CFG：
  - 节点颜色按执行次数对数映射（冷 = 浅灰/浅蓝，热 = 橙色/红色）；
  - 边宽度与颜色反映边计数，虚线表示回边；
  - 拖动平移、滚轮缩放、`fit` 复位；
  - 点击 BB 在右侧查看反汇编、前驱/后继及 DWARF 源文件行号。
- 键盘 `←` / `→` 切换函数。

## JSON 模型

`--json` 导出的结构（简化）：

```json
{
  "summary": {"functions": 11, "matched_functions": 11, "blocks": 36},
  "hot_max": 2500,
  "functions": [{
    "raw_name": "main",
    "display": "main",
    "address": 2104,
    "exec_count": 1,
    "profile_acc": 100.0,
    "hot": 2500,
    "blocks": [{
      "name": ".Ltmp10",
      "addr": 2144,
      "count": 2500,
      "succs": [{"target": ".Ltmp8", "count": 1250, "mispreds": 0}],
      "insts": [{"addr": 2144, "text": "add x21, x21, #0x1", "debug": "demo.c:24"}]
    }]
  }]
}
```

## 常见问题

**`BOLT-ERROR: stripped binaries are not supported`**

目标程序被 strip。请保留符号，或在明确接受限制时追加
`--bolt-opt=--allow-stripped`（`instrument` / `profile` 子命令）。

**`BOLT-ERROR: ... requires relocations` / 没有生成 profile**

请使用 `-Wl,-q`（`--emit-relocs`）重新链接。静态链接程序还需要在插桩时加
`--bolt-opt=-instrumentation-sleep-time=2`，让 runtime 有机会捕获退出。

**`cannot find llvm-bolt`**

通过 `--llvm-bin` 指向包含 `llvm-bolt` 的目录，或设置 `VISASM_LLVM_BIN`。

**找不到 `llvm-cxxfilt`**

C++ 名称会退回显示 mangled 名；安装 `llvm-cxxfilt`（或 `c++filt`）即可自动 demangle。

**运行 LLVM 工具时报 libstdc++ / GLIBCXX 错误**

某些环境会注入旧的 `LD_LIBRARY_PATH`。visasm 默认在调用 LLVM/BOLT 前清除它；
如确需保留，设置 `VISASM_KEEP_LD_LIBRARY_PATH=1`。

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
- 报告将反汇编与模型内嵌在单个 HTML 中，二进制很大时文件会相应变大；
  可用 `--func` 或 `--no-source` 控制体积与耗时。
