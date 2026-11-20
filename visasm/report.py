"""Build a self-contained interactive HTML report from a BOLT CFG dump."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import time
from collections import defaultdict
from pathlib import Path
from typing import Iterable, Optional

from .model import Function, hotness_max

_ASSETS = Path(__file__).parent / "assets"
_TRACE_ASSETS = Path(__file__).parent / "trace" / "assets"
_ALIAS_RE = re.compile(r"\(\*\d+\)$")
_SOURCE_RE = re.compile(r"(.+?):([1-9]\d*)(?::\d+)?$")


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


def _symbolize_sources(binary: str, addresses: Iterable[int], llvm_bin: Optional[str]) -> dict:
    tool = shutil.which("llvm-symbolizer", path=llvm_bin) if llvm_bin else None
    tool = tool or shutil.which("llvm-symbolizer")
    if tool is None:
        return {}
    try:
        result = subprocess.run(
            [tool, "--output-style=JSON", "--no-inlines", "--obj", binary],
            input="".join(f"{addr:#x}\n" for addr in addresses),
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return {}
    locations = {}
    for row in result.stdout.splitlines():
        try:
            obj = json.loads(row)
            symbol = obj["Symbol"][0]
            locations[int(obj["Address"], 16)] = (symbol["FileName"], symbol["Line"])
        except (ValueError, IndexError, KeyError, TypeError):
            continue
    return locations


def _source_mapping(payload: dict, llvm_bin: Optional[str]) -> dict:
    positions = {}
    for fn in payload["functions"]:
        for block in fn["blocks"]:
            for inst in block["insts"]:
                location = _SOURCE_RE.fullmatch(inst.get("debug") or "")
                if location:
                    positions[inst["addr"]] = (location[1], int(location[2]))
    if not positions:
        return {}

    # BOLT prints the line table's file name without its directory index.
    resolved = _symbolize_sources(payload["binary"], positions, llvm_bin)
    files = defaultdict(set)
    instruction_files = {}
    for address, (file, line) in positions.items():
        full_path, resolved_line = resolved.get(address, ("", 0))
        if resolved_line == line and Path(full_path).parts[-len(Path(file).parts):] == Path(file).parts:
            file = full_path
        files[file].add(line)
        instruction_files[address] = file

    source_files = {}
    for file, lines in files.items():
        path = Path(file)
        try:
            if path.is_file():
                with path.open(encoding="utf-8", errors="replace") as source:
                    content = [line.rstrip("\n") for line in source]
                if len(content) >= min(lines):
                    source_files[file] = content
        except (OSError, ValueError):
            continue
    return {
        "source_files": source_files,
        "instruction_files": {
            addr: file for addr, file in instruction_files.items()
            if file != positions[addr][0]
        },
    }


def render(payload: dict) -> str:
    data = json.dumps(payload, separators=(",", ":")).replace("</", "<\\/")
    html = _read_asset("report.html")
    css = _read_asset("report.css")
    script = _read_asset("report.js")
    trace = payload.get("timeline") is not None

    def trace_asset(name: str) -> str:
        return (_TRACE_ASSETS / name).read_text(encoding="utf-8") if trace else ""

    html = html.replace("<!--__VISASM_TRACE_NAV__-->", trace_asset("timeline-nav.html"))
    html = html.replace("<!--__VISASM_TIMELINE__-->", trace_asset("timeline.html"))
    html = html.replace("<!--__VISASM_TRACE_RUNTIME__-->", trace_asset("runtime.html"))
    html = html.replace("/*__VISASM_CSS__*/", css + trace_asset("timeline.css"))
    html = html.replace("/*__VISASM_JS__*/", script.replace("/*__VISASM_TRACE_JS__*/", trace_asset("timeline.js")))
    html = html.replace("/*__VISASM_DATA__*/", data)
    return html


def write_report(payload: dict, output: str, *, llvm_bin: Optional[str] = None) -> None:
    source_mapping = _source_mapping(payload, llvm_bin)
    Path(output).write_text(render({**payload, **source_mapping}), encoding="utf-8")
