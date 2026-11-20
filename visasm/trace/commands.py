"""Basic-block execution tracing command."""

from __future__ import annotations

import json
import re
from pathlib import Path

from ..bolt import Bolt, BoltError
from ..model import parse_print_cfg
from ..paths import output_directory, require_path
from ..report import build_payload, strip_alias, write_report
from .capture import collect_timeline


def cmd_trace(args) -> int:
    binary = require_path(args.binary, "binary").absolute()
    profile = str(require_path(args.fdata, "BOLT fdata")) if args.fdata else None
    try:
        pattern = re.compile(args.function_filter) if args.function_filter else None
    except re.error as exc:
        raise BoltError(f"invalid --function regex: {exc}") from exc
    print("[1/3] finding BB entries in the BOLT CFG", flush=True)
    bolt = Bolt(llvm_bin=args.llvm_bin, verbose=args.verbose)
    text = bolt.dump_cfg(str(binary), profile=profile, debug_info=not args.no_source)
    functions = [
        fn for fn in parse_print_cfg(text)
        if fn.blocks and (pattern is None or pattern.search(strip_alias(fn.name)))
    ]
    payload = build_payload(functions, str(binary), profile, title=args.title)
    payload["timeline"] = collect_timeline(
        binary, args.program_args, payload["functions"],
        qemu=args.qemu,
        qemu_include=args.qemu_include, verbose=args.verbose,
    )
    output = args.output or str(output_directory("trace", binary) / "report.html")
    if args.json:
        with Path(args.json).open("w", encoding="utf-8") as stream:
            json.dump(payload, stream, separators=(",", ":"))
        print(f"json                : {args.json}")
    write_report(payload, output, llvm_bin=args.llvm_bin)
    timeline = payload["timeline"]
    print(f"BB entries          : {len(timeline['events']):,}")
    print(f"report              : {output}")
    return 0
