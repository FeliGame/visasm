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


def build_callgraph(functions: list[Function], func_objs: list[dict]) -> dict:
    """Aggregate per-call-site counts into a function-level call graph.

    BOLT annotates every direct call with ``# Count: N`` measured at the call
    site, so edge weights are real execution counts rather than samples.
    """
    defined = {obj["raw_name"] for obj in func_objs}

    nodes: dict[str, dict] = {}
    for i, obj in enumerate(func_objs):
        nodes[obj["raw_name"]] = {
            "id": obj["raw_name"],
            "display": obj["display"],
            "hot": obj["hot"] or 0,
            "flow": obj["flow"],
            "exec_count": obj["exec_count"],
            "bb_count": obj["bb_count"],
            "external": False,
            "fn": i,
        }

    externals: dict[str, int] = {}
    edge_counts: dict[tuple[str, str], dict] = {}

    def resolve(target: str) -> tuple[str, bool]:
        if target in defined:
            return target, False
        base = target.split("@")[0]
        if base in defined:
            return base, False
        return target, True

    for f, obj in zip(functions, func_objs):
        src = obj["raw_name"]
        for block in f.blocks:
            for inst in block.instructions:
                if not inst.call_target:
                    continue
                target, is_external = resolve(inst.call_target)
                if is_external:
                    externals[target] = externals.get(target, 0) + 1
                count = inst.call_count
                if count is None:
                    count = block.exec_count or 0
                edge = edge_counts.setdefault(
                    (src, target), {"source": src, "target": target, "count": 0, "sites": 0}
                )
                edge["count"] += count
                edge["sites"] += 1

    if externals:
        ext_display = demangle(externals)
        for name, count in externals.items():
            nodes[name] = {
                "id": name,
                "display": ext_display.get(name, name),
                "hot": 0,
                "flow": 0,
                "exec_count": None,
                "bb_count": 0,
                "external": True,
                "fn": -1,
                "sites": count,
            }

    edges = sorted(edge_counts.values(), key=lambda e: e["count"], reverse=True)
    return {
        "nodes": list(nodes.values()),
        "edges": edges,
        "max_edge": max((e["count"] for e in edges), default=0),
        "defined": len(defined),
        "external": len(externals),
    }


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
    callgraph = build_callgraph(functions, out_funcs)
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
            "call_edges": len(callgraph["edges"]),
            "external_symbols": callgraph["external"],
        },
        "functions": out_funcs,
        "callgraph": callgraph,
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
