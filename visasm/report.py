"""Build a self-contained interactive HTML report from a BOLT CFG dump."""

from __future__ import annotations

import json
import re
import subprocess
import time
from pathlib import Path
from typing import Iterable, Optional

from .model import Function, hotness_max

_ASSETS = Path(__file__).parent / "assets"
_ALIAS_RE = re.compile(r"\(\*\d+\)$")


def strip_alias(name: str) -> str:
    return _ALIAS_RE.sub("", name)


def demangle(names: Iterable[str]) -> dict[str, str]:
    """Demangle names with llvm-cxxfilt when it is available."""
    raw = sorted({strip_alias(n) for n in names})
    result = {n: n for n in raw}
    if not raw:
        return result
    for tool in ("llvm-cxxfilt", "c++filt"):
        try:
            proc = subprocess.run(
                [tool],
                input="\n".join(raw) + "\n",
                text=True,
                capture_output=True,
                check=True,
            )
        except (OSError, subprocess.CalledProcessError):
            continue
        lines = proc.stdout.splitlines()
        if len(lines) == len(raw):
            for src, dst in zip(raw, lines):
                result[src] = dst or src
            break
    return result


def _counts(func: Function) -> tuple[Optional[int], int]:
    """Return (hottest block count, sum of block counts)."""
    values = [b.exec_count for b in func.blocks if b.exec_count is not None]
    if not values:
        return None, 0
    return max(values), sum(values)


def build_payload(
    functions: list[Function],
    binary: str,
    profile: Optional[str],
    title: Optional[str] = None,
) -> dict:
    hot_max = hotness_max(functions)
    names = {f.name for f in functions}
    demangled = demangle(names)

    out_funcs = []
    for f in functions:
        hot, flow = _counts(f)
        obj = f.to_json(hot_max)
        obj["display"] = demangled.get(strip_alias(f.name), strip_alias(f.name))
        obj["raw_name"] = strip_alias(f.name)
        obj["hot"] = hot
        obj["flow"] = flow
        out_funcs.append(obj)

    matched = sum(1 for f in functions if f.exec_count is not None and f.blocks)
    total_blocks = sum(len(f.blocks) for f in functions)
    return {
        "title": title or Path(binary).name,
        "binary": str(Path(binary).resolve()),
        "profile": str(Path(profile).resolve()) if profile else None,
        "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "hot_max": hot_max,
        "summary": {
            "functions": len(functions),
            "matched_functions": matched,
            "blocks": total_blocks,
            "hottest_block": hot_max,
        },
        "functions": out_funcs,
    }


def _read_asset(name: str) -> str:
    return (_ASSETS / name).read_text(encoding="utf-8")


def render(payload: dict) -> str:
    data = json.dumps(payload, separators=(",", ":")).replace("</", "<\\/")
    html = _read_asset("report.html")
    html = html.replace("/*__VISASM_CSS__*/", _read_asset("report.css"))
    html = html.replace("/*__VISASM_JS__*/", _read_asset("report.js"))
    html = html.replace("/*__VISASM_DATA__*/", data)
    return html


def write_report(payload: dict, output: str) -> None:
    Path(output).write_text(render(payload), encoding="utf-8")
