"""Input and output paths used by the command line."""

from pathlib import Path
from typing import Union


def require_path(path: str, description: str) -> Path:
    result = Path(path)
    if not result.exists():
        raise SystemExit(f"visasm: {description} not found: {path}")
    return result


def output_directory(command: str, binary: Union[str, Path]) -> Path:
    path = Path("visasm-output") / command / Path(binary).name
    path.mkdir(parents=True, exist_ok=True)
    return path
