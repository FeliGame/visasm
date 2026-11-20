"""Loopback HTTP server for the visasm browser workspace."""

from __future__ import annotations

import json
import os
import shutil
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from secrets import token_urlsafe
from tempfile import TemporaryDirectory
from threading import Lock
from urllib.parse import parse_qs, urlsplit

from .workspace import Workspace, text_option


_ASSETS = Path(__file__).with_name("assets")
_CONTENT_TYPES = {
    "index.html": "text/html; charset=utf-8",
    "workspace.css": "text/css; charset=utf-8",
    "workspace.js": "text/javascript; charset=utf-8",
    "xterm.css": "text/css; charset=utf-8",
    "xterm.js": "text/javascript; charset=utf-8",
}
_WORKSPACE_POLICY = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
)
_REPORT_POLICY = (
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
    "object-src 'none'; base-uri 'none'; frame-ancestors 'self'"
)


class WorkspaceServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, root: Path, directory: Path, port: int):
        self.workspace = Workspace(root, directory)
        self.prefix = f"/{token_urlsafe(24)}/"
        self.terminal = None
        self.terminal_lock = Lock()
        super().__init__(("127.0.0.1", port), WorkspaceHandler)
        self.host = f"127.0.0.1:{self.server_port}"
        self.origin = f"http://{self.host}"

    def dispose(self) -> None:
        self.workspace.close()
        with self.terminal_lock:
            if self.terminal is not None:
                self.terminal.close()


