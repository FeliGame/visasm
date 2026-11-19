"""End-to-end test: BOLT instrumentation -> run -> machine CFG report."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from visasm.bolt import find_tool
from visasm.cli import main

ROOT = Path(__file__).resolve().parent.parent
DEMO_C = ROOT / "tests" / "fixtures" / "demo.c"


def _tool(name: str):
    try:
        return find_tool(name)
    except Exception:
        return None


def _clang():
    for cand in (
        os.environ.get("VISASM_CLANG"),
        "/home/feli/llvm-project-22.1.8/build/bin/clang",
        shutil.which("clang"),
    ):
        if cand and Path(cand).exists():
            return cand
    return None


pytestmark = pytest.mark.skipif(
    _tool("llvm-bolt") is None or _clang() is None,
    reason="llvm-bolt (LLVM 22 BOLT build) or clang is not available",
)


@pytest.fixture(scope="module")
def demo(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("visasm-e2e")
    binary = tmp / "demo"
    env = {k: v for k, v in os.environ.items() if k != "LD_LIBRARY_PATH"}
    subprocess.run(
        [_clang(), "-O2", "-g", "-Wl,-q", "-o", str(binary), str(DEMO_C)],
        check=True,
        capture_output=True,
        env=env,
    )
    return binary, tmp


def test_profile_pipeline(demo, capsys):
    binary, tmp = demo
    report = tmp / "report.html"
    model = tmp / "model.json"

    rc = main(
        [
            "profile",
            str(binary),
            "-o",
            str(report),
            "--json",
            str(model),
            "--workdir",
            str(tmp / "work"),
            "--",
            "2000",
        ]
    )
    assert rc == 0
    assert report.exists() and report.stat().st_size > 10_000

    data = json.loads(model.read_text())
    assert data["summary"]["matched_functions"] >= 3

    funcs = {f["display"]: f for f in data["functions"]}

    def find(prefix):
        for name, fn in funcs.items():
            if name.split("/")[0] == prefix:
                return fn
        raise AssertionError(f"{prefix} not found in {sorted(funcs)}")

    main_fn = find("main")
    counts = {b["name"]: b["count"] for b in main_fn["blocks"]}
    assert main_fn["bb_count"] >= 5
    # The loop body runs once per iteration for n=2000.
    assert max(c or 0 for c in counts.values()) == 2000

    classify = find("classify")
    assert max(b["count"] or 0 for b in classify["blocks"]) > 0

    # Function-level call graph aggregated from BOLT's per-call-site counts.
    cg = data["callgraph"]
    nodes = {n["id"]: n for n in cg["nodes"]}
    edges = {(e["source"], e["target"]): e["count"] for e in cg["edges"]}
    assert cg["defined"] >= 3
    assert cg["external"] >= 1
    assert edges.get((main_fn["raw_name"], classify["raw_name"]), 0) > 0
    assert any(
        e["source"] == main_fn["raw_name"] and n["external"]
        for e in cg["edges"]
        for n in [nodes[e["target"]]]
    )

    html = report.read_text()
    assert "<svg" in html and "main" in html
    assert '"blocks"' in html  # embedded model
    assert '"callgraph"' in html
    assert "tab-callgraph" in html


def test_report_requires_binary(tmp_path):
    with pytest.raises(SystemExit):
        main(["report", str(tmp_path / "missing")])
