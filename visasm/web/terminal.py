"""Interactive shell backed by a Linux pseudo-terminal."""

from __future__ import annotations

import base64
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
from pathlib import Path
from threading import Event, Lock, Thread


_SHELL_LAUNCHER = """
import fcntl, os, sys, termios
fcntl.ioctl(0, termios.TIOCSCTTY, 0)
os.execvp(sys.argv[1], [sys.argv[1], '-i'])
"""
_HISTORY_BYTES = 1024 * 1024


class Terminal:
    def __init__(self, cwd: Path, rows: int, columns: int):
        self.lock = Lock()
        self.output = bytearray()
        self.offset = 0
        self.finished = False
        self.stopping = Event()
        self.master, slave = pty.openpty()
        try:
            self.resize(rows, columns)
            shell = os.environ.get("SHELL") or "/bin/sh"
            self.process = subprocess.Popen(
                [sys.executable, "-c", _SHELL_LAUNCHER, shell],
                cwd=cwd, stdin=slave, stdout=slave, stderr=slave,
                start_new_session=True, env={**os.environ, "TERM": "xterm-256color"},
            )
        except BaseException:
            os.close(self.master)
            raise
        finally:
            os.close(slave)
        self.reader = Thread(target=self.read_output, daemon=True)
        self.reader.start()

    def read_output(self) -> None:
        try:
            while not self.stopping.is_set():
                if not select.select([self.master], [], [], 0.2)[0]:
                    continue
                data = os.read(self.master, 65536)
                if not data:
                    break
                with self.lock:
                    self.output.extend(data)
                    excess = len(self.output) - _HISTORY_BYTES
                    if excess > 0:
                        del self.output[:excess]
                        self.offset += excess
        except OSError:
            # Linux PTYs return EIO when their last slave descriptor closes.
            pass
        finally:
            with self.lock:
                self.finished = True

    def poll(self, offset: int) -> dict:
        with self.lock:
            start = min(len(self.output), max(0, offset - self.offset))
            return {
                "offset": self.offset + len(self.output),
                "output": base64.b64encode(self.output[start:]).decode("ascii"),
                "finished": self.finished,
            }

    def write(self, data: str) -> None:
        pending = memoryview(data.encode("utf-8"))
        while pending:
            if not select.select([], [self.master], [], 1)[1]:
                raise ValueError("Terminal input is busy")
            try:
                written = os.write(self.master, pending[:4096])
            except OSError as exc:
                if exc.errno == errno.EIO:
                    raise ValueError("Terminal has exited") from exc
                raise
            pending = pending[written:]

    def resize(self, rows: int, columns: int) -> None:
        if type(rows) is not int or type(columns) is not int or not (1 <= rows <= 500 and 1 <= columns <= 500):
            raise ValueError("Invalid terminal dimensions")
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

    def close(self) -> None:
        self.stopping.set()
        self.reader.join()
        os.close(self.master)
        for sig in (signal.SIGHUP, signal.SIGKILL):
            if self.process.poll() is not None:
                break
            try:
                os.killpg(self.process.pid, sig)
                self.process.wait(timeout=0.5)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                pass
