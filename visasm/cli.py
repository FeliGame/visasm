"""Command line interface for visasm."""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path
from typing import Optional

from . import __version__
from .bolt import Bolt, BoltError, run_instrumented
from .model import parse_print_cfg
from .report import build_payload, write_report


def _bolt(args) -> Bolt:
    return Bolt(llvm_bin=args.llvm_bin, verbose=args.verbose)


def _need(path: str, what: str) -> Path:
    p = Path(path)
    if not p.exists():
        raise SystemExit(f"visasm: {what} not found: {path}")
    return p


def _dump(args, binary: str, profile: Optional[str]) -> str:
    bolt = _bolt(args)
    return bolt.dump_cfg(
        binary,
        profile=profile,
        only=args.function_filter,
        debug_info=not args.no_source,
    )


def cmd_instrument(args) -> int:
    binary = str(_need(args.binary, "binary"))
    out = args.output or f"{binary}.inst"
    profile = args.profile or f"{out}.fdata"
    Path(profile).unlink(missing_ok=True)
    bolt = _bolt(args)
    bolt.instrument(str(binary), out, profile, extra_opts=args.bolt_opt or [])
    print(f"instrumented binary : {out}")
    print(f"profile will be saved: {profile}")
    print("\nnext:")
    print(f"  visasm run {out} --profile {profile} -- <program arguments>")
    print(f"  visasm report {binary} --data {profile} -o report.html")
    return 0


def cmd_run(args) -> int:
    binary = str(_need(args.binary, "instrumented binary"))
    run_instrumented(binary, args.program_args or [])
    if args.profile:
        p = Path(args.profile)
        if not p.exists():
            raise SystemExit(
                f"visasm: profile was not written to {p}\n"
                "  - did the program exit through normal termination?\n"
                "  - static binaries need -instrumentation-sleep-time at instrument time"
            )
        print(f"profile             : {p}")
    return 0


def cmd_report(args) -> int:
    binary = str(_need(args.binary, "binary"))
    profile = str(_need(args.data, "profile")) if args.data else None
    text = _dump(args, binary, profile)
    functions = parse_print_cfg(text)
    if not functions:
        raise SystemExit(
            "visasm: BOLT produced no CFG output. "
            "Make sure the binary is an ELF executable that BOLT can process."
        )
    functions = [f for f in functions if f.blocks]
    payload = build_payload(functions, binary, profile, title=args.title)

    out = args.output or f"{Path(binary).name}.visasm.html"
    if args.json:
        Path(args.json).write_text(json.dumps(payload, indent=1), encoding="utf-8")
        print(f"json                : {args.json}")
    write_report(payload, out, llvm_bin=args.llvm_bin)
    s = payload["summary"]
    print(f"functions           : {s['functions']} ({s['matched_functions']} matched)")
    print(f"basic blocks        : {s['blocks']}")
    print(f"report              : {out}")
    return 0


def cmd_profile(args) -> int:
    binary = str(_need(args.binary, "binary"))
    if args.workdir:
        Path(args.workdir).mkdir(parents=True, exist_ok=True)
        workdir = args.workdir
    else:
        workdir = tempfile.mkdtemp(prefix="visasm-")
    name = Path(binary).name
    out_bin = str(Path(workdir) / f"{name}.inst")
    profile = args.profile or str(Path(workdir) / "prof.fdata")
    Path(profile).unlink(missing_ok=True)

    bolt = _bolt(args)
    print(f"[1/3] instrumenting {binary} (BOLT machine-code instrumentation)")
    bolt.instrument(binary, out_bin, profile, extra_opts=args.bolt_opt or [])

    print(f"[2/3] running {out_bin} {' '.join(args.program_args or [])}")
    run_instrumented(out_bin, args.program_args or [])
    if not Path(profile).exists():
        raise SystemExit("visasm: instrumented program did not write a profile")

    print("[3/3] matching profile to machine CFG")
    text = _dump(args, binary, profile)
    functions = [f for f in parse_print_cfg(text) if f.blocks]
    payload = build_payload(functions, binary, profile, title=args.title)
    out = args.output or f"{Path(binary).name}.visasm.html"
    if args.json:
        Path(args.json).write_text(json.dumps(payload, indent=1), encoding="utf-8")
    write_report(payload, out, llvm_bin=args.llvm_bin)
    s = payload["summary"]
    print(f"      profile {profile}")
    print(f"      {s['functions']} functions, {s['blocks']} basic blocks")
    print(f"      report: {out}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="visasm",
        description=(
            "BB-level runtime profiling and visualization built on LLVM 22 BOLT "
            "instrumentation (machine code, not mid-end IR)."
        ),
    )
    p.add_argument("--version", action="version", version=f"visasm {__version__}")
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp):
        sp.add_argument("--llvm-bin", help="directory containing llvm-bolt/merge-fdata")
        sp.add_argument("-v", "--verbose", action="store_true")

    pi = sub.add_parser("instrument", help="insert per-BB counters into a binary")
    pi.add_argument("binary")
    pi.add_argument("-o", "--output", help="instrumented binary (default: <binary>.inst)")
    pi.add_argument("--profile", help="where the instrumented run writes fdata")
    pi.add_argument("--bolt-opt", action="append", help="extra llvm-bolt option")
    common(pi)
    pi.set_defaults(func=cmd_instrument)

    pr = sub.add_parser(
        "run",
        help="run an instrumented binary and collect its profile",
        epilog="use '--' to separate visasm options from the program arguments",
    )
    pr.add_argument("binary")
    pr.add_argument("--profile", help="expected profile path (checked afterwards)")
    common(pr)
    pr.set_defaults(func=cmd_run)

    pp = sub.add_parser("report", help="build an HTML report from an existing profile")
    pp.add_argument("binary", help="original (non-instrumented) binary")
    pp.add_argument("--data", help="profile produced by the instrumented run")
    pp.add_argument("-o", "--output", help="HTML output")
    pp.add_argument("--json", help="also write the parsed model as JSON")
    pp.add_argument("--func", dest="function_filter", help="only include functions matching this BOLT regex")
    pp.add_argument("--no-source", action="store_true", help="skip DWARF source lines")
    pp.add_argument("--title")
    common(pp)
    pp.set_defaults(func=cmd_report)

    pa = sub.add_parser("profile", help="instrument, run, and report in one step")
    pa.add_argument("binary")
    pa.add_argument("-o", "--output", help="HTML output")
    pa.add_argument("--json", help="also write the parsed model as JSON")
    pa.add_argument("--workdir", help="keep intermediate files in this directory")
    pa.add_argument("--profile", help="profile output path")
    pa.add_argument("--func", dest="function_filter", help="only include functions matching this BOLT regex")
    pa.add_argument("--no-source", action="store_true", help="skip DWARF source lines")
    pa.add_argument("--bolt-opt", action="append", help="extra llvm-bolt option")
    pa.add_argument("--title")
    common(pa)
    pa.set_defaults(func=cmd_profile)

    return p


def main(argv: Optional[list[str]] = None) -> int:
    if argv is None:
        argv = sys.argv[1:]

    # Everything after "--" belongs to the profiled program.
    program_args: list[str] = []
    if "--" in argv:
        split = argv.index("--")
        argv, program_args = argv[:split], argv[split + 1 :]

    parser = build_parser()
    args, extra = parser.parse_known_args(argv)
    if extra:
        if args.cmd not in ("run", "profile"):
            parser.error(f"unrecognized arguments: {' '.join(extra)}")
        program_args = extra + program_args
    args.program_args = program_args
    try:
        return args.func(args)
    except BoltError as exc:
        print(f"visasm: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
