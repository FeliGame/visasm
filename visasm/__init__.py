"""visasm - basic-block level runtime profiling and visualization.

The runtime data is produced by BOLT's machine-code instrumentation (LLVM 22),
so every count in the report corresponds to a basic block of the final
machine code, not to a mid-end IR block.
"""

__version__ = "0.1.0"
