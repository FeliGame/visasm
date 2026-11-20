from visasm.model import parse_print_cfg
from visasm.report import build_payload, strip_alias

SAMPLE = """BOLT-INFO: Target architecture: aarch64
Binary Function "main" after building cfg {
  Number      : 1
  State       : CFG constructed
  Address     : 0x1000
  Size        : 0x24
  MaxSize     : 0x24
  Offset      : 0x1000
  Section     : .text
  IsSimple    : 1
  BB Count    : 3
  BB Layout   : .LBB00, .LBB01, .LBB02
  Exec Count  : 10
  Sample Count: 25
  Profile Acc : 100.0%
}

.LBB00 (3 instructions, align : 1)
  Entry Point
  Exec Count : 10
  CFI State : 0
    00000000: 	stp	x29, x30, [sp, #-0x10]!
    00000004: 	!CFI	$0	; OpDefCfaOffset 16
    00000004: 	cbz	x0, .LBB02 # debug line demo.c:5:3
  Successors: .LBB02 (mispreds: 1, count: 4), .LBB01 (mispreds: 0, count: 6)
  CFI State: 1

.LBB01 (2 instructions, align : 1)
  Exec Count : <unknown>
  Predecessors: .LBB00
    00000008: 	mov	x0, #1
    0000000c: 	ret

.LBB02 (1 instructions, align : 1)
  Exec Count : 4
  Predecessors: .LBB00
    00000010: 	b	.LBB01
  Successors: .LBB01 (inferred count: 4)
"""


def test_parse_function_header_and_blocks():
    funcs = parse_print_cfg(SAMPLE)
    assert len(funcs) == 1
    fn = funcs[0]
    assert fn.name == "main"
    assert fn.address == 0x1000
    assert fn.size == 0x24
    assert fn.exec_count == 10
    assert fn.bb_count == 3
    assert fn.layout == [".LBB00", ".LBB01", ".LBB02"]
    assert len(fn.blocks) == 3

    entry = fn.blocks[0]
    assert entry.name == ".LBB00"
    assert entry.entry is True
    assert entry.exec_count == 10
    assert len(entry.instructions) == 3
    # CFI pseudo instruction is kept as text and marked by its opcode.
    assert entry.instructions[1].text.startswith("!CFI")
    assert entry.instructions[2].debug_line == "demo.c:5:3"

    assert entry.succs[0].target == ".LBB02"
    assert entry.succs[0].count == 4
    assert entry.succs[0].mispreds == 1
    assert entry.succs[1].count == 6

    cold = fn.blocks[1]
    assert cold.exec_count is None
    assert cold.preds == [".LBB00"]
    assert cold.succs == []

    inferred = fn.blocks[2].succs[0]
    assert inferred.target == ".LBB01"
    assert inferred.inferred == 4


def test_offsets_and_json():
    fn = parse_print_cfg(SAMPLE)[0]
    assert fn.blocks[0].offset == 0
    assert fn.blocks[1].offset == 8
    payload = build_payload([fn], "/tmp/demo", None)
    obj = payload["functions"][0]
    assert obj["blocks"][1]["addr"] == 0x1008
    assert obj["raw_name"] == "main"
    assert obj["flow"] == 14


def test_alias_suffix_is_stripped():
    assert strip_alias("mix/1(*2)") == "mix/1"
    assert strip_alias("main") == "main"


def test_name_splitting_with_commas():
    """Demangled names may contain spaces and commas."""
    text = """Binary Function "ns::foo<int, char>(*2)" after building cfg {
  Address     : 0x2000
  Size        : 0x10
  BB Count    : 2
  BB Layout   : ns::foo<int, char>/0, ns::foo<int, char>/1
  Exec Count  : 3
}
ns::foo<int, char>/0 (1 instructions, align : 1)
  Entry Point
  Exec Count : 3
  Predecessors: ns::foo<int, char>/1
    00000000: 	ret
  Successors: ns::foo<int, char>/1 (mispreds: 0, count: 3)

ns::foo<int, char>/1 (1 instructions, align : 1)
  Exec Count : 3
  Predecessors: ns::foo<int, char>/0
    00000004: 	b	ns::foo<int, char>/0
"""
    fn = parse_print_cfg(text)[0]
    assert fn.layout == ["ns::foo<int, char>/0", "ns::foo<int, char>/1"]
    assert len(fn.blocks) == 2
    assert fn.blocks[0].succs[0].target == "ns::foo<int, char>/1"
    assert fn.blocks[1].preds == ["ns::foo<int, char>/0"]


CALL_SAMPLE = """Binary Function "caller" after building cfg {
  Address     : 0x1000
  Size        : 0x10
  BB Count    : 1
  BB Layout   : caller/0
}
caller/0 (3 instructions, align : 1)
  Entry Point
  Exec Count : 4
    00000000: 	bl	"mix/1" # Count: 3
    00000004: 	bl	printf@PLT # Count: 2 # debug line demo.c:9:5
    00000008: 	b	.LBB01
"""


def test_parse_call_targets():
    fn = parse_print_cfg(CALL_SAMPLE)[0]
    ins = fn.blocks[0].instructions
    assert ins[0].call_target == "mix/1"
    assert ins[0].call_count == 3
    assert ins[1].call_target == "printf@PLT"
    assert ins[1].call_count == 2
    assert ins[1].debug_line == "demo.c:9:5"
    # local branches are not calls
    assert ins[2].call_target is None
    assert ins[2].call_count is None


def test_callgraph_payload():
    fn = parse_print_cfg(CALL_SAMPLE)[0]
    payload = build_payload([fn], "/tmp/demo", None)
    cg = payload["callgraph"]
    assert cg["defined"] == 1
    assert cg["external"] == 2

    edges = {(e["source"], e["target"]): e["count"] for e in cg["edges"]}
    assert edges[("caller", "mix/1")] == 3
    assert edges[("caller", "printf@PLT")] == 2

    nodes = {n["id"]: n for n in cg["nodes"]}
    assert nodes["caller"]["external"] is False
    assert nodes["caller"]["fn"] == 0
    assert nodes["printf@PLT"]["external"] is True
    assert payload["summary"]["call_edges"] == 2
    assert payload["summary"]["external_symbols"] == 2

    obj = payload["functions"][0]
    call_inst = obj["blocks"][0]["insts"][0]
    assert call_inst["call"] == "mix/1"
    assert call_inst["call_count"] == 3
