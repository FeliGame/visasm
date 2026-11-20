"""End-to-end test: BOLT instrumentation -> run -> machine CFG report."""

import json
import os
import platform
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


def test_profile_pipeline(demo, monkeypatch):
    binary, tmp = demo
    monkeypatch.chdir(tmp)
    directory = tmp / "visasm-output" / "profile" / binary.name
    report = directory / "report.html"
    model = tmp / "profile.json"

    rc = main(
        [
            "profile",
            str(binary),
            "--json",
            str(model),
            "--",
            "2000",
        ]
    )
    assert rc == 0
    assert report.exists() and report.stat().st_size > 10_000
    assert list(directory.glob("run-*/profile.fdata"))

    data = json.loads(model.read_text())
    assert data["summary"]["functions"] >= 3
    assert not {"matched_functions", "hottest_block"} & data["summary"].keys()
    assert "hot_max" not in data
    assert all(not {"hot", "profile_acc"} & fn.keys() for fn in data["functions"])

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
    assert '<div class="brand">VISASM Profile</div>' in html
    assert "Hottest BB" not in html and "Profile match" not in html
    assert '"blocks"' in html  # embedded model
    assert '"callgraph"' in html
    assert "tab-callgraph" in html
    assert "timeline-density" not in html


def test_report_requires_binary(tmp_path):
    with pytest.raises(SystemExit):
        main(["report", str(tmp_path / "missing")])


def test_assembly_includes_sections_outside_cfg_filter(demo):
    if not _tool("llvm-objdump") and not shutil.which("objdump"):
        pytest.skip("llvm-objdump or objdump is required")

    binary, tmp = demo
    report = tmp / "filtered-assembly.html"
    assert main(["report", str(binary), "--function", "main", "-o", str(report)]) == 0

    html = report.read_text(encoding="utf-8")
    embedded = html.split("const DATA = ", 1)[1].split(";\n</script>", 1)[0]
    data = json.loads(embedded)
    assert [fn["raw_name"] for fn in data["functions"]] == ["main"]
    assert "Disassembly of section .plt:" in data["assembly"]
    assert any(isinstance(row, str) and row.endswith(" <_start>:") for row in data["assembly"])


def test_trace_pipeline(demo, monkeypatch):
    machine = platform.machine()
    qemu = os.environ.get("QEMU_BIN") or shutil.which(f"qemu-{machine}")
    include = os.environ.get("QEMU_INCLUDE")
    if not qemu or not include or "-plugin" not in subprocess.check_output([qemu, "-help"], text=True):
        pytest.skip("plugin-enabled QEMU and QEMU_INCLUDE are required")

    binary, tmp = demo
    monkeypatch.chdir(tmp)
    report = tmp / "visasm-output" / "trace" / binary.name / "report.html"
    model = tmp / "trace.json"
    iterations = 40_000
    assert main([
        "trace", str(binary), "--json", str(model),
        "--qemu", qemu, "--qemu-include", include,
        "--function", "main|classify", "--", str(iterations),
    ]) == 0

    data = json.loads(model.read_text())
    trace = data["timeline"]
    assert trace["baseline_ns"] > 0
    assert trace["duration_ns"] > 0
    assert len(trace["events"]) > 100_000
    timestamps = [time for time, _, _ in trace["events"]]
    assert timestamps == sorted(timestamps)
    end = trace["thread_end_ns"][str(trace["main_thread"])]
    assert 0 <= timestamps[0] <= timestamps[-1] < end < trace["duration_ns"]
    visits = {}
    for _, probe, thread in trace["events"]:
        assert thread == trace["main_thread"]
        fn, block = trace["blocks"][probe]
        function = data["functions"][fn]
        assert function["blocks"][block]["insts"]
        name = function["raw_name"].split("/")[0]
        assert name in ("main", "classify")
        visits[(fn, block)] = visits.get((fn, block), 0) + 1
    assert len({fn for fn, _ in visits}) == 2
    assert max(visits.values()) > 1
    classify_entries = sum(
        count for (fn, block), count in visits.items()
        if data["functions"][fn]["raw_name"].split("/")[0] == "classify"
        and data["functions"][fn]["blocks"][block]["entry"]
    )
    assert classify_entries == (iterations + 6) // 7
    html = report.read_text()
    assert "timeline-density" in html and "Recorded BB entries" not in html
    assert '<div class="brand">VISASM Trace</div>' in html
    assert "Before instrumentation" in html and "With BB instrumentation" in html
    assert "Runtime ratio" not in html
    assert "Both runs use QEMU" not in html and "Click or drag the playhead" not in html
