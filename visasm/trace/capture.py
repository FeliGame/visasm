"""Capture visits to BOLT basic block entries with a QEMU user-mode plugin."""

from __future__ import annotations

import mmap
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from ..bolt import BoltError, _env


_HEADER = struct.Struct("=5Q")
_EVENT = struct.Struct("=QII")
_ELF_PROGRAM_HEADER = struct.Struct("<IIQQQQQQ")
_MACHINES = {62: "x86_64", 183: "aarch64"}


def _elf_target(binary: Path) -> tuple[str, int]:
    with binary.open("rb") as stream:
        header = stream.read(64)
        if len(header) != 64 or not header.startswith(b"\x7fELF\x02\x01"):
            raise BoltError("trace requires a little-endian x86-64 or AArch64 ELF executable")
        elf_type, machine = struct.unpack_from("<HH", header, 16)
        if elf_type not in (2, 3) or machine not in _MACHINES:
            raise BoltError("trace requires a little-endian x86-64 or AArch64 ELF executable")
        table = struct.unpack_from("<Q", header, 32)[0]
        size, count = struct.unpack_from("<HH", header, 54)
        if size != _ELF_PROGRAM_HEADER.size:
            raise BoltError("invalid ELF program header size")
        stream.seek(table)
        code = []
        for _ in range(count):
            data = stream.read(size)
            if len(data) != size:
                raise BoltError("truncated ELF program header table")
            segment, flags, _, address, *_ = _ELF_PROGRAM_HEADER.unpack(data)
            if segment == 1 and flags & 1:
                code.append(address)
    if not code:
        raise BoltError("ELF executable has no executable LOAD segment")
    return _MACHINES[machine], min(code)


def _probe_locations(functions: list[dict]) -> tuple[list[int], list[list[int]]]:
    locations = {}
    for fn_index, fn in enumerate(functions):
        for block_index, block in enumerate(fn["blocks"]):
            for inst in block["insts"]:
                if not inst.get("data") and not inst["text"].lstrip().startswith("!CFI"):
                    locations.setdefault(inst["addr"], [fn_index, block_index])
                    break
    addresses = sorted(locations)
    if not addresses:
        raise BoltError("BOLT found no basic block entry instructions to trace")
    return addresses, [locations[address] for address in addresses]


def _build_plugin(output: Path, include: str | None) -> None:
    compiler = shutil.which("cc")
    if not compiler:
        raise BoltError("trace requires a C compiler available as cc")
    source = Path(__file__).with_name("qemu_plugin.c")
    command = [compiler, "-std=c11", "-O2", "-fPIC", "-shared", "-pthread"]
    if include:
        command.extend(["-I", include])
    pkg_config = shutil.which("pkg-config")
    if pkg_config:
        flags = subprocess.run(
            [pkg_config, "--cflags", "glib-2.0"], capture_output=True, text=True,
        )
        if flags.returncode == 0:
            command.extend(flags.stdout.split())
    proc = subprocess.run(
        [*command, str(source), "-o", str(output)],
        env=_env(), capture_output=True, text=True,
    )
    if proc.returncode:
        raise BoltError(
            "cannot build the trace plugin; use --qemu-include to point to a "
            "qemu-plugin.h matching your QEMU build. Recent headers also require GLib development files.\n"
            + proc.stderr[-4000:]
        )


def _timed_run(command: list[str], label: str, verbose: bool) -> tuple[int, int]:
    if verbose:
        print("+", *command, flush=True)
    try:
        start = time.clock_gettime_ns(time.CLOCK_MONOTONIC)
        proc = subprocess.run(command, env=_env())
        duration = time.clock_gettime_ns(time.CLOCK_MONOTONIC) - start
    except OSError as exc:
        raise BoltError(f"{label} could not start: {exc}") from exc
    if proc.returncode:
        raise BoltError(f"{label} exited with status {proc.returncode}")
    return start, duration


def _read_events(trace: mmap.mmap, offset: int, start: int, duration: int) -> dict:
    _, probe_count, count, main_thread, error = _HEADER.unpack_from(trace)
    if not main_thread:
        raise BoltError("QEMU did not initialize the trace plugin (requires a plugin-enabled build)")
    if error:
        raise BoltError(f"QEMU could not record the complete trace: {os.strerror(error)}")
    events = []
    end = offset + count * _EVENT.size
    if end > len(trace):
        raise BoltError("QEMU trace file is missing BB records")
    with memoryview(trace)[offset:end] as records:
        for timestamp, probe, thread in _EVENT.iter_unpack(records):
            relative = timestamp - start
            if probe >= probe_count or not 0 <= relative <= duration or not thread:
                raise BoltError("invalid record in QEMU basic block trace")
            events.append([relative, probe, thread])
    events.sort(key=lambda event: event[0])
    return {"events": events, "main_thread": main_thread}


def collect_timeline(
    binary: Path,
    args: list[str],
    functions: list[dict],
    *,
    qemu: str | None,
    qemu_include: str | None,
    verbose: bool,
) -> dict:
    if sys.platform != "linux" or struct.calcsize("P") != 8:
        raise BoltError("trace requires a 64-bit Linux host")
    machine, code_start = _elf_target(binary)
    emulator = shutil.which(qemu or f"qemu-{machine}")
    if not emulator:
        raise BoltError(f"cannot find {qemu or f'qemu-{machine}'}; pass --qemu <path>")
    addresses, blocks = _probe_locations(functions)

    with tempfile.TemporaryDirectory(prefix="visasm-trace-") as directory:
        plugin = Path(directory) / "qemu_plugin.so"
        if "," in str(plugin):
            raise BoltError("QEMU plugin paths cannot contain commas; choose another TMPDIR")
        try:
            help_text = subprocess.check_output([emulator, "-help"], env=_env(), text=True)
        except (OSError, subprocess.CalledProcessError) as exc:
            raise BoltError(f"cannot query QEMU user-mode options: {exc}") from exc
        if "-plugin" not in help_text:
            raise BoltError("trace requires QEMU built with user-mode plugin support")
        _build_plugin(plugin, qemu_include)

        print("[2/3] running QEMU baseline", flush=True)
        _, baseline = _timed_run([emulator, str(binary), *args], "QEMU baseline", verbose)

        print("[3/3] recording BB entries under QEMU", flush=True)
        with (Path(directory) / "events.bin").open("w+b") as records:
            records.write(_HEADER.pack(code_start, len(addresses), 0, 0, 0))
            records.write(struct.pack(f"={len(addresses)}Q", *addresses))
            offset = records.tell()
            records.flush()
            fd = records.fileno()
            command = [emulator, "-plugin", f"file={plugin},output={records.name}", str(binary), *args]
            start, duration = _timed_run(command, "QEMU trace", verbose)
            with mmap.mmap(fd, 0, access=mmap.ACCESS_READ) as trace:
                result = _read_events(trace, offset, start, duration)

    return {
        **result,
        "backend": "qemu-user",
        "baseline_ns": baseline,
        "duration_ns": duration,
        "blocks": blocks,
    }
