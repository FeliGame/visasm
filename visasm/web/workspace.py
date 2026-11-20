"""File browsing and analysis jobs for the local workspace."""

from __future__ import annotations

import os
import shlex
import signal
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock, Thread
from uuid import uuid4


SOURCE_EXTENSIONS = {".c", ".cc", ".cpp", ".cxx", ".c++", ".C", ".s", ".S"}
HEADER_EXTENSIONS = {".h", ".hh", ".hpp", ".hxx", ".h++", ".H"}
_CXX_EXTENSIONS = {".cc", ".cpp", ".cxx", ".c++", ".C"}
_PREVIEW_BYTES = 256 * 1024


def file_kind(path: Path) -> str:
    with path.open("rb") as stream:
        if stream.read(4) == b"\x7fELF":
            return "elf"
    if path.suffix in SOURCE_EXTENSIONS:
        return "source"
    if path.suffix in HEADER_EXTENSIONS:
        return "header"
    return "text"


def text_option(options: dict, name: str, default: str = "") -> str:
    value = options.get(name, default)
    if not isinstance(value, str) or "\0" in value:
        raise ValueError(f"Invalid {name}")
    return value


class AnalysisJob:
    def __init__(self, directory: Path, cwd: Path, commands: list[list[str]], mode: str):
        self.id = uuid4().hex
        self.directory = directory / self.id
        self.directory.mkdir()
        self.report = self.directory / "report.html"
        self.log = self.directory / "output.log"
        self.cwd = cwd
        self.commands = commands
        self.mode = mode
        self.lock = Lock()
        self.process = None
        self.cancelled = False
        self.returncode = None
        self.updated_at = None
        self.worker = Thread(target=self.run, daemon=True)

    def run(self) -> None:
        env = {**os.environ, "PYTHONUNBUFFERED": "1"}
        package_parent = str(Path(__file__).resolve().parents[2])
        env["PYTHONPATH"] = os.pathsep.join(filter(None, [package_parent, env.get("PYTHONPATH")]))
        code = 0
        with self.log.open("wb", buffering=0) as log:
            for command in self.commands:
                with self.lock:
                    if self.cancelled:
                        break
                    log.write(("$ " + shlex.join(command) + "\n").encode())
                    try:
                        self.process = subprocess.Popen(
                            command, cwd=self.cwd, env=env, stdout=log, stderr=log,
                            stdin=subprocess.DEVNULL, start_new_session=True,
                        )
                    except OSError as exc:
                        log.write((str(exc) + "\n").encode())
                        code = 1
                        break
                code = self.process.wait()
                if code:
                    break
            if not self.cancelled and not code and not self.report.is_file():
                log.write(b"Analysis did not produce a report.\n")
                code = 1
        with self.lock:
            if not code and not self.cancelled:
                self.updated_at = datetime.now(timezone.utc).isoformat()
            self.returncode = code
            self.process = None

    def cancel(self) -> None:
        with self.lock:
            if self.returncode is not None:
                return
            self.cancelled = True
            proc = self.process
        if proc is None:
            return
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=1)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        except ProcessLookupError:
            pass

    def poll(self, offset: int) -> dict:
        with self.lock:
            code = self.returncode
            cancelled = self.cancelled
            updated_at = self.updated_at
        output = ""
        if self.log.exists():
            with self.log.open("rb") as log:
                log.seek(min(offset, os.fstat(log.fileno()).st_size))
                data = log.read(65536)
                output = data.decode("utf-8", errors="replace")
                offset = log.tell()
        return {
            "offset": offset,
            "output": output,
            "state": "running" if code is None else "cancelled" if cancelled else "failed" if code else "complete",
            "mode": self.mode,
            "updated_at": updated_at,
        }


