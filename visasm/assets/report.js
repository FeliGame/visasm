(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const SVGNS = "http://www.w3.org/2000/svg";

  const FUNCS = DATA.functions;
  const functionIndices = new Map(FUNCS.map((fn, index) => [fn, index]));
  const HOT_LOG = Math.log1p(DATA.hot_max || 1);

  let query = "";
  let sortKey = "hot";
  let sortDir = -1;
  let current = -1;
  let selected = null;
  let sourceOpen = false;
  let activeView = "overview";
  let parentView = "overview";
  let parentFunction = -1;
  const functionsOpen = { callgraph: true, function: true };
  const inspectorOpen = { callgraph: true, function: true };
  const compactPanels = { callgraph: null, function: null };
  const compact = window.matchMedia("(max-width: 900px)");
  const graphs = {
    callgraph: { svg: $("#cg"), canvas: $("#cg-canvas"), nodeClass: ".cg-node", min: 0.05, max: 4, fitMax: 1.6 },
    function: { svg: $("#cfg"), canvas: $("#canvas"), nodeClass: ".bb", min: 0.1, max: 3.5, fitMax: 1.4 },
  };

  // ---------------------------------------------------------------- utils
  const fmt = (n) => {
    if (n === null || n === undefined) return "\u2014";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "G";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e4) return (n / 1e3).toFixed(1) + "k";
    return n.toLocaleString();
  };
  const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + "\u2026" : s);
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const STOPS = [
    [0.0, [226, 234, 244]],
    [0.38, [122, 170, 230]],
    [0.72, [245, 172, 68]],
    [1.0, [225, 62, 50]],
  ];
  function heat(t) {
    if (!(t > 0)) return "#e9eef5";
    let i = 1;
    while (i < STOPS.length - 1 && t > STOPS[i][0]) i++;
    const [t0, c0] = STOPS[i - 1];
    const [t1, c1] = STOPS[i];
    const u = (t - t0) / (t1 - t0);
    const c = c0.map((v, j) => Math.round(v + (c1[j] - v) * u));
    return `rgb(${c[0]} ${c[1]} ${c[2]})`;
  }
  const heatOf = (count) => heat(count ? Math.log1p(count) / HOT_LOG : 0);

  // ------------------------------------------------------------- sidebar
  const hotOrder = FUNCS.slice().sort((a, b) => (b.hot || 0) - (a.hot || 0));

  function filtered(items) {
    if (!query) return items.slice();
    try {
      const re = new RegExp(query, "i");
      return items.filter((f) => re.test(f.raw_name) || re.test(f.display));
    } catch {
      return items.filter((f) => f.display.toLowerCase().includes(query.toLowerCase()));
    }
  }

  function renderMeta() {
    const s = DATA.summary;
    $("#report-name").textContent = DATA.title;
    $("#report-name").title = DATA.binary;
    document.title = `visasm · ${DATA.title}`;
    $("#summary").innerHTML = [
      ["Functions", fmt(s.functions)],
      ["Profiled functions", fmt(s.matched_functions)],
      ["Basic blocks", fmt(s.blocks)],
      ["Hottest BB", fmt(s.hottest_block)],
    ]
      .map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`)
      .join("");
  }

  function renderList() {
    const source = hotOrder.filter((fn) => cgGeom.byId.has(fn.raw_name));
    const items = filtered(source);
    const box = $("#funclist");
    box.innerHTML = "";
    const frag = document.createDocumentFragment();
    items.slice(0, 600).forEach((fn) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "funcrow";
      row.dataset.id = fn.raw_name;
      row.innerHTML =
        `<span class="name" title="${esc(fn.display)}">${esc(fn.display)}</span>` +
        `<span class="cnt" title="Hottest basic block">${fmt(fn.hot)}</span>`;
      row.addEventListener("click", () => selectCGNode(fn.raw_name));
      frag.appendChild(row);
    });
    if (!items.length || items.length > 600) {
      const note = document.createElement("p");
      note.className = "empty";
      note.textContent = items.length ? `${fmt(items.length - 600)} more functions. Refine the filter to find them.` : "No matching functions";
      frag.appendChild(note);
    }
    box.appendChild(frag);
    highlightList();
  }

  function highlightList() {
    document.querySelectorAll("#funclist .funcrow").forEach((row) => {
      const isSelected = row.dataset.id === cgSelected;
      row.classList.toggle("selected", isSelected);
      row.setAttribute("aria-pressed", String(isSelected));
    });
  }

  // ------------------------------------------------------------ overview
  function renderOverview() {
    const items = filtered(FUNCS);
    const key = sortKey;
    const val = (f) => {
      if (key === "name") return f.display.toLowerCase();
      if (key === "entry") return f.exec_count || 0;
      if (key === "blocks") return f.bb_count;
      if (key === "acc") return f.profile_acc == null ? -1 : f.profile_acc;
      return key === "flow" ? f.flow : f.hot || 0;
    };
    items.sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va < vb) return -1 * sortDir;
      if (va > vb) return 1 * sortDir;
      return a.display.localeCompare(b.display);
    });
    const body = $("#overview-body");
    body.innerHTML = "";
    const frag = document.createDocumentFragment();
    items.slice(0, 1500).forEach((fn) => {
      const tr = document.createElement("tr");
      const index = functionIndices.get(fn);
      tr.dataset.function = index;
      tr.innerHTML =
        `<td class="fname"><button type="button" title="${esc(fn.display)}"><span class="heatcell" aria-hidden="true" style="background:${heatOf(fn.hot)}"></span>${esc(short(fn.display, 70))}</button></td>` +
        `<td class="num">${fmt(fn.hot)}</td>` +
        `<td class="num">${fmt(fn.flow)}</td>` +
        `<td class="num">${fmt(fn.exec_count)}</td>` +
        `<td class="num">${fn.bb_count}</td>` +
        `<td class="num">${fn.profile_acc == null ? "\u2014" : fn.profile_acc.toFixed(0) + "%"}</td>`;
      tr.addEventListener("click", () => showFunction(index));
      frag.appendChild(tr);
    });
    if (!items.length || items.length > 1500) {
      const row = document.createElement("tr");
      const cell = row.insertCell();
      cell.colSpan = 6;
      cell.className = "empty";
      cell.textContent = items.length ? `${fmt(items.length - 1500)} more functions. Refine the filter to find them.` : "No matching functions";
      frag.appendChild(row);
    }
    body.appendChild(frag);
  }

  // -------------------------------------------------------------- layout
  function computeLayout(fn) {
    const blocks = fn.blocks;
    const n = blocks.length;
    const idx = new Map(blocks.map((b, i) => [b.name, i]));
    const succ = blocks.map((b) => b.succs.map((s) => idx.get(s.target)).filter((v) => v !== undefined));
    const pred = blocks.map(() => []);
    succ.forEach((ss, i) => ss.forEach((j) => pred[j].push(i)));

    // DFS to find back edges (edges into the current DFS stack).
    const color = new Array(n).fill(0);
    const back = new Set();
    const all = [];
    const entry = Math.max(0, blocks.findIndex((b) => b.entry));
    const order = [entry, ...Array.from({ length: n }, (_, i) => i)];
    const dfs = (u) => {
      color[u] = 1;
      for (const v of succ[u]) {
        if (color[v] === 1) back.add(u + ">" + v);
        else if (color[v] === 0) dfs(v);
      }
      color[u] = 2;
      all.push(u);
    };
    order.forEach((r) => { if (color[r] === 0) dfs(r); });
    const topo = all.reverse();

    // rank = longest path over the acyclic part
    const dagSucc = succ.map((ss, i) => ss.filter((j) => !back.has(i + ">" + j)));
    const rank = new Array(n).fill(0);
    for (const u of topo) {
      for (const v of dagSucc[u]) rank[v] = Math.max(rank[v], rank[u] + 1);
    }
    let maxRank = rank.reduce((a, b) => Math.max(a, b), 0);
    const reached = new Array(n).fill(false);
    const q = [entry];
    reached[entry] = true;
    while (q.length) {
      const u = q.shift();
      for (const v of succ[u]) if (!reached[v]) { reached[v] = true; q.push(v); }
    }
    for (let i = 0; i < n; i++) if (!reached[i]) rank[i] = maxRank + 1;

    // layers
    let layers = [];
    for (let i = 0; i < n; i++) {
      (layers[rank[i]] = layers[rank[i]] || []).push(i);
    }
    layers = layers.filter(Boolean);
    layers.forEach((l) => l.sort((a, b) => a - b));

    // barycenter ordering
    const pos = new Array(n).fill(0);
    const reindex = () => layers.forEach((l) => l.forEach((v, i) => (pos[v] = i)));
    reindex();
    for (let it = 0; it < 6; it++) {
      const down = it % 2 === 0;
      const seq = down ? layers.slice(1) : layers.slice(0, -1).reverse();
      seq.forEach((layer) => {
        const score = new Map();
        layer.forEach((v) => {
          const nbrs = down ? pred[v] : succ[v];
          const vals = nbrs.filter((u) => rank[u] !== rank[v]).map((u) => pos[u]);
          score.set(v, vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : pos[v]);
        });
        layer.sort((a, b) => score.get(a) - score.get(b) || a - b);
      });
      reindex();
    }

    const NW = 250, NH = 62, GX = 56, GY = 108;
    const width = layers.reduce((m, l) => Math.max(m, l.length * (NW + GX) - GX), 0);
    const nodes = new Map();
    const maxLayer = layers.length - 1;
    layers.forEach((layer, r) => {
      const w = layer.length * (NW + GX) - GX;
      const off = (width - w) / 2;
      layer.forEach((v, i) => {
        nodes.set(v, { x: off + i * (NW + GX), y: r * (NH + GY) + 40, w: NW, h: NH });
      });
    });

    return {
      nodes, layers, rank, back, succ, pred, n,
      maxLayer,
      bbox: { x: -10, y: 20, w: width + 70, h: maxLayer * (NH + GY) + NH + 64 },
      NW, NH,
    };
  }

  // ------------------------------------------------------------------ cfg
  function edgePath(a, b, isBack) {
    const sx = a.x + a.w / 2, sy = a.y + a.h;
    const tx = b.x + b.w / 2, ty = b.y;
    if (isBack || ty <= sy) {
      const dx = Math.max(a.x + a.w, b.x + b.w) + 70;
      return {
        d: `M ${sx} ${sy} C ${dx} ${sy + 30}, ${dx} ${ty - 30}, ${tx} ${ty}`,
        mid: { x: (sx + tx) / 2 + 40, y: (sy + ty) / 2 },
      };
    }
    const dy = (ty - sy) * 0.5;
    return {
      d: `M ${sx} ${sy} C ${sx} ${sy + dy}, ${tx} ${ty - dy}, ${tx} ${ty}`,
      mid: { x: (sx + tx) / 2, y: (sy + ty) / 2 },
    };
  }

  function renderCfg(fn) {
    const g = $("#canvas");
    g.innerHTML = "";
    if (!fn.blocks.length) {
      graphs.function.bbox = null;
      return;
    }
    const geom = computeLayout(fn);

    // edges first
    const edgeLayer = document.createElementNS(SVGNS, "g");
    g.appendChild(edgeLayer);
    const nodeLayer = document.createElementNS(SVGNS, "g");
    g.appendChild(nodeLayer);

    fn.blocks.forEach((B, i) => {
      const a = geom.nodes.get(i);
      if (!a) return;
      B.succs.forEach((S) => {
        const j = fn.blocks.findIndex((b) => b.name === S.target);
        if (j < 0) return;
        const b = geom.nodes.get(j);
        if (!b) return;
        const back = geom.back.has(i + ">" + j) || geom.rank[j] <= geom.rank[i];
        const p = edgePath(a, b, back);
        const cnt = S.count == null ? S.inferred : S.count;
        const t = cnt ? Math.log1p(cnt) / HOT_LOG : 0;
        const path = document.createElementNS(SVGNS, "path");
        path.setAttribute("d", p.d);
        path.setAttribute("class", "edge" + (back ? " back" : "") + (t > 0.45 ? " hot" : ""));
        path.setAttribute("marker-end", t > 0.45 ? "url(#arrow-hot)" : "url(#arrow)");
        path.setAttribute("stroke-width", (1.1 + 3.4 * t).toFixed(2));
        path.setAttribute("opacity", (0.55 + 0.45 * t).toFixed(2));
        path.setAttribute("stroke", t > 0 ? heat(t) : "#b9c5d5");
        edgeLayer.appendChild(path);

        if (cnt != null && cnt > 0) {
          const label = document.createElementNS(SVGNS, "text");
          label.setAttribute("class", "edge-label");
          label.setAttribute("x", p.mid.x);
          label.setAttribute("y", p.mid.y);
          label.setAttribute("text-anchor", "middle");
          label.textContent = fmt(cnt);
          edgeLayer.appendChild(label);
        }
      });
    });

    const fnHot = Math.max(1, fn.hot || 0);
    fn.blocks.forEach((B, i) => {
      const a = geom.nodes.get(i);
      if (!a) return;
      const node = document.createElementNS(SVGNS, "g");
      node.setAttribute("class", "bb" + (selected === B.name ? " selected" : ""));
      node.setAttribute("data-name", B.name);
      node.style.cursor = "pointer";

      const rect = document.createElementNS(SVGNS, "rect");
      rect.setAttribute("x", a.x);
      rect.setAttribute("y", a.y);
      rect.setAttribute("width", a.w);
      rect.setAttribute("height", a.h);
      rect.setAttribute("fill", heatOf(B.count));
      node.appendChild(rect);

      const name = document.createElementNS(SVGNS, "text");
      name.setAttribute("class", "name");
      name.setAttribute("x", a.x + 12);
      name.setAttribute("y", a.y + 22);
      name.textContent = short(B.name, 30);
      node.appendChild(name);

      if (B.entry) {
        const badge = document.createElementNS(SVGNS, "text");
        badge.setAttribute("class", "entrybadge");
        badge.setAttribute("x", a.x + a.w - 12);
        badge.setAttribute("y", a.y + 22);
        badge.setAttribute("text-anchor", "end");
        badge.textContent = "ENTRY";
        node.appendChild(badge);
      }

      const meta = document.createElementNS(SVGNS, "text");
      meta.setAttribute("class", "meta");
      meta.setAttribute("x", a.x + 12);
      meta.setAttribute("y", a.y + 39);
      meta.textContent = `+0x${B.offset.toString(16)}  ·  ${B.insts.length} insns`;
      node.appendChild(meta);

      const cnt = document.createElementNS(SVGNS, "text");
      cnt.setAttribute("class", "count");
      cnt.setAttribute("x", a.x + 12);
      cnt.setAttribute("y", a.y + 55);
      const share = B.count && fnHot ? ((B.count / fnHot) * 100).toFixed(1) + "%" : "";
      cnt.textContent = `${fmt(B.count)}${share ? "  ·  " + share : ""}`;
      node.appendChild(cnt);

      node.addEventListener("click", (e) => {
        e.stopPropagation();
        selectBlock(fn, B.name, true);
        revealInspector();
      });
      nodeLayer.appendChild(node);
    });

    graphs.function.bbox = geom.bbox;
    fitGraph(graphs.function);
  }

  // -------------------------------------------------------------- detail
  let instructionIndex = null;
  const isCFI = (inst) => /^\s*!CFI\b/.test(inst.text);
  const hex = (address) => "0x" + address.toString(16);
  const directBranch = /^(?:b(?:\.[a-z]+|l|lx|eq|ne|lt|le|gt|ge|cs|cc|hs|lo|hi|ls|mi|pl|vs|vc)?|cbn?z|tbn?z|j[a-z]*|loop[a-z]*|callq?|tail|beqz?|bnez?|bgez?|bltz?|bgtz?|blez?|bgeu|bltu)$/i;

  function indexInstructions() {
    const addresses = new Map();
    const symbols = new Map();
    const blocks = FUNCS.map((fn, fnIndex) => {
      const labels = new Map();
      for (const block of fn.blocks) {
        for (const inst of block.insts) {
          if (inst.data || isCFI(inst)) continue;
          const destination = { fnIndex, block, address: inst.addr };
          if (!labels.has(block.name)) labels.set(block.name, destination);
          if (!addresses.has(inst.addr)) addresses.set(inst.addr, destination);
          if (inst.addr === fn.address) {
            symbols.set(fn.raw_name, destination);
            symbols.set(fn.name, destination);
          }
        }
      }
      const entry = labels.get(fn.blocks.find((block) => block.entry)?.name);
      if (entry && !symbols.has(fn.raw_name)) symbols.set(fn.raw_name, entry);
      return labels;
    });
    return { addresses, symbols, blocks };
  }

  function assemblyOperand(inst, block, token, target) {
    const name = token.replace(/^"|"$/g, "");
    const local = instructionIndex.blocks[current].get(name);
    if (local) return local;

    const { addresses } = instructionIndex;
    const boltSymbol = name.match(/^SYMBOLat(0x[\da-f]+)$/i);
    if (boltSymbol) return addresses.get(Number(boltSymbol[1]));
    if (target !== token) return null;
    const symbol = instructionIndex.symbols.get(name);
    if (symbol) return symbol;
    if (!/^(?:#[+-]?(?:0x[\da-f]+|\d+)|0x[\da-f]+|\d[\da-f]+)$/i.test(token)) return null;

    if (!token.startsWith("#")) return addresses.get(parseInt(token, 16));
    const value = parseInt(token.slice(1), 0);
    // ARM's printed immediates are relative; a CFG edge can disambiguate absolute spellings.
    const relative = addresses.get(inst.addr + value);
    const absolute = addresses.get(value);
    const isSuccessor = (destination) => destination?.fnIndex === current &&
      block.succs.some((edge) => edge.target === destination.block.name);
    return isSuccessor(relative) ? relative : isSuccessor(absolute) ? absolute : relative;
  }

  function renderInstruction(inst, block) {
    const match = inst.text.match(/^(\s*(\S+)\s+)(.*?)(\s+#\s+.*)?$/);
    if (!match || inst.data || isCFI(inst)) return esc(inst.text);
    const [, prefix, mnemonic, operands, comment = ""] = match;
    const addressOperand = directBranch.test(mnemonic) || /^(?:adr|lea[qwl]?)$/i.test(mnemonic);
    const target = addressOperand ? operands.replace(/\s+<[^>]+>\s*$/, "").split(",").pop().trim() : null;
    let cursor = 0;
    let html = esc(prefix);
    for (const token of operands.matchAll(/"[^"]+"|#[+-]?(?:0x[\da-f]+|\d+)|[\w.$][\w.$@/]*/gi)) {
      const dest = assemblyOperand(inst, block, token[0], target);
      if (!dest) continue;
      html += esc(operands.slice(cursor, token.index));
      html += `<button type="button" class="asm-link" data-fn="${dest.fnIndex}" data-block="${esc(dest.block.name)}" data-target="${dest.address}" title="Jump to ${hex(dest.address)}">${esc(token[0])}</button>`;
      cursor = token.index + token[0].length;
    }
    return html + esc(operands.slice(cursor)) + esc(comment);
  }

  function renderSource(block) {
    const entries = new Map();
    const addressLinks = new Map();
    for (const inst of block.insts) {
      const location = inst.debug?.match(/^(.+?):([1-9]\d*)(?::(\d+))?$/);
      if (!location || inst.data || isCFI(inst)) continue;
      const [, name, line, column] = location;
      const file = DATA.instruction_files?.[inst.addr] ?? name;
      const key = `${file}:${line}`;
      if (!entries.has(key)) entries.set(key, { file, line, addresses: [] });
      const entry = entries.get(key);
      entry.addresses.push(inst.addr);
      addressLinks.set(inst.addr, `${key}${column ? ":" + column : ""}`);
    }
    const body = $("#source-body");
    body.innerHTML = [...entries.values()].map(({ file, line, addresses }) => {
      const name = file.replace(/^.*[\\/]/, "");
      const code = DATA.source_lines?.[file]?.[line];
      const buttons = addresses.map((address) => `<button type="button" class="chip" data-address="${address}" title="Go to instruction ${hex(address)}">${hex(address)}</button>`).join("");
      return `<div class="source-entry"><p class="source-location" title="${esc(file)}">${esc(name)}:${line}</p>` +
        (typeof code === "string" ? `<pre class="source-code"><code>${esc(code)}</code></pre>` : "") +
        `<div class="source-addresses">${buttons}</div></div>`;
    }).join("") || '<p class="empty">No source lines for this block</p>';
    body.scrollTop = 0;
    return addressLinks;
  }

  function highlightInstruction(address, showSource) {
    const asm = $("#asm");
    const row = asm.querySelector(`[data-address="${address}"]`);
    if (!row) return;
    asm.querySelector(".address-selected")?.classList.remove("address-selected");
    row.classList.add("address-selected");

    const source = $("#source-body");
    source.querySelector(".selected")?.classList.remove("selected");
    const entry = source.querySelector(`[data-address="${address}"]`)?.closest(".source-entry");
    entry?.classList.add("selected");
    if (showSource) {
      sourceOpen = true;
      updateSourcePanel();
      entry?.scrollIntoView({ block: "nearest", inline: "nearest" });
    } else {
      row.focus({ preventScroll: true });
    }
    row.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function selectBlock(fn, name, scroll) {
    const B = fn.blocks.find((b) => b.name === name);
    if (!B) return;
    selected = name;
    document.querySelectorAll(".bb, #blocklist button").forEach((el) => {
      const isSelected = el.dataset.name === name;
      el.classList.toggle("selected", isSelected);
      if (el.tagName === "BUTTON") el.setAttribute("aria-pressed", String(isSelected));
    });
    const head = $("#detail-head");
    const edges = $("#detail-edges");
    const asm = $("#asm");
    const share = B.count && fn.blocks.length ? ((B.count / Math.max(1, fn.hot || 0)) * 100).toFixed(1) : null;
    head.innerHTML =
      `<div class="bname">${esc(B.name)}</div>` +
      `<div class="sub">0x${B.addr.toString(16)} &nbsp;·&nbsp; +0x${B.offset.toString(16)} &nbsp;·&nbsp; ` +
      `<span class="hot">${fmt(B.count)}</span> ${B.count === 1 ? "execution" : "executions"}${share ? " (" + share + "% of hottest BB)" : ""}</div>`;
    const chip = (n, c) => `<button type="button" class="chip" data-jump="${esc(n)}">${esc(n)}${c == null ? "" : " · " + fmt(c)}</button>`;
    const group = (label, items) => items.length ? `<div class="edge-group"><b>${label}</b>${items.join("")}</div>` : "";
    edges.innerHTML = group("Predecessors", B.preds.map((p) => chip(p, null))) +
      group("Successors", B.succs.map((s) => chip(s.target, s.count ?? s.inferred)));

    instructionIndex ??= indexInstructions();
    const sourceLinks = renderSource(B);
    asm.innerHTML = `<table>${B.insts.map((inst) => {
      const cfi = isCFI(inst);
      const address = hex(inst.addr);
      const source = cfi ? null : sourceLinks.get(inst.addr);
      const label = source ? `<button type="button" class="asm-link" data-source="${inst.addr}" title="${esc(source)}">${address}</button>` : address;
      return `<tr${cfi ? ' class="cfi"' : ` data-address="${inst.addr}" tabindex="-1"`}><td class="addr">${label}</td>` +
        `<td class="insn">${renderInstruction(inst, B)}</td></tr>`;
    }).join("")}</table>`;
    if (scroll) {
      asm.scrollTop = 0;
      asm.scrollLeft = 0;
    }
  }

  // ----------------------------------------------------------- callgraph
  const CG = DATA.callgraph || { nodes: [], edges: [], max_edge: 0, defined: 0, external: 0 };
  const callNodes = new Map(CG.nodes.map((node) => [node.id, node]));
  const CG_LIMIT = 350;
  let cgGeom = null;
  let cgSelected = null;

  function makeRng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function cgBuild() {
    const showExt = $("#cg-external").checked;
    const defs = CG.nodes
      .filter((n) => !n.external)
      .sort((a, b) => (b.hot || 0) - (a.hot || 0));
    const keep = new Set(defs.slice(0, CG_LIMIT).map((n) => n.id));
    const nodes = defs.filter((n) => keep.has(n.id)).slice();
    const byId = new Map(nodes.map((n) => [n.id, n]));

    if (showExt) {
      const used = new Set();
      CG.edges.forEach((e) => {
        if (keep.has(e.source)) used.add(e.target);
      });
      CG.nodes
        .filter((n) => n.external && used.has(n.id))
        .forEach((n) => {
          nodes.push(n);
          byId.set(n.id, n);
        });
    }

    const edges = CG.edges.filter((e) => byId.has(e.source) && byId.has(e.target));
    return { nodes, edges, byId };
  }

  function cgRunLayout(nodes, edges) {
    const n = nodes.length;
    const maxHot = Math.max(1, ...nodes.map((d) => d.hot || 0));
    const hotLog = Math.log1p(maxHot);
    nodes.forEach((d) => {
      d.r = d.external ? 8 : 8 + 14 * Math.sqrt(Math.log1p(d.hot || 0) / hotLog);
    });
    if (!n) return;

    const idx = new Map(nodes.map((d, i) => [d.id, i]));
    const E = edges
      .map((e) => ({ a: idx.get(e.source), b: idx.get(e.target) }))
      .filter((e) => e.a != null && e.b != null && e.a !== e.b);

    const area = 9000 * Math.max(12, n);
    const k = Math.sqrt(area / n);
    const R = Math.sqrt(area) / 2;
    const rng = makeRng(20240617);
    const pos = nodes.map(() => ({
      x: (rng() - 0.5) * R * 1.6,
      y: (rng() - 0.5) * R * 1.6,
    }));
    const disp = pos.map(() => ({ x: 0, y: 0 }));
    let temp = R / 3;
    const iters = n > 300 ? 170 : 250;

    for (let it = 0; it < iters; it++) {
      disp.forEach((d) => {
        d.x = 0;
        d.y = 0;
      });
      // pairwise repulsion
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let dx = pos[i].x - pos[j].x;
          let dy = pos[i].y - pos[j].y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) {
            dx = (rng() - 0.5) * 0.2;
            dy = (rng() - 0.5) * 0.2;
            d2 = dx * dx + dy * dy + 0.01;
          }
          const d = Math.sqrt(d2);
          const f = (k * k) / d;
          disp[i].x += (dx / d) * f;
          disp[i].y += (dy / d) * f;
          disp[j].x -= (dx / d) * f;
          disp[j].y -= (dy / d) * f;
        }
      }
      // edge attraction
      E.forEach((e) => {
        const dx = pos[e.a].x - pos[e.b].x;
        const dy = pos[e.a].y - pos[e.b].y;
        const d = Math.max(0.01, Math.hypot(dx, dy));
        const f = (d * d) / k;
        disp[e.a].x -= (dx / d) * f;
        disp[e.a].y -= (dy / d) * f;
        disp[e.b].x += (dx / d) * f;
        disp[e.b].y += (dy / d) * f;
      });
      // gravity keeps disconnected components in one view
      for (let i = 0; i < n; i++) {
        disp[i].x -= pos[i].x * 0.04 * k;
        disp[i].y -= pos[i].y * 0.04 * k;
      }
      // move, then cool down
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(disp[i].x, disp[i].y);
        if (d > 0) {
          const s = Math.min(d, temp) / d;
          pos[i].x += disp[i].x * s;
          pos[i].y += disp[i].y * s;
        }
      }
      temp = Math.max(k * 0.02, temp * 0.97);
    }

    let cx = 0, cy = 0;
    pos.forEach((p) => {
      cx += p.x;
      cy += p.y;
    });
    cx /= n;
    cy /= n;
    nodes.forEach((d, i) => {
      d.x = pos[i].x - cx;
      d.y = pos[i].y - cy;
    });
  }

  function cgBBox(nodes) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    nodes.forEach((d) => {
      x0 = Math.min(x0, d.x - d.r - 4);
      y0 = Math.min(y0, d.y - d.r - 4);
      x1 = Math.max(x1, d.x + d.r + 4);
      y1 = Math.max(y1, d.y + d.r + 18);
    });
    if (!isFinite(x0)) return { x: 0, y: 0, w: 10, h: 10 };
    return { x: x0, y: y0, w: Math.max(10, x1 - x0), h: Math.max(10, y1 - y0) };
  }

  function renderCallGraph() {
    const built = cgBuild();
    const nodes = built.nodes;
    const edges = built.edges;
    const byId = built.byId;
    cgRunLayout(nodes, edges);

    const g = $("#cg-canvas");
    g.innerHTML = "";
    const labelLayer = document.createElementNS(SVGNS, "g");
    const edgeLayer = document.createElementNS(SVGNS, "g");
    const nodeLayer = document.createElementNS(SVGNS, "g");
    g.appendChild(edgeLayer);
    g.appendChild(labelLayer);
    g.appendChild(nodeLayer);

    const maxEdge = Math.max(1, CG.max_edge || 1);
    const edgeLog = Math.log1p(maxEdge);
    const labelOn = $("#cg-labels").checked;
    const labelElems = [];
    const pairs = new Set(edges.map((e) => e.source + "\u0000" + e.target));

    edges.forEach((e) => {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (!a || !b) return;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.max(0.01, Math.hypot(dx, dy));
      const ux = dx / dist, uy = dy / dist;
      const ax = a.x + ux * (a.r + 1), ay = a.y + uy * (a.r + 1);
      const bx = b.x - ux * (b.r + 4), by = b.y - uy * (b.r + 4);
      const t = e.count ? Math.log1p(e.count) / edgeLog : 0;

      let d, mx, my;
      if (a === b) {
        const rr = a.r + 14;
        d = `M ${a.x - a.r * 0.6} ${a.y - a.r * 0.8} A ${rr} ${rr} 0 1 1 ${a.x + a.r * 0.6} ${a.y - a.r * 0.8}`;
        mx = a.x;
        my = a.y - a.r - rr;
      } else if (pairs.has(e.target + "\u0000" + e.source)) {
        const off = Math.min(46, dist * 0.18);
        const gx = (a.x + b.x) / 2 - uy * off;
        const gy = (a.y + b.y) / 2 + ux * off;
        d = `M ${ax} ${ay} Q ${gx} ${gy} ${bx} ${by}`;
        mx = (ax + 2 * gx + bx) / 4;
        my = (ay + 2 * gy + by) / 4;
      } else {
        d = `M ${ax} ${ay} L ${bx} ${by}`;
        mx = (ax + bx) / 2;
        my = (ay + by) / 2;
      }

      const path = document.createElementNS(SVGNS, "path");
      path.setAttribute("d", d);
      path.setAttribute("class", "cg-edge" + (t > 0.6 ? " hot" : ""));
      path.setAttribute("marker-end", "url(#cg-arrow)");
      path.style.strokeWidth = (0.8 + 3.4 * t).toFixed(2);
      path.style.opacity = (0.3 + 0.55 * t).toFixed(2);
      path.style.stroke = t > 0.25 ? heat(t) : "#9fb0c6";
      path.dataset.src = e.source;
      path.dataset.dst = e.target;
      path.dataset.op = path.style.opacity;
      path.dataset.w = path.style.strokeWidth;
      const title = document.createElementNS(SVGNS, "title");
      title.textContent = `${a.display} \u2192 ${b.display}\n${fmt(e.count)} calls (${e.sites} site${e.sites === 1 ? "" : "s"})`;
      path.appendChild(title);
      edgeLayer.appendChild(path);

      const label = document.createElementNS(SVGNS, "text");
      label.setAttribute("class", "cg-edge-label");
      label.setAttribute("x", mx);
      label.setAttribute("y", my);
      label.setAttribute("text-anchor", "middle");
      label.textContent = fmt(e.count);
      if (!labelOn) label.style.display = "none";
      labelElems.push(label);
      labelLayer.appendChild(label);
    });

    let labelIds = null;
    if (nodes.length > 160) {
      labelIds = new Set(
        nodes
          .slice()
          .sort((a, b) => (b.hot || 0) - (a.hot || 0))
          .slice(0, 70)
          .map((n) => n.id)
      );
    }
    const maxHot = Math.max(1, ...nodes.map((n) => n.hot || 0));
    const hotLog = Math.log1p(maxHot);

    nodes.forEach((d) => {
      const grp = document.createElementNS(SVGNS, "g");
      grp.setAttribute("class", "cg-node" + (d.external ? " ext" : ""));
      grp.dataset.id = d.id;
      grp.style.cursor = "pointer";

      const circle = document.createElementNS(SVGNS, "circle");
      circle.setAttribute("cx", d.x);
      circle.setAttribute("cy", d.y);
      circle.setAttribute("r", d.r.toFixed(1));
      circle.setAttribute(
        "fill",
        d.external ? "#eef1f6" : heat(d.hot ? Math.log1p(d.hot) / hotLog : 0)
      );
      grp.appendChild(circle);

      const text = document.createElementNS(SVGNS, "text");
      text.setAttribute("x", d.x);
      text.setAttribute("y", d.y + d.r + 11);
      text.setAttribute("text-anchor", "middle");
      text.textContent = short(d.display, 24);
      if (labelIds && !labelIds.has(d.id)) text.style.display = "none";
      grp.appendChild(text);

      const title = document.createElementNS(SVGNS, "title");
      title.textContent = d.external
        ? `${d.display}\nexternal symbol \u00b7 ${d.sites} call sites`
        : `${d.display}\n hottest BB ${fmt(d.hot)} \u00b7 ${d.bb_count} BBs \u00b7 entries ${fmt(d.exec_count)}`;
      grp.appendChild(title);

      grp.addEventListener("click", (ev) => {
        ev.stopPropagation();
        selectCGNode(d.id);
      });
      grp.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        if (d.fn >= 0) showFunction(d.fn);
      });
      nodeLayer.appendChild(grp);
    });

    cgGeom = { byId, labelIds, labelElems };
    graphs.callgraph.bbox = nodes.length ? cgBBox(nodes) : null;
    $("#cg-empty").hidden = nodes.length > 0;

    const shownDefined = nodes.filter((n) => !n.external).length;
    const shownExternal = nodes.length - shownDefined;
    const totalDefined = CG.defined || shownDefined;
    $("#cg-stat").textContent =
      `${fmt(shownDefined)}${shownDefined < totalDefined ? "/" + fmt(totalDefined) : ""} functions` +
      (shownExternal ? ` + ${fmt(shownExternal)} external` : "") +
      ` · ${fmt(edges.length)} edges`;

    if (callNodes.get(cgSelected)?.external && !byId.has(cgSelected)) cgSelected = null;
    renderList();
    renderCallDetails();
    updatePanels();
    fitGraph(graphs.callgraph);
  }

  function highlightCG() {
    const id = cgSelected;
    const near = new Set();
    if (id) {
      CG.edges.forEach((e) => {
        if (e.source === id) near.add(e.target);
        if (e.target === id) near.add(e.source);
      });
    }
    document.querySelectorAll("#cg-canvas .cg-edge").forEach((el) => {
      const conn = !id || el.dataset.src === id || el.dataset.dst === id;
      el.style.opacity = id ? (conn ? "0.95" : "0.06") : el.dataset.op;
      el.style.strokeWidth = conn && id
        ? (parseFloat(el.dataset.w) + 0.8).toFixed(2)
        : el.dataset.w;
    });
    document.querySelectorAll("#cg-canvas .cg-node").forEach((el) => {
      const sel = el.dataset.id === id;
      const nb = near.has(el.dataset.id);
      const txt = el.querySelector("text");
      el.classList.toggle("selected", sel);
      el.style.opacity = !id || sel || nb ? "" : "0.22";
      if (txt) {
        const labelIds = cgGeom?.labelIds;
        txt.style.display = !labelIds || labelIds.has(el.dataset.id) || sel || nb ? "" : "none";
      }
    });
  }

  function selectCGNode(id) {
    cgSelected = id;
    renderCallDetails();
    highlightList();
    if (id === null) updatePanels();
    else revealInspector();
  }

  function renderCallDetails() {
    highlightCG();
    const d = callNodes.get(cgSelected);
    const info = $("#cg-info");
    const links = $("#cg-links");
    $("#cg-no-selection").hidden = Boolean(d);
    info.hidden = links.hidden = !d;
    if (!d) return;

    if (d.external) {
      info.innerHTML =
        `<div class="bname">${esc(d.display)}</div>` +
        `<div class="sub">External symbol · ${d.sites} call site${d.sites === 1 ? "" : "s"}</div>`;
    } else {
      info.innerHTML =
        `<div class="bname">${esc(d.display)}</div>` +
        `<div class="sub">${fmt(d.exec_count)} entries · Hottest BB <span class="hot">${fmt(d.hot)}</span></div>`;
    }

    links.innerHTML = (d.fn >= 0 ? '<button type="button" class="open-cfg" id="cg-open">Open CFG</button>' : "") +
      (renderCallGroups(d.id) || '<p class="empty">No calls</p>');
    links.scrollTop = 0;
  }

  function renderCallGroups(functionId, showEmpty = false) {
    const callLink = (id, count) => {
      const name = esc(callNodes.get(id)?.display ?? id);
      return `<button type="button" class="funcrow call-link" data-id="${esc(id)}">` +
        `<span class="name" title="${name}">${name}</span><span class="cnt">${fmt(count)}</span></button>`;
    };
    const group = (label, items) => {
      if (!items.length && !showEmpty) return "";
      const body = items.length ? `<div class="call-list">${items.join("")}</div>` : '<p class="empty">None</p>';
      return `<section class="call-group"><h3>${label}</h3>${body}</section>`;
    };
    const callers = CG.edges.filter((e) => e.target === functionId).map((e) => callLink(e.source, e.count));
    const callees = CG.edges.filter((e) => e.source === functionId).map((e) => callLink(e.target, e.count));
    return group("Callers", callers) + group("Callees", callees);
  }

  // ---------------------------------------------------------- navigation
  function setView(next) {
    activeView = next;
    const inOverview = next === "overview";
    const inFunction = next === "function";
    const section = inFunction ? parentView : next;
    for (const name of ["overview", "callgraph"]) {
      const button = $("#tab-" + name);
      if (section === name) button.setAttribute("aria-current", inFunction ? "true" : "page");
      else button.removeAttribute("aria-current");
    }

    $("#view-overview").hidden = !inOverview;
    $("#graph-workspace").hidden = inOverview;
    $("#cg-toolbar").hidden = $("#view-callgraph").hidden = $("#cg-detail").hidden = inFunction;
    $("#func-head").hidden = $("#view-function").hidden = $("#cfg-detail").hidden = !inFunction;
    $("#call-functions").hidden = inFunction;
    $("#function-overview").hidden = !inFunction;
    $("#stage").dataset.view = next;
    $("#function-panel-title").textContent = inFunction ? "Function overview" : "Functions";
    $("#inspector-title").textContent = inFunction ? "Assembly" : "Calls";
    updatePanels();
  }

  function showSection(next) {
    if (activeView === next) return;
    setView(next);
    if (next === "callgraph") {
      if (!cgGeom) renderCallGraph();
      else renderList();
    }
  }

  function renderFunctionOverview(fn) {
    const stats = [
      ["Address", hex(fn.address)],
      ["Size", fmt(fn.size) + " B"],
      ["Basic blocks", fmt(fn.bb_count)],
      ["Entries", fmt(fn.exec_count)],
      ["Hottest BB", fmt(fn.hot)],
      ["Block exec sum", fmt(fn.flow)],
      ["Profile match", fn.profile_acc == null ? "—" : fn.profile_acc.toFixed(1) + "%"],
    ];
    $("#func-stats").innerHTML = stats.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join("");
    $("#func-warning").hidden = !fn.unknown_cf;
    $("#function-calls").innerHTML = renderCallGroups(fn.raw_name, true);
    $("#blocklist").innerHTML = fn.blocks.map((block) =>
      `<button type="button" class="funcrow" data-name="${esc(block.name)}" title="${hex(block.addr)}${block.entry ? " · Entry" : ""}">` +
      `<span class="name">${esc(block.name)}</span><span class="cnt">${fmt(block.count)}</span></button>`
    ).join("") || '<p class="empty">No basic blocks</p>';
    $("#function-overview").scrollTop = 0;
  }

  function showFunction(i) {
    if (i < 0 || i >= FUNCS.length) return;
    const entering = activeView !== "function";
    if (entering) {
      parentView = activeView;
      parentFunction = i;
    }
    if (entering) compactPanels.function = null;
    setView("function");

    if (current !== i) {
      current = i;
      const fn = FUNCS[i];
      selected = (fn.blocks.find((b) => b.entry) || fn.blocks[0])?.name ?? null;
      const name = $("#func-name");
      name.textContent = name.title = fn.display;
      renderFunctionOverview(fn);

      $("#cfg-empty").hidden = selected !== null;
      $("#cfg-no-selection").hidden = selected !== null;
      $("#detail-head").hidden = selected === null;
      $("#asm").hidden = selected === null;
      $("#detail-edges").hidden = selected === null;
      renderCfg(fn);
      if (selected !== null) selectBlock(fn, selected, true);
    }

    $("#back-label").textContent = parentView === "overview" ? "Overview" : "Call graph";
    updateSourcePanel();
    if (entering) $("#func-name").focus({ preventScroll: true });
  }

  // -------------------------------------------------------------- panels
  const stage = $("#stage");
  const panels = {
    functions: { container: $("#function-panel"), body: $("#function-panel-body"), button: $("#toggle-functions") },
    inspector: { container: $("#inspector"), body: $("#inspector-body"), button: $("#toggle-inspector") },
  };
  const rightPanels = $("#right-panels");

  function setPanel({ container, body, button }, open, name) {
    if (!open && body.contains(document.activeElement)) button.focus({ preventScroll: true });
    container.classList.toggle("collapsed", !open);
    body.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    button.querySelector(".toggle-label").textContent = name;
    const label = (open ? "Collapse " : "Expand ") + name.toLowerCase();
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  const sourcePanel = { container: $("#source-panel"), body: $("#source-body"), button: $("#toggle-source") };

  function updateSourcePanel() {
    sourcePanel.container.hidden = activeView !== "function" || selected === null || panels.inspector.body.hidden;
    if (sourcePanel.container.hidden && sourcePanel.container.contains(document.activeElement)) {
      panels.inspector.button.focus({ preventScroll: true });
    }
    setPanel(sourcePanel, sourceOpen, "Source");
  }

  function updatePanels() {
    if (activeView === "overview") return;
    const onCompact = compact.matches;
    const leftOpen = onCompact ? compactPanels[activeView] === "functions" : functionsOpen[activeView];
    const rightOpen = onCompact ? compactPanels[activeView] === "inspector" : inspectorOpen[activeView];
    setPanel(panels.functions, leftOpen, $("#function-panel-title").textContent);
    setPanel(panels.inspector, rightOpen, $("#inspector-title").textContent);
    rightPanels.classList.toggle("collapsed", !rightOpen);
    updateSourcePanel();
    updateGraphViewport();
  }

  function revealInspector() {
    if (compact.matches) {
      compactPanels[activeView] = "inspector";
      updatePanels();
    }
  }

  for (const [id, { button, body }] of Object.entries(panels)) {
    button.addEventListener("click", () => {
      if (compact.matches) compactPanels[activeView] = body.hidden ? id : null;
      else if (id === "functions") functionsOpen[activeView] = body.hidden;
      else inspectorOpen[activeView] = body.hidden;
      updatePanels();
    });
  }
  sourcePanel.button.addEventListener("click", () => {
    sourceOpen = !sourceOpen;
    updateSourcePanel();
  });
  compact.addEventListener("change", updatePanels);

  // -------------------------------------------------------- canvas input
  function graphViewport() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const inset = (panel) => panel.offsetWidth + 2 * panel.offsetTop;
    const left = compact.matches ? 0 : inset(panels.functions.container);
    const right = compact.matches ? 0 : inset(rightPanels);
    return { x: left, w: Math.max(1, w - left - right), h };
  }

  function updateGraphViewport() {
    const graph = graphs[activeView];
    if (!graph) return;
    const { x, w } = graphViewport();
    stage.style.setProperty("--graph-center", (x + w / 2) + "px");
    if (graph.view?.fitted) fitGraph(graph);
  }

  function applyGraphView(graph) {
    const { x, y, k } = graph.view;
    graph.canvas.setAttribute("transform", `translate(${x} ${y}) scale(${k})`);
  }

  function fitGraph(graph) {
    const b = graph.bbox;
    if (!b) return;
    const { x, w, h } = graphViewport();
    const availableH = Math.max(1, h - 52);
    const pad = Math.min(24, w / 8, availableH / 8);
    const k = Math.min((w - pad * 2) / b.w, (availableH - pad * 2) / b.h, graph.fitMax);
    graph.view = {
      k,
      x: x + (w - b.w * k) / 2 - b.x * k,
      y: (availableH - b.h * k) / 2 - b.y * k,
      fitted: true,
    };
    applyGraphView(graph);
  }

  function zoomGraph(graph, factor, x, y) {
    const v = graph.view;
    if (!v || !graph.bbox) return;
    if (x === undefined) {
      const viewport = graphViewport();
      x = viewport.x + viewport.w / 2;
      y = (viewport.h - 52) / 2;
    }
    const k = clamp(v.k * factor, Math.min(v.k, graph.min), graph.max);
    v.x = x - (x - v.x) * k / v.k;
    v.y = y - (y - v.y) * k / v.k;
    v.k = k;
    v.fitted = false;
    applyGraphView(graph);
  }

  for (const graph of Object.values(graphs)) {
    const { svg, nodeClass } = graph;
    let drag = null;
    svg.addEventListener("wheel", (e) => {
      if (!graph.bbox) return;
      e.preventDefault();
      const bounds = svg.getBoundingClientRect();
      zoomGraph(graph, e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - bounds.left, e.clientY - bounds.top);
    }, { passive: false });

    svg.addEventListener("pointerdown", (e) => {
      if (!graph.bbox || e.button !== 0 || e.target.closest(nodeClass) || drag) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: graph.view.x, vy: graph.view.y, moved: false };
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener("pointermove", (e) => {
      if (drag?.id !== e.pointerId) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      svg.classList.add("dragging");
      graph.view.x = drag.vx + dx;
      graph.view.y = drag.vy + dy;
      graph.view.fitted = false;
      applyGraphView(graph);
    });
    svg.addEventListener("pointerup", (e) => {
      if (graph === graphs.callgraph && drag?.id === e.pointerId && !drag.moved) selectCGNode(null);
    });
    svg.addEventListener("lostpointercapture", (e) => {
      if (drag?.id !== e.pointerId) return;
      drag = null;
      svg.classList.remove("dragging");
    });
  }

  new ResizeObserver(updateGraphViewport).observe(stage);

  // ------------------------------------------------------------- events
  for (const id of ["search", "overview-search"]) {
    $("#" + id).addEventListener("input", (e) => {
      query = e.target.value.trim();
      $(id === "search" ? "#overview-search" : "#search").value = e.target.value;
      renderOverview();
      if (activeView === "callgraph") renderList();
    });
  }

  $("#tab-overview").addEventListener("click", () => showSection("overview"));
  $("#tab-callgraph").addEventListener("click", () => showSection("callgraph"));
  $("#back-to-report").addEventListener("click", () => {
    showSection(parentView);
    const target = parentView === "overview"
      ? $(`tr[data-function="${parentFunction}"] button`)
      : [...$("#funclist").querySelectorAll(".funcrow")].find((row) => row.dataset.id === cgSelected && row.offsetWidth);
    (target || $("#tab-" + parentView)).focus({ preventScroll: true });
  });

  document.querySelectorAll(".funcs th button").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.sort;
      if (sortKey === key) sortDir *= -1;
      else { sortKey = key; sortDir = key === "name" ? 1 : -1; }
      $(".funcs th[aria-sort]").removeAttribute("aria-sort");
      button.parentElement.setAttribute("aria-sort", sortDir > 0 ? "ascending" : "descending");
      renderOverview();
    });
  });

  $("#zoom-in").addEventListener("click", () => zoomGraph(graphs[activeView], 1.2));
  $("#zoom-out").addEventListener("click", () => zoomGraph(graphs[activeView], 1 / 1.2));
  $("#zoom-fit").addEventListener("click", () => fitGraph(graphs[activeView]));
  $("#cg-external").addEventListener("change", renderCallGraph);
  $("#cg-labels").addEventListener("change", (e) => {
    cgGeom.labelElems.forEach((el) => { el.style.display = e.target.checked ? "" : "none"; });
  });

  function inspectCallNode(id) {
    if (callNodes.get(id)?.external && !$("#cg-external").checked) {
      $("#cg-external").checked = true;
      renderCallGraph();
    }
    selectCGNode(id);
    $("#cg-info .bname").setAttribute("tabindex", "-1");
    $("#cg-info .bname").focus({ preventScroll: true });
  }

  $("#cg-links").addEventListener("click", (e) => {
    if (e.target.closest("#cg-open")) {
      showFunction(callNodes.get(cgSelected).fn);
      return;
    }
    const link = e.target.closest(".call-link");
    if (link) inspectCallNode(link.dataset.id);
  });

  $("#function-calls").addEventListener("click", (e) => {
    const link = e.target.closest(".call-link");
    if (!link) return;
    const node = callNodes.get(link.dataset.id);
    if (node.fn >= 0) {
      showFunction(node.fn);
      $("#func-name").focus({ preventScroll: true });
    } else {
      inspectorOpen.callgraph = true;
      showSection("callgraph");
      inspectCallNode(node.id);
    }
  });

  $("#detail-edges").addEventListener("click", (e) => {
    const link = e.target.closest(".chip");
    if (!link) return;
    selectBlock(FUNCS[current], link.dataset.jump, true);
    $("#detail-head .bname").setAttribute("tabindex", "-1");
    $("#detail-head .bname").focus({ preventScroll: true });
  });

  $("#blocklist").addEventListener("click", (e) => {
    const block = e.target.closest("button[data-name]");
    if (!block) return;
    selectBlock(FUNCS[current], block.dataset.name, true);
    if (compact.matches) revealInspector();
  });

  $("#asm").addEventListener("click", (e) => {
    const link = e.target.closest(".asm-link");
    if (!link) return;
    if (link.dataset.source !== undefined) {
      highlightInstruction(link.dataset.source, true);
      return;
    }
    const { fn, block, target } = link.dataset;
    showFunction(Number(fn));
    if (block !== selected) selectBlock(FUNCS[current], block, true);
    highlightInstruction(target, false);
  });

  $("#source-body").addEventListener("click", (e) => {
    const link = e.target.closest("button[data-address]");
    if (link) highlightInstruction(link.dataset.address, false);
  });

  window.addEventListener("keydown", (e) => {
    if (activeView !== "function" || e.target.closest("input, .asm, .source-body")) return;
    if (e.key === "ArrowRight" && current + 1 < FUNCS.length) showFunction(current + 1);
    if (e.key === "ArrowLeft" && current > 0) showFunction(current - 1);
  });

  renderMeta();
  renderOverview();
})();
