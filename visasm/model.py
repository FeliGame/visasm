"""Data model for machine-level CFG profiles.

Everything in here is parsed from BOLT's ``--print-cfg`` output, which is
produced *after* BOLT has decoded the binary, rebuilt the machine CFG and
mapped the instrumentation profile onto it.  No IR-level information is
involved.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional


#: Sentinel used by BOLT when a value has no profile attached.
COUNT_NO_PROFILE = 1 << 64


@dataclass
class Instruction:
    offset: int
    text: str
    debug_line: Optional[str] = None
    is_data: bool = False
    #: Direct call target printed by BOLT (``bl "foo/1"``, ``callq foo@PLT``).
    call_target: Optional[str] = None
    #: Per-call-site count from BOLT's ``# Count: N`` annotation.
    call_count: Optional[int] = None


@dataclass
class Successor:
    target: str
    count: Optional[int] = None
    mispreds: Optional[int] = None
    inferred: Optional[int] = None


@dataclass
class Block:
    name: str
    entry: bool = False
    exec_count: Optional[int] = None
    preds: list[str] = field(default_factory=list)
    succs: list[Successor] = field(default_factory=list)
    instructions: list[Instruction] = field(default_factory=list)
    alignment: int = 1
    declare_count: Optional[int] = None
    cfi_state: Optional[int] = None

    @property
    def offset(self) -> int:
        return self.instructions[0].offset if self.instructions else 0

    @property
    def size(self) -> int:
        return len([i for i in self.instructions if not i.is_data])

    def to_json(self, address: int, layout_index: int) -> dict:
        last = self.instructions[-1].text if self.instructions else ""
        return {
            "name": self.name,
            "index": layout_index,
            "offset": self.offset,
            "addr": address + self.offset,
            "count": self.exec_count,
            "preds": self.preds,
            "succs": [
                {
                    "target": s.target,
                    "count": s.count,
                    "mispreds": s.mispreds,
                    "inferred": s.inferred,
                }
                for s in self.succs
            ],
            "insts": [
                {
                    "offset": i.offset,
                    "addr": address + i.offset,
                    "text": i.text,
                    "debug": i.debug_line,
                    **({"data": True} if i.is_data else {}),
                    **({"call": i.call_target} if i.call_target else {}),
                    **(
                        {"call_count": i.call_count}
                        if i.call_target and i.call_count is not None
                        else {}
                    ),
                }
                for i in self.instructions
            ],
            "last": last,
            "entry": self.entry,
        }


@dataclass
class Function:
    name: str
    address: int = 0
    size: int = 0
    exec_count: Optional[int] = None
    bb_count: int = 0
    is_simple: bool = True
    layout: list[str] = field(default_factory=list)
    blocks: list[Block] = field(default_factory=list)
    unknown_cf: bool = False

    def to_json(self) -> dict:
        by_name = {b.name: b for b in self.blocks}
        order = [n for n in self.layout if n in by_name]
        if len(order) != len(self.blocks):
            seen = set(order)
            order += [b.name for b in self.blocks if b.name not in seen]
        return {
            "name": self.name,
            "address": self.address,
            "size": self.size,
            "exec_count": self.exec_count,
            "bb_count": len(self.blocks),
            "is_simple": self.is_simple,
            "unknown_cf": self.unknown_cf,
            "blocks": [
                by_name[n].to_json(self.address, idx)
                for idx, n in enumerate(order)
            ],
            "layout": order,
        }


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

_FUNC_RE = re.compile(r'^Binary Function "(.*)" .* \{$')
_KEY_RE = re.compile(r"^  ([A-Za-z][A-Za-z0-9 ]*?)\s*: (.*)$")
_BLOCK_RE = re.compile(r"^(.*) \((\d+) instructions, align : (\d+)\)$")
_INST_RE = re.compile(r"^    ([0-9a-fA-F]{8,16}): (.*)$")
_DEBUG_RE = re.compile(r" # debug line (.*?):(\d+)(?::(\d+))?")
_COUNT_RE = re.compile(r"#\s*Count:\s*(\d+)")
#: Direct calls and tail calls. Conditional branches (``b.eq``) cannot match
#: because a whitespace is required after the mnemonic.
_CALL_RE = re.compile(r"^(bl|blx|call|callq|b|jmp)\s+(\S+)(?:\s+<([^>]+)>)?")

#: Lines printed by BOLT's diagnostics interleaved with the CFG dump.
_NOISE_PREFIXES = ("BOLT-INFO", "BOLT-WARNING", "BOLT-ERROR")


def _split_name_list(text: str, known: list[str]) -> list[tuple[str, Optional[str]]]:
    """Split a BOLT name list such as ``a (count: 1), b`` into entries.

    Block names may themselves contain spaces and commas (demangled C++
    names), therefore known names are matched greedily.  The optional
    parenthesised suffix is returned separately.
    """
    names = sorted(set(known), key=len, reverse=True)
    out: list[tuple[str, Optional[str]]] = []
    i, n = 0, len(text)
    while i < n:
        while i < n and text[i] in " ,":
            i += 1
        if i >= n:
            break
        name = None
        for cand in names:
            if text.startswith(cand, i):
                end = i + len(cand)
                if end == n or text[end] in ", (":
                    name = cand
                    break
        if name is None:  # fallback: consume up to the next top-level comma
            j = i
            depth = 0
            while j < n:
                if text[j] == "(":
                    depth += 1
                elif text[j] == ")":
                    depth -= 1
                elif text[j] == "," and depth == 0:
                    break
                j += 1
            name = text[i:j].strip()
            i = j
        else:
            i += len(name)
        suffix = None
        while i < n and text[i] == " ":
            i += 1
        if i < n and text[i] == "(":
            depth = 1
            j = i + 1
            while j < n and depth:
                if text[j] == "(":
                    depth += 1
                elif text[j] == ")":
                    depth -= 1
                j += 1
            suffix = text[i + 1 : j - 1]
            i = j
        out.append((name, suffix))
    return out


def _parse_branch_suffix(suffix: Optional[str]) -> dict:
    result: dict[str, Optional[int]] = {}
    if not suffix:
        return result
    for key in ("mispreds", "count", "inferred count"):
        m = re.search(re.escape(key) + r": (\d+)", suffix)
        if m:
            value = int(m.group(1))
            if key == "inferred count":
                result["inferred"] = value
            else:
                result[key] = value
    return result


def _parse_layout(value: str) -> list[str]:
    """Split the ``BB Layout`` value into block names.

    Entries end with ``/<digits>``; names may contain spaces and commas, so
    the split is anchored on the index suffix followed by a list separator.
    """
    names = re.findall(r"(.+?/\d+)(?:,\s+|$)", value)
    if names:
        return names
    return value.split(", ") if value else []


def _parse_instruction(line: str) -> Optional[Instruction]:
    m = _INST_RE.match(line)
    if not m:
        return None
    offset = int(m.group(1), 16)
    body = m.group(2)
    if body.startswith("\t"):
        body = body[1:]
    debug = None
    dm = _DEBUG_RE.search(body)
    if dm:
        debug = f"{dm.group(1)}:{dm.group(2)}"
        if dm.group(3):
            debug += f":{dm.group(3)}"
        body = body[: dm.start()]
    is_data = bool(re.match(r"^\s*\.(word|short|byte)\b", body))
    call_target = None
    call_count = None
    if not is_data:
        cm = _CALL_RE.match(body)
        if cm:
            target = cm.group(3) or cm.group(2)
            target = target.strip()
            if target.startswith('"') and target.endswith('"'):
                target = target[1:-1]
            # Local labels / raw addresses are intra-function branches.
            if target and not target.startswith(".") and not re.fullmatch(
                r"0x[0-9a-fA-F]+", target
            ):
                call_target = target
                ctm = _COUNT_RE.search(body)
                if ctm:
                    call_count = int(ctm.group(1))
    return Instruction(
        offset=offset,
        text=body.rstrip(),
        debug_line=debug,
        is_data=is_data,
        call_target=call_target,
        call_count=call_count,
    )


def parse_print_cfg(text: str) -> list[Function]:
    """Parse the output of ``llvm-bolt --print-cfg``."""
    lines = text.splitlines()
    functions: list[Function] = []
    i = 0
    total = len(lines)

    while i < total:
        line = lines[i]
        m = _FUNC_RE.match(line)
        if not m:
            i += 1
            continue

        func = Function(name=m.group(1))
        i += 1

        # ---- header --------------------------------------------------
        header: dict[str, str] = {}
        while i < total and lines[i] != "}":
            km = _KEY_RE.match(lines[i])
            if km:
                header[km.group(1).strip()] = km.group(2).strip()
            i += 1
        i += 1  # skip '}'

        func.address = int(header.get("Address", "0x0"), 16)
        func.size = int(header.get("Size", "0x0"), 16)
        func.bb_count = int(header.get("BB Count", "0"))
        func.is_simple = header.get("IsSimple", "1") not in ("0", "false")
        func.unknown_cf = "Unknown CF" in header
        if "Exec Count" in header:
            func.exec_count = int(header["Exec Count"])
        if "BB Layout" in header:
            func.layout = _parse_layout(header["BB Layout"])

        # ---- body ----------------------------------------------------
        known = func.layout or []
        block: Optional[Block] = None
        block_re = _BLOCK_RE

        while i < total:
            raw = lines[i]
            if raw.startswith('Binary Function "'):
                break
            i += 1

            if raw.startswith(_NOISE_PREFIXES):
                continue
            bm = block_re.match(raw)
            if bm:
                if block is not None:
                    func.blocks.append(block)
                block = Block(name=bm.group(1), alignment=int(bm.group(3)))
                if not known:
                    known.append(block.name)
                continue
            if block is None:
                continue

            if raw.startswith("  Exec Count "):
                value = raw.split(":", 1)[1].strip()
                block.exec_count = None if value == "<unknown>" else int(value)
            elif raw.startswith("  Entry Point"):
                block.entry = True
            elif raw.startswith("  CFI State : "):
                try:
                    block.cfi_state = int(raw.split(":", 1)[1])
                except ValueError:
                    pass
            elif raw.startswith("  Predecessors: "):
                entries = _split_name_list(raw[len("  Predecessors: ") :], known)
                block.preds = [name for name, _ in entries]
            elif raw.startswith("  Successors: "):
                entries = _split_name_list(raw[len("  Successors: ") :], known)
                for name, suffix in entries:
                    info = _parse_branch_suffix(suffix)
                    block.succs.append(
                        Successor(
                            target=name,
                            count=info.get("count"),
                            mispreds=info.get("mispreds"),
                            inferred=info.get("inferred"),
                        )
                    )
            elif raw.startswith("  Throwers: "):
                # Exception edges are not part of the normal CFG; ignore.
                pass
            elif raw.startswith("  Landing Pads: "):
                pass
            else:
                inst = _parse_instruction(raw)
                if inst is not None:
                    block.instructions.append(inst)

        if block is not None:
            func.blocks.append(block)
        functions.append(func)

    return functions