class Workspace:
    def __init__(self, root: Path, directory: Path):
        self.root = root.resolve(strict=True)
        if not self.root.is_dir():
            raise ValueError("Workspace root must be a directory")
        self.directory = directory
        self.jobs: dict[str, AnalysisJob] = {}
        self.lock = Lock()
        self.active_jobs: dict[str, AnalysisJob] = {}

    def path(self, value: str) -> Path:
        resolved = (self.root / value).resolve(strict=True)
        if not resolved.is_relative_to(self.root):
            raise ValueError("Path is outside the workspace")
        return resolved

    def browse(self, value: str) -> dict:
        directory = self.path(value)
        entries = []
        for path in directory.iterdir():
            if path.name.startswith("."):
                continue
            if path.is_symlink():
                try:
                    if not path.resolve(strict=True).is_relative_to(self.root):
                        continue
                except (OSError, RuntimeError):
                    continue
            if path.is_dir():
                kind = "directory"
            elif path.is_file():
                try:
                    kind = file_kind(path)
                except OSError:
                    kind = "text"
            else:
                continue
            entries.append({
                "name": path.name, "path": str(path.relative_to(self.root)),
                "directory": kind == "directory", "kind": kind,
            })
        entries.sort(key=lambda item: (not item["directory"], item["name"].casefold()))
        return {
            "root": str(self.root),
            "path": str(directory.relative_to(self.root)),
            "parent": None if directory == self.root else str(directory.parent.relative_to(self.root)),
            "entries": entries,
        }

    def preview(self, value: str) -> dict:
        path = self.path(value)
        if not path.is_file():
            raise ValueError("Select a regular file")
        kind = file_kind(path)
        data = b""
        if kind != "elf":
            with path.open("rb") as stream:
                data = stream.read(_PREVIEW_BYTES + 1)
        return {
            "kind": kind,
            "text": None if b"\0" in data else data[:_PREVIEW_BYTES].decode("utf-8", errors="replace"),
            "truncated": len(data) > _PREVIEW_BYTES,
        }

    def start(self, options: dict) -> AnalysisJob:
        mode = text_option(options, "mode")
        if mode not in ("profile", "trace"):
            raise ValueError("Select Profile or Trace")
        inputs = options.get("inputs")
        if not isinstance(inputs, list) or not inputs or not all(isinstance(item, str) for item in inputs):
            raise ValueError("Select a source file or an ELF executable")
        files = [self.path(item) for item in inputs]
        if not all(path.is_file() for path in files):
            raise ValueError("Select regular files")
        kinds = [file_kind(path) for path in files]
        sources = [path for path, kind in zip(files, kinds) if kind == "source"]
        header_dirs = list(dict.fromkeys(path.parent for path, kind in zip(files, kinds) if kind == "header"))
        if kinds != ["elf"] and (not sources or any(kind not in ("source", "header") for kind in kinds)):
            raise ValueError("Select at least one source file or one ELF executable")

        primary = sources[0] if sources else files[0]
        cwd = self.path(text_option(options, "cwd", str(primary.parent)))
        if not cwd.is_dir():
            raise ValueError("Working directory must be a directory")
        title = primary.stem if sources else primary.name
        args = shlex.split(text_option(options, "arguments"))
        cli = [
            sys.executable, "-m", "visasm.cli", mode, "--title=" + title,
        ]
        option_names = ["llvm-bin", "function"]
        if mode == "trace":
            option_names += ["qemu", "qemu-include"]
        for name in option_names:
            value = text_option(options, name).strip()
            if value:
                cli.append(f"--{name}={value}")
        if options.get("no-source") is True:
            cli.append("--no-source")

        compiler = flags = None
        if kinds != ["elf"]:
            default_compiler = "clang++" if any(path.suffix in _CXX_EXTENSIONS for path in sources) else "clang"
            compiler = shlex.split(text_option(options, "compiler").strip() or default_compiler)
            if not compiler:
                raise ValueError("Select a compiler")
            flags = shlex.split(text_option(options, "flags", "-O2 -g -Wl,-q"))

        commands = []
        job = AnalysisJob(self.directory, cwd, commands, mode)
        binary = files[0]
        if compiler is not None:
            binary = job.directory / "program"
            commands.append([
                *compiler, *(str(path) for path in sources), *flags,
                *("-I" + str(path) for path in header_dirs), "-o", str(binary),
            ])
        if mode == "profile":
            cli.extend(["--work-dir", str(job.directory / "profile")])
        commands.append([*cli, "--output", str(job.report), str(binary), "--", *args])

        with self.lock:
            active_job = self.active_jobs.get(mode)
            if active_job and active_job.returncode is None:
                job.directory.rmdir()
                raise ValueError(f"{mode.title()} is already running")
            self.jobs[job.id] = self.active_jobs[mode] = job
            job.worker.start()
        return job

    def close(self) -> None:
        for job in self.active_jobs.values():
            job.cancel()
        for job in self.active_jobs.values():
            job.worker.join()
