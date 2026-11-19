"""Thin wrapper around the LLVM 22 BOLT tools.

visasm does not re-implement binary decoding or profile matching: it drives
``llvm-bolt`` so that the machine CFG and the per-basic-block counters come
from BOLT itself.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


class BoltError(RuntimeError):
    pass


def _env() -> dict[str, str]:
    """Return an environment where LLVM shared libraries resolve correctly.

    Some IDE shells inject their own (older) libstdc++ into LD_LIBRARY_PATH,
    which breaks LLVM binaries.  Drop it unless the user overrides it.
    """
    env = dict(os.environ)
    if "VISASM_KEEP_LD_LIBRARY_PATH" not in env:
        env.pop("LD_LIBRARY_PATH", None)
    return env


def find_tool(name: str, llvm_bin: Optional[str] = None) -> str:
    candidates = []
    if llvm_bin:
        candidates.append(Path(llvm_bin) / name)
    if os.environ.get("VISASM_LLVM_BIN"):
        candidates.append(Path(os.environ["VISASM_LLVM_BIN"]) / name)
    found = shutil.which(name)
    if found:
        candidates.append(Path(found))
    # Development fallback: the build used while creating visasm.
    candidates.append(Path("/home/feli/bolt-build/bin") / name)

    for cand in candidates:
        if cand.is_file() and os.access(cand, os.X_OK):
            return str(cand)
    raise BoltError(
        f"cannot find {name}; pass --llvm-bin <dir> or set VISASM_LLVM_BIN"
    )


@dataclass
class Bolt:
    llvm_bin: Optional[str] = None
    verbose: bool = False

    def __post_init__(self) -> None:
        self.bolt = find_tool("llvm-bolt", self.llvm_bin)
        self.runtime_lib = self._find_runtime_lib()

    def _find_runtime_lib(self) -> Optional[str]:
        tool = Path(self.bolt).resolve()
        roots = [tool.parent.parent, tool.parent.parent.parent]
        for root in roots:
            for rel in ("lib", "bolt_rt-bins/lib"):
                cand = root / rel / "libbolt_rt_instr.a"
                if cand.is_file():
                    return str(cand)
        return None

    def _run(self, argv: list[str], **kwargs) -> subprocess.CompletedProcess:
        if self.verbose:
            print("+ " + " ".join(argv))
        try:
            return subprocess.run(
                argv, env=_env(), check=True, text=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs
            )
        except subprocess.CalledProcessError as exc:
            raise BoltError(
                f"command failed ({exc.returncode}): {' '.join(argv)}\n"
                f"{exc.stderr[-4000:]}"
            ) from exc

    # -- pipeline steps ----------------------------------------------------

    def instrument(
        self,
        binary: str,
        output: str,
        profile: str,
        extra_opts: Optional[list[str]] = None,
    ) -> None:
        """Insert per-basic-block counters at the machine-code level."""
        output = os.path.abspath(output)
        profile = os.path.abspath(profile)
        argv = [
            self.bolt,
            binary,
            "-o",
            output,
            "-instrument",
            f"-instrumentation-file={profile}",
            f"-instrumentation-binpath={output}",
            "--instrument-calls",
        ]
        if self.runtime_lib:
            argv.append(f"-runtime-instrumentation-lib={self.runtime_lib}")
        if extra_opts:
            argv.extend(extra_opts)
        self._run(argv)
        if not Path(output).exists():
            raise BoltError(f"llvm-bolt did not produce {output}")

    def dump_cfg(
        self,
        binary: str,
        profile: Optional[str] = None,
        only: Optional[str] = None,
        debug_info: bool = True,
    ) -> str:
        """Return the machine CFG dump with execution counts attached."""
        argv = [self.bolt, binary, "-o", "/dev/null", "--print-cfg"]
        if debug_info:
            # BOLT only loads DWARF units (and therefore can annotate
            # instruction addresses with file:line) when asked to update them.
            argv.extend(["--print-debug-info", "--update-debug-sections"])
        if profile:
            argv.append(f"--data={profile}")
        if only:
            argv.append(f"--print-only={only}")
        proc = self._run(argv)
        return proc.stdout

def run_instrumented(binary: str, args: list[str], cwd: Optional[str] = None) -> None:
    try:
        subprocess.run([os.path.abspath(binary), *args], cwd=cwd, env=_env(), check=True)
    except subprocess.CalledProcessError as exc:
        raise BoltError(f"instrumented program exited with {exc.returncode}") from exc
