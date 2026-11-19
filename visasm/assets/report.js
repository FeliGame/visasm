(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const SVGNS = "http://www.w3.org/2000/svg";

  const FUNCS = DATA.functions;
  const HOT_LOG = Math.log1p(DATA.hot_max || 1);

  let query = "";
  let sortKey = "hot";
  let sortDir = -1;
  let current = -1;
  let selected = null;
  let view = { x: 0, y: 0, k: 1 };
  let geom = null;
  let dragging = null;

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

  function sumFlow(fn) {
    return fn.blocks.reduce((a, b) => a + (b.count || 0), 0);
  }
  function hottest(fn) {
    return fn.blocks.reduce((a, b) => Math.max(a, b.count || 0), 0);
  }

  // ------------------------------------------------------------- sidebar
  function filtered() {
    if (!query) return FUNCS.slice().sort((a, b) => (b.hot || 0) - (a.hot || 0));
    let re = null;
    try {
      re = new RegExp(query, "i");
    } catch (e) {
      re = null;
    }
    return FUNCS.filter((f) =>
      re ? re.test(f.raw_name) || re.test(f.display) : f.display.toLowerCase().includes(query.toLowerCase())
    );
  }

  function renderMeta() {
    const s = DATA.summary;
    $("#meta").textContent =
      `${DATA.binary}  ·  ${s.matched_functions}/${s.functions} functions matched  ·  ${fmt(s.blocks)} basic blocks  ·  generated ${DATA.generated}`;
    document.title = `visasm · ${DATA.title}`;
    $("#summary").innerHTML = [
      ["Functions", fmt(s.functions)],
      ["Matched", fmt(s.matched_functions)],
      ["Basic blocks", fmt(s.blocks)],
      ["Hottest BB", fmt(s.hottest_block)],
    ]
      .map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`)
      .join("");
  }

  function renderList() {
    const items = filtered();
    const maxHot = items.reduce((a, f) => Math.max(a, hottest(f)), 1);
    const box = $("#funclist");
    box.innerHTML = "";
    const frag = document.createDocumentFragment();
    items.slice(0, 600).forEach((fn) => {
      const hot = hottest(fn);
      const row = document.createElement("div");
      row.className = "funcrow" + (FUNCS[current] === fn ? " selected" : "");
      row.dataset.name = fn.name;
      row.innerHTML =
        `<span class="name" title="${esc(fn.display)}">${esc(short(fn.display, 40))}</span>` +
        `<span class="cnt">${fmt(hot)}</span>` +
        `<span class="bar"><i style="width:${Math.max(2, (Math.log1p(hot) / Math.log1p(maxHot)) * 100)}%"></i></span>`;
      row.addEventListener("click", () => showFunction(FUNCS.indexOf(fn)));
      frag.appendChild(row);
    });
    if (items.length > 600) {
      const note = document.createElement("div");
      note.className = "funcrow";
      note.innerHTML = `<span class="name" style="color:#8a94a6">\u2026 ${items.length - 600} more (use the filter)</span>`;
      frag.appendChild(note);
    }
    box.appendChild(frag);
  }

  // ------------------------------------------------------------ overview
  function renderOverview() {
    const items = filtered().slice();
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
      tr.innerHTML =
        `<td class="fname"><span class="heatcell" style="background:${heatOf(fn.hot)}"></span>${esc(short(fn.display, 70))}</td>` +
        `<td class="num">${fmt(fn.hot)}</td>` +
        `<td class="num">${fmt(fn.flow)}</td>` +
        `<td class="num">${fmt(fn.exec_count)}</td>` +
        `<td class="num">${fn.bb_count}</td>` +
        `<td class="num">${fn.profile_acc == null ? "\u2014" : fn.profile_acc.toFixed(0) + "%"}</td>`;
      tr.addEventListener("click", () => showFunction(FUNCS.indexOf(fn)));
      frag.appendChild(tr);
    });
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
      bbox: { w: width, h: maxRank * (NH + GY) + NH + 120 },
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
    geom = computeLayout(fn);

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

    const fnHot = Math.max(1, hottest(fn));
    fn.blocks.forEach((B, i) => {
      const a = geom.nodes.get(i);
      if (!a) return;
      const t = B.count ? Math.log1p(B.count) / HOT_LOG : 0;
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
      });
      nodeLayer.appendChild(node);
    });

    fitView();
    applyView();
  }

  function applyView() {
    $("#canvas").setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.k})`);
  }

  function fitView() {
    const svg = $("#cfg");
    const w = svg.clientWidth || 900;
    const h = svg.clientHeight || 600;
    if (!geom) return;
    const bw = geom.bbox.w || 400;
    const bh = geom.bbox.h || 400;
    const k = clamp(Math.min((w - 60) / bw, (h - 60) / bh), 0.12, 1.4);
    view = { k, x: (w - bw * k) / 2, y: 20 };
  }

  // -------------------------------------------------------------- detail
  function selectBlock(fn, name, scroll) {
    selected = name;
    document.querySelectorAll(".bb").forEach((el) => {
      el.classList.toggle("selected", el.dataset.name === name);
    });
    const B = fn.blocks.find((b) => b.name === name);
    const head = $("#detail-head");
    const edges = $("#detail-edges");
    const asm = $("#asm");
    if (!B) return;
    const share = B.count && fn.blocks.length ? ((B.count / Math.max(1, hottest(fn))) * 100).toFixed(1) : null;
    head.innerHTML =
      `<div class="bname">${esc(B.name)}</div>` +
      `<div class="sub">0x${B.addr.toString(16)} &nbsp;·&nbsp; +0x${B.offset.toString(16)} &nbsp;·&nbsp; ` +
      `<span class="hot">${fmt(B.count)}</span> executions${share ? " (" + share + "% of hottest BB)" : ""}</div>`;
    const chip = (n, c) => `<span class="chip" data-jump="${esc(n)}">${esc(n)}${c == null ? "" : " · " + fmt(c)}</span>`;
    edges.innerHTML =
      (B.preds.length ? `<b>pred:</b> ${B.preds.map((p) => chip(p, null)).join(" ")}` : "") +
      " " +
      (B.succs.length
        ? `<b>succ:</b> ${B.succs.map((s) => chip(s.target, s.count == null ? s.inferred : s.count)).join(" ")}`
        : "<b>no successors</b>");

    edges.querySelectorAll(".chip").forEach((el) =>
      el.addEventListener("click", () => selectBlock(fn, el.dataset.jump, true))
    );

    const rows = B.insts
      .map((I) => {
        const isCfi = /^\s*!CFI/.test(I.text);
        const src = I.debug ? I.debug.replace(/^.*\//, "") : "";
        return `<tr class="${isCfi ? "cfi" : ""}"><td class="addr">0x${I.addr.toString(16)}</td>` +
          `<td class="insn">${esc(I.text)}</td><td class="src">${esc(src)}</td></tr>`;
      })
      .join("");
    asm.innerHTML = `<table>${rows}</table>`;
    if (scroll) asm.scrollTop = 0;
  }

  // ---------------------------------------------------------- navigation
  function showOverview() {
    $("#tab-overview").classList.add("active");
    $("#tab-function").classList.remove("active");
    $("#view-overview").classList.remove("hidden");
    $("#view-function").classList.add("hidden");
  }

  function showFunction(i) {
    if (i < 0 || i >= FUNCS.length) return;
    current = i;
    const fn = FUNCS[i];
    selected = fn.blocks.length ? (fn.blocks.find((b) => b.entry) || fn.blocks[0]).name : null;
    $("#tab-function").classList.add("active");
    $("#tab-overview").classList.remove("active");
    $("#view-function").classList.remove("hidden");
    $("#view-overview").classList.add("hidden");
    renderList();

    const head = $("#func-head");
    const acc = fn.profile_acc == null ? "\u2014" : fn.profile_acc.toFixed(1) + "%";
    head.innerHTML =
      `<h2>${esc(short(fn.display, 90))}</h2>` +
      `<span class="pill">0x${fn.address.toString(16)} + 0x${fn.size.toString(16)}</span>` +
      `<span class="pill">${fn.bb_count} BBs</span>` +
      `<span class="pill">entries ${fmt(fn.exec_count)}</span>` +
      `<span class="pill">hottest BB <span class="hot">${fmt(fn.hot)}</span></span>` +
      `<span class="pill">match ${acc}</span>` +
      (fn.unknown_cf ? `<span class="pill" style="color:#b23">unknown control flow</span>` : "");

    $("#asm").innerHTML = "";
    $("#detail-head").innerHTML = "";
    $("#detail-edges").innerHTML = "";
    requestAnimationFrame(() => {
      renderCfg(fn);
      if (selected) selectBlock(fn, selected, false);
    });
  }

  // ------------------------------------------------------------- events
  $("#search").addEventListener("input", (e) => {
    query = e.target.value.trim();
    renderList();
    renderOverview();
  });

  $("#tab-overview").addEventListener("click", showOverview);
  $("#tab-function").addEventListener("click", () => {
    showFunction(current >= 0 ? current : 0);
  });

  document.querySelectorAll("table.funcs th").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (sortKey === key) sortDir *= -1;
      else { sortKey = key; sortDir = key === "name" ? 1 : -1; }
      renderOverview();
    });
  });

  const svg = $("#cfg");
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const k = clamp(view.k * factor, 0.1, 3.5);
    view.x = mx - ((mx - view.x) / view.k) * k;
    view.y = my - ((my - view.y) / view.k) * k;
    view.k = k;
    applyView();
  }, { passive: false });

  svg.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".bb")) return;
    dragging = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    svg.classList.add("dragging");
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    view.x = dragging.vx + (e.clientX - dragging.x);
    view.y = dragging.vy + (e.clientY - dragging.y);
    applyView();
  });
  const stopDrag = () => { dragging = null; svg.classList.remove("dragging"); };
  svg.addEventListener("pointerup", stopDrag);
  svg.addEventListener("pointercancel", stopDrag);

  $("#zoom-in").addEventListener("click", () => { view.k = clamp(view.k * 1.2, 0.1, 3.5); applyView(); });
  $("#zoom-out").addEventListener("click", () => { view.k = clamp(view.k / 1.2, 0.1, 3.5); applyView(); });
  $("#zoom-fit").addEventListener("click", () => { fitView(); applyView(); });

  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.key === "ArrowRight" && current + 1 < FUNCS.length) showFunction(current + 1);
    if (e.key === "ArrowLeft" && current > 0) showFunction(current - 1);
  });

  // ----------------------------------------------------------------- go
  renderMeta();
  renderList();
  renderOverview();
  if (FUNCS.length) showFunction(0);
})();
