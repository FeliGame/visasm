"""Command line interface for visasm."""

from __future__ import annotations

import argparse
import sys

from . import __version__
from .bolt import BoltError
from .profile.commands import cmd_instrument, cmd_profile, cmd_report, cmd_run
from .trace.commands import cmd_trace
from .web.server import cmd_serve


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="visasm",
        description=(
            "Visualize machine basic blocks with BOLT hotspot profiles or QEMU execution timelines."
        ),
    )
    p.add_argument("--version", action="version", version=f"visasm {__version__}")
    sub = p.add_subparsers(dest="cmd", required=True, title="commands", metavar="COMMAND")
    program_args_help = "Pass target program arguments after '--'."

    def common(sp):
        sp.add_argument("--llvm-bin", help="directory containing llvm-bolt/merge-fdata")
        sp.add_argument("-v", "--verbose", action="store_true")

    web = sub.add_parser("serve", help="Open the local browser workspace for Profile and Trace")
    web.add_argument("root", nargs="?", default=".", help="directory shown in the file browser")
    web.add_argument("--port", type=int, default=8765, help="loopback port (default: 8765, use 0 for automatic)")
    web.set_defaults(func=cmd_serve)

    pa = sub.add_parser(
        "profile",
        help="Build a BB hotspot report with BOLT",
        description="Instrument and run an ELF executable with BOLT, then visualize BB execution counts.",
        epilog=program_args_help,
    )
    pa.add_argument("binary", help="original ELF executable")
    pa.add_argument("-o", "--output", help="HTML output (default: visasm-output/profile/<binary>/report.html)")
    pa.add_argument("--json", help="also write the parsed model as JSON")
    pa.add_argument("--work-dir", "--workdir", help="directory for the instrumented ELF and fdata")
    pa.add_argument("--fdata-out", "--profile", help="path for the generated BOLT fdata")
    pa.add_argument("--function", "--func", dest="function_filter", help="filter report functions with BOLT --print-only")
    pa.add_argument("--no-source", action="store_true", help="skip DWARF source lines")
    pa.add_argument("--bolt-opt", action="append", help="extra llvm-bolt option")
    pa.add_argument("--title", help="report title")
    common(pa)
    pa.set_defaults(func=cmd_profile)

    pt = sub.add_parser(
        "trace",
        help="Build a BB execution timeline with QEMU",
        description="Run an ELF executable twice under QEMU to measure wall time and record BB entry timestamps.",
        epilog=program_args_help,
    )
    pt.add_argument("binary", help="original ELF executable")
    pt.add_argument("--fdata", "--data", help="include BOLT hotspot counts from this file")
    pt.add_argument("-o", "--output", help="HTML output (default: visasm-output/trace/<binary>/report.html)")
    pt.add_argument("--json", help="also write the model and trace as JSON")
    pt.add_argument("--function", "--func", dest="function_filter", help="trace functions whose BOLT names match this regex")
    pt.add_argument("--no-source", action="store_true", help="skip DWARF source lines")
    pt.add_argument("--qemu", help="plugin-enabled QEMU user-mode executable (default: qemu-<ELF architecture> on PATH)")
    pt.add_argument("--qemu-include", help="directory containing the matching qemu-plugin.h")
    pt.add_argument("--title", help="report title")
    common(pt)
    pt.set_defaults(func=cmd_trace)

    pi = sub.add_parser("instrument", help="BOLT hotspot workflow: insert counters")
    pi.add_argument("binary")
    pi.add_argument("-o", "--output", help="instrumented ELF (default: visasm-output/profile/<binary>/<binary>.inst)")
    pi.add_argument("--fdata-out", "--profile", help="path for the generated BOLT fdata")
    pi.add_argument("--bolt-opt", action="append", help="extra llvm-bolt option")
    common(pi)
    pi.set_defaults(func=cmd_instrument)

    pr = sub.add_parser(
        "run",
        help="BOLT hotspot workflow: run an instrumented binary",
        epilog=program_args_help,
    )
    pr.add_argument("binary")
    pr.add_argument("--expect-fdata", "--profile", help="verify this fdata file exists after the run")
    common(pr)
    pr.set_defaults(func=cmd_run)

    pp = sub.add_parser("report", help="BOLT hotspot workflow: render a CFG with optional profile counts")
    pp.add_argument("binary", help="original (non-instrumented) binary")
    pp.add_argument("--fdata", "--data", help="include BOLT hotspot counts from this file")
    pp.add_argument("-o", "--output", help="HTML output (default: visasm-output/profile/<binary>/report.html)")
    pp.add_argument("--json", help="also write the parsed model as JSON")
    pp.add_argument("--function", "--func", dest="function_filter", help="filter report functions with BOLT --print-only")
    pp.add_argument("--no-source", action="store_true", help="skip DWARF source lines")
    pp.add_argument("--title")
    common(pp)
    pp.set_defaults(func=cmd_report)

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
