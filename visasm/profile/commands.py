"""BOLT hotspot profiling commands."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Optional

from ..bolt import Bolt, run_instrumented
from ..model import parse_print_cfg
from ..paths import output_directory, require_path
from ..report import build_payload, write_report


def _bolt(args) -> Bolt:
    return Bolt(llvm_bin=args.llvm_bin, verbose=args.verbose)


def _dump(args, binary: str, profile: Optional[str]) -> str:
    bolt = _bolt(args)
    return bolt.dump_cfg(
        binary,
        profile=profile,
        only=args.function_filter,
        debug_info=not args.no_source,
    )


def cmd_instrument(args) -> int:
    binary = str(require_path(args.binary, "binary"))
    directory = output_directory("profile", binary) if not args.output else None
    out = args.output or str(directory / f"{Path(binary).name}.inst")
    profile = args.fdata_out or (f"{out}.fdata" if args.output else str(directory / "profile.fdata"))
    Path(profile).unlink(missing_ok=True)
    bolt = _bolt(args)
    bolt.instrument(str(binary), out, profile, extra_opts=args.bolt_opt or [])
    print(f"instrumented binary : {out}")
    print(f"profile will be saved: {profile}")
    print("\nnext:")
    print(f"  visasm run {out} --expect-fdata {profile} -- <program arguments>")
    print(f"  visasm report {binary} --fdata {profile}")
    return 0


def cmd_run(args) -> int:
    binary = str(require_path(args.binary, "instrumented binary"))
    run_instrumented(binary, args.program_args or [])
    if args.expect_fdata:
        p = Path(args.expect_fdata)
        if not p.exists():
            raise SystemExit(
                f"visasm: profile was not written to {p}\n"
                "  - did the program exit through normal termination?\n"
                "  - static binaries need -instrumentation-sleep-time at instrument time"
            )
        print(f"profile             : {p}")
    return 0


def cmd_report(args) -> int:
    binary = str(require_path(args.binary, "binary"))
    profile = str(require_path(args.fdata, "BOLT fdata")) if args.fdata else None
    text = _dump(args, binary, profile)
    functions = parse_print_cfg(text)
    if not functions:
        raise SystemExit(
            "visasm: BOLT produced no CFG output. "
            "Make sure the binary is an ELF executable that BOLT can process."
        )
    functions = [f for f in functions if f.blocks]
    payload = build_payload(functions, binary, profile, title=args.title)

    out = args.output or str(output_directory("profile", binary) / "report.html")
    if args.json:
        Path(args.json).write_text(json.dumps(payload, indent=1), encoding="utf-8")
        print(f"json                : {args.json}")
    write_report(payload, out, llvm_bin=args.llvm_bin)
    s = payload["summary"]
    print(f"functions           : {s['functions']}")
    print(f"basic blocks        : {s['blocks']}")
    print(f"report              : {out}")
    return 0


def cmd_profile(args) -> int:
    binary = str(require_path(args.binary, "binary"))
    if args.work_dir:
        Path(args.work_dir).mkdir(parents=True, exist_ok=True)
        workdir = args.work_dir
    else:
        workdir = tempfile.mkdtemp(prefix="run-", dir=output_directory("profile", binary))
    name = Path(binary).name
    out_bin = str(Path(workdir) / f"{name}.inst")
    profile = args.fdata_out or str(Path(workdir) / "profile.fdata")
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
    out = args.output or str(output_directory("profile", binary) / "report.html")
    if args.json:
        Path(args.json).write_text(json.dumps(payload, indent=1), encoding="utf-8")
    write_report(payload, out, llvm_bin=args.llvm_bin)
    s = payload["summary"]
    print(f"      profile {profile}")
    print(f"      {s['functions']} functions, {s['blocks']} basic blocks")
    print(f"      report: {out}")
    return 0