class WorkspaceHandler(BaseHTTPRequestHandler):
    server: WorkspaceServer

    def log_message(self, format: str, *args) -> None:
        # Request paths contain the per-server access token.
        return

    def headers_for(self, content_type: str, length: int, *, policy: str = _WORKSPACE_POLICY,
                    download: str | None = None, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", policy)
        if download:
            self.send_header("Content-Disposition", f'attachment; filename="{download}"')
        self.end_headers()

    def respond(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.headers_for("application/json", len(body), status=status)
        self.wfile.write(body)

    def route(self) -> tuple[str, dict]:
        url = urlsplit(self.path)
        if (self.headers.get("Host") != self.server.host
                or not url.path.startswith(self.server.prefix)):
            raise FileNotFoundError("Open the workspace URL printed by visasm serve")
        return url.path[len(self.server.prefix):], parse_qs(url.query)

    def do_GET(self) -> None:
        try:
            route, query = self.route()
            self.read_route(route, query)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except FileNotFoundError as exc:
            self.respond({"error": str(exc)}, HTTPStatus.NOT_FOUND)
        except (OSError, ValueError) as exc:
            self.respond({"error": str(exc)}, HTTPStatus.BAD_REQUEST)

    def read_route(self, route: str, query: dict) -> None:
        workspace = self.server.workspace
        if route in ("", *_CONTENT_TYPES):
            name = route or "index.html"
            data = (_ASSETS / name).read_bytes()
            self.headers_for(_CONTENT_TYPES[name], len(data))
            self.wfile.write(data)
        elif route == "api/files":
            self.respond(workspace.browse(query.get("path", ["."])[0]))
        elif route == "api/source":
            self.respond(workspace.preview(query.get("path", [""])[0]))
        elif route == "api/config":
            self.respond({
                "qemu": os.environ.get("QEMU_BIN", ""),
                "qemu-include": os.environ.get("QEMU_INCLUDE", ""),
                "llvm-bin": os.environ.get("VISASM_BOLT_BIN", ""),
                "compiler": os.environ.get("VISASM_CLANG", ""),
            })
        elif route == "api/terminal":
            with self.server.terminal_lock:
                terminal = self.server.terminal
                if terminal is None:
                    raise FileNotFoundError("Open the terminal to start a shell")
                self.respond(terminal.poll(self.offset(query)))
        elif route.startswith(("api/jobs/", "reports/")):
            job = workspace.jobs.get(route.rsplit("/", 1)[-1])
            if job is None:
                raise FileNotFoundError("Analysis run not found")
            if route.startswith("api/jobs/"):
                self.respond(job.poll(self.offset(query)))
            elif job.returncode == 0 and not job.cancelled:
                with job.report.open("rb") as report:
                    filename = f"visasm-{job.mode}.html" if "download" in query else None
                    self.headers_for("text/html; charset=utf-8", job.report.stat().st_size,
                                     policy=_REPORT_POLICY, download=filename)
                    shutil.copyfileobj(report, self.wfile)
            else:
                raise FileNotFoundError("Report is not ready")
        else:
            raise FileNotFoundError("Workspace page not found")

    @staticmethod
    def offset(query: dict) -> int:
        return max(0, int(query.get("offset", ["0"])[0]))

    def do_POST(self) -> None:
        try:
            route, _ = self.route()
            if (self.headers.get("Origin") != self.server.origin
                    or self.headers.get_content_type() != "application/json"):
                self.respond({"error": "Request must originate from the workspace"}, HTTPStatus.FORBIDDEN)
                return
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 1024 * 1024:
                raise ValueError("Invalid request size")
            options = json.loads(self.rfile.read(size))
            if not isinstance(options, dict):
                raise ValueError("Request body must be an object")
            self.write_route(route, options)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except FileNotFoundError as exc:
            self.respond({"error": str(exc)}, HTTPStatus.NOT_FOUND)
        except (OSError, ValueError) as exc:
            self.respond({"error": str(exc)}, HTTPStatus.BAD_REQUEST)

    def write_route(self, route: str, options: dict) -> None:
        workspace = self.server.workspace
        if route == "api/jobs":
            self.respond({"id": workspace.start(options).id}, HTTPStatus.ACCEPTED)
        elif route.startswith("api/jobs/") and route.endswith("/cancel"):
            job = workspace.jobs.get(route.split("/")[-2])
            if job is None:
                raise FileNotFoundError("Analysis run not found")
            job.cancel()
            self.respond({})
        elif route.startswith("api/terminal/"):
            with self.server.terminal_lock:
                self.terminal_command(route.rsplit("/", 1)[-1], options)
            self.respond({})
        else:
            raise FileNotFoundError("Workspace action not found")

    def terminal_command(self, action: str, options: dict) -> None:
        from .terminal import Terminal

        terminal = self.server.terminal
        if action == "open":
            if terminal is None or terminal.finished:
                if terminal is not None:
                    terminal.close()
                    self.server.terminal = None
                root = self.server.workspace.path(text_option(options, "cwd", "."))
                self.server.terminal = Terminal(root, options.get("rows"), options.get("columns"))
        elif terminal is None:
            raise FileNotFoundError("Terminal is not open")
        elif action == "input":
            data = options.get("data")
            if not isinstance(data, str):
                raise ValueError("Invalid terminal input")
            terminal.write(data)
        elif action == "resize":
            terminal.resize(options.get("rows"), options.get("columns"))
        elif action == "close":
            terminal.close()
            self.server.terminal = None
        else:
            raise FileNotFoundError("Terminal action not found")


def cmd_serve(args) -> int:
    if sys.platform != "linux":
        print("visasm serve requires Linux for local analysis and the terminal", file=sys.stderr)
        return 2
    try:
        with TemporaryDirectory(prefix="visasm-web-") as directory:
            with WorkspaceServer(Path(args.root), Path(directory), args.port) as server:
                print(f"VISASM workspace  {server.origin}{server.prefix}", flush=True)
                print(f"Files             {server.workspace.root}", flush=True)
                try:
                    server.serve_forever()
                except KeyboardInterrupt:
                    pass
                finally:
                    server.dispose()
    except (OSError, ValueError, OverflowError) as exc:
        print(f"visasm: {exc}", file=sys.stderr)
        return 2
    return 0
