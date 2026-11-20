  // Embedded in report.js for reports with trace data.
  function renderTraceMeta() {
    $("#runtime").hidden = $("#tab-timeline").hidden = false;
    $("#runtime-stats").innerHTML = [
      ["Before instrumentation", formatTime(timeline.baseline_ns)],
      ["With BB instrumentation", formatTime(timeline.duration_ns)],
    ].map(([label, value]) =>
      `<div class="stat"><div class="k">${label}</div><div class="v">${value}</div></div>`
    ).join("");
  }

  const timelineTime = $("#timeline-time");
  const timelinePlay = $("#timeline-play");
  const timelineThread = $("#timeline-thread");
  const timelineSpeed = $("#timeline-speed");
  const timelinePrev = $("#timeline-prev");
  const timelineNext = $("#timeline-next");
  const timelinePlayhead = $("#timeline-playhead");
  const timelineCanvas = $("#timeline-density");
  const timelineEventsByThread = new Map();
  const probeByBlock = new Map();
  const successorsByProbe = [];
  const blockCounts = new Float64Array(timeline.blocks.length);
  const timelineActivity = {
    hotLog: Math.log1p(1),
    edgeCounts: new Map(),
    blockCount: (block) => blockCounts[probeByBlock.get(block)] ?? 0,
  };
  let threadEvents = [];
  let countedThrough = -1;
  let threadStart = 0;
  let threadEnd = 0;
  let windowStart = 0;
  let windowSpan = 1;
  let timelineCursor = 0;
  let eventIndex = -1;
  let playbackFrame = null;

  function formatTime(ns, precise = false) {
    if (ns >= 1e9) return (ns / 1e9).toFixed(precise ? 9 : 3) + " s";
    if (ns >= 1e6 || ns === 0) return (ns / 1e6).toFixed(precise ? 6 : 3) + " ms";
    if (ns >= 1e3) return (ns / 1e3).toFixed(3) + " µs";
    return ns + " ns";
  }

  function eventAt(time) {
    let low = 0;
    let high = threadEvents.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (threadEvents[middle][0] <= time) low = middle + 1;
      else high = middle;
    }
    return low - 1;
  }

  function countTimelineVisits(index) {
    const direction = index > countedThrough ? 1 : -1;
    const edges = timelineActivity.edgeCounts;
    while (countedThrough !== index) {
      const position = Math.max(countedThrough, countedThrough + direction);
      const probe = threadEvents[position][1];
      blockCounts[probe] += direction;
      if (position > 0) {
        const previous = threadEvents[position - 1][1];
        const edge = successorsByProbe[previous].get(probe);
        if (edge) edges.set(edge, (edges.get(edge) ?? 0) + direction);
      }
      countedThrough += direction;
    }
  }

  function seekTimeline(time, index = eventAt(time)) {
    countTimelineVisits(index);
    timelineCursor = time;
    eventIndex = index;
    const event = threadEvents[index];
    const offset = time - threadStart;
    timelineTime.setAttribute("aria-valuenow", offset);
    timelineTime.setAttribute("aria-valuetext", formatTime(offset, true));
    timelinePrev.disabled = index < 0 || (index === 0 && time <= threadStart);
    timelineNext.disabled = time >= threadEnd && index >= threadEvents.length - 1;
    $("#timeline-position").textContent = formatTime(offset, true) +
      (event ? ` · ${(index + 1).toLocaleString()} / ${threadEvents.length.toLocaleString()}` : "");
    if (time < windowStart || time > windowStart + windowSpan) {
      setTimelineWindow(time < windowStart ? time : time - windowSpan, windowSpan);
    } else {
      positionPlayhead();
    }
    if (!event) {
      $("#timeline-location").textContent = "No BB entry recorded for this thread yet";
      if (activeView !== "overview") setView("overview");
      return;
    }
    const [fnIndex, blockIndex] = timeline.blocks[event[1]];
    const fn = FUNCS[fnIndex];
    const block = fn.blocks[blockIndex];
    $("#timeline-location").textContent = `${fn.display} · ${block.name} · ${hex(block.addr)} · entered at ${formatTime(event[0] - threadStart, true)}`;
    if (activeView !== "function" || current !== fnIndex) showFunction(fnIndex);
    else paintCfg();
    if (selected !== block.name) selectBlock(fn, block.name, true);
  }

  function selectTimelineThread() {
    threadEvents = timelineEventsByThread.get(Number(timelineThread.value));
    threadStart = threadEvents[0][0];
    const finished = timeline.thread_end_ns?.[timelineThread.value];
    threadEnd = finished ?? threadEvents.at(-1)[0];
    timelineTime.setAttribute("aria-valuemin", 0);
    timelineTime.setAttribute("aria-valuemax", threadEnd - threadStart);
    countedThrough = -1;
    timelineActivity.edgeCounts.clear();
    let hottest = 1;
    blockCounts.fill(0);
    for (const [, probe] of threadEvents) {
      hottest = Math.max(hottest, ++blockCounts[probe]);
    }
    timelineActivity.hotLog = Math.log1p(hottest);
    blockCounts.fill(0);
    setTimelineWindow(threadStart, threadEnd - threadStart);
  }

  function positionPlayhead() {
    const fraction = (timelineCursor - windowStart) / windowSpan;
    timelinePlayhead.hidden = fraction < 0 || fraction > 1;
    timelinePlayhead.style.left = (100 * fraction) + "%";
  }

  function drawTimelineWindow() {
    const width = timelineTime.clientWidth;
    if (!width) return;
    timelineCanvas.width = width;
    const ctx = timelineCanvas.getContext("2d");
    const height = timelineCanvas.height;
    const buckets = new Uint32Array(width);
    let cursor = eventAt(windowStart - 1) + 1;
    let max = 0;
    for (let x = 0; x < width; x++) {
      const right = windowStart + ((x + 1) / width) * windowSpan;
      const next = eventAt(x === width - 1 ? Math.floor(right) : Math.ceil(right) - 1) + 1;
      max = Math.max(max, buckets[x] = next - cursor);
      cursor = next;
    }
    ctx.fillStyle = "#5d8ed7";
    const scale = Math.log1p(max);
    for (let x = 0; x < width; x++) {
      if (!buckets[x]) continue;
      const length = Math.max(8, height * Math.log1p(buckets[x]) / scale);
      ctx.fillRect(x, height - length, 1, length);
    }
    if (threadEnd >= windowStart && threadEnd <= windowStart + windowSpan) {
      ctx.fillStyle = "#344b67";
      const end = Math.min(width - 1, Math.floor(width * (threadEnd - windowStart) / windowSpan));
      ctx.fillRect(end, 0, 1, height);
    }
  }

  function setTimelineWindow(start, span) {
    const fullSpan = Math.max(1, threadEnd - threadStart);
    windowSpan = clamp(Math.round(span), 1, fullSpan);
    windowStart = clamp(Math.round(start), threadStart, threadStart + fullSpan - windowSpan);
    $("#timeline-start").textContent = formatTime(windowStart - threadStart, true);
    $("#timeline-end").textContent = formatTime(Math.min(threadEnd, windowStart + windowSpan) - threadStart, true);
    $("#timeline-zoom-in").disabled = windowSpan <= 1;
    $("#timeline-zoom-out").disabled = $("#timeline-fit").disabled = windowSpan >= fullSpan;
    drawTimelineWindow();
    positionPlayhead();
  }

  function zoomTimeline(factor, fraction) {
    const span = clamp(windowSpan * factor, 1, Math.max(1, threadEnd - threadStart));
    setTimelineWindow(windowStart + fraction * (windowSpan - span), span);
  }

  function snapTimeline(time) {
    const index = eventAt(time);
    const before = threadEvents[index]?.[0] ?? threadStart;
    const after = threadEvents[index + 1]?.[0] ?? threadEnd;
    seekTimeline(time - before <= after - time ? before : after);
  }

  function configureTimelineRuler() {
    let drag = null;
    const pointerFraction = (x) => {
      const bounds = timelineTime.getBoundingClientRect();
      return clamp((x - bounds.left) / bounds.width, 0, 1);
    };
    const scrub = (x) => snapTimeline(Math.min(threadEnd, windowStart + pointerFraction(x) * windowSpan));
    const zoomAtCursor = (factor) => {
      stopPlayback();
      zoomTimeline(factor, clamp((timelineCursor - windowStart) / windowSpan, 0, 1));
    };
    $("#timeline-zoom-in").addEventListener("click", () => zoomAtCursor(0.5));
    $("#timeline-zoom-out").addEventListener("click", () => zoomAtCursor(2));
    $("#timeline-fit").addEventListener("click", () => {
      stopPlayback();
      setTimelineWindow(threadStart, threadEnd - threadStart);
    });
    timelineTime.addEventListener("wheel", (e) => {
      e.preventDefault();
      stopPlayback();
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const delta = e.deltaX || e.deltaY;
        setTimelineWindow(windowStart + delta * windowSpan / timelineTime.clientWidth, windowSpan);
      } else {
        const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        zoomTimeline(Math.exp(clamp(delta / 360, -1.4, 1.4)), pointerFraction(e.clientX));
      }
    }, { passive: false });
    timelineTime.addEventListener("pointerdown", (e) => {
      if (drag || e.button !== 0) return;
      stopPlayback();
      timelineTime.setPointerCapture(e.pointerId);
      const pan = e.target !== timelinePlayhead && windowSpan < threadEnd - threadStart;
      drag = { id: e.pointerId, x: e.clientX, start: windowStart, pan, moved: false };
      if (!pan) scrub(e.clientX);
    });
    timelineTime.addEventListener("pointermove", (e) => {
      if (drag?.id !== e.pointerId) return;
      const delta = e.clientX - drag.x;
      drag.moved ||= Math.abs(delta) >= 3;
      if (drag.pan && drag.moved) {
        timelineTime.classList.add("panning");
        setTimelineWindow(drag.start - delta * windowSpan / timelineTime.clientWidth, windowSpan);
      } else if (!drag.pan) {
        scrub(e.clientX);
      }
    });
    timelineTime.addEventListener("pointerup", (e) => {
      if (drag?.id !== e.pointerId) return;
      if (!drag.pan || !drag.moved) scrub(e.clientX);
    });
    timelineTime.addEventListener("lostpointercapture", () => {
      drag = null;
      timelineTime.classList.remove("panning");
    });
    timelineTime.addEventListener("keydown", (e) => {
      const actions = {
        ArrowLeft: () => stepTimeline(-1),
        ArrowRight: () => stepTimeline(1),
        Home: () => seekTimeline(threadStart, 0),
        End: () => seekTimeline(threadEnd),
        "+": () => zoomAtCursor(0.5),
        "-": () => zoomAtCursor(2),
      };
      if (!Object.hasOwn(actions, e.key)) return;
      e.preventDefault();
      stopPlayback();
      actions[e.key]();
    });
    new ResizeObserver(drawTimelineWindow).observe(timelineTime);
  }

  function openTimeline() {
    if (timelineOpen) return;
    timelineOpen = true;
    if (!timeline.events.length) {
      setView("overview");
      return;
    }
    setView(activeView);
    seekTimeline(timelineCursor, eventIndex);
  }

  function stopPlayback() {
    if (playbackFrame !== null) cancelAnimationFrame(playbackFrame);
    playbackFrame = null;
    timelinePlay.textContent = "Play";
  }

  function stepTimeline(direction) {
    stopPlayback();
    const afterEvent = eventIndex >= 0 && timelineCursor > threadEvents[eventIndex][0];
    const next = eventIndex + (direction < 0 && afterEvent ? 0 : direction);
    if (threadEvents[next]) seekTimeline(threadEvents[next][0], next);
    else if (direction > 0) seekTimeline(threadEnd);
  }

  function togglePlayback() {
    if (playbackFrame !== null) {
      stopPlayback();
      return;
    }
    if (timelineCursor >= threadEnd) seekTimeline(threadStart, 0);
    const start = performance.now();
    const from = timelineCursor;
    const firstIndex = eventIndex;
    const speed = timelineSpeed.value;
    timelinePlay.textContent = "Pause";
    function tick(now) {
      const elapsed = now - start;
      if (speed === "entries") {
        const next = firstIndex + Math.floor(elapsed / 125);
        if (next >= threadEvents.length) seekTimeline(threadEnd);
        else seekTimeline(threadEvents[next][0], next);
      } else {
        const rate = speed === "1x" ? 1e6 : Math.max(1, threadEnd - threadStart) / (1000 * Number(speed));
        seekTimeline(Math.min(threadEnd, Math.floor(from + elapsed * rate)));
      }
      if (timelineCursor >= threadEnd && eventIndex === threadEvents.length - 1) stopPlayback();
      else playbackFrame = requestAnimationFrame(tick);
    }
    playbackFrame = requestAnimationFrame(tick);
  }

  function configureTimeline() {
    $("#open-timeline").addEventListener("click", openTimeline);
    $("#tab-timeline").addEventListener("click", openTimeline);
    if (!timeline.events.length) {
      $("#timeline-controls").hidden = $("#timeline-axis").hidden = true;
      $("#timeline-note").hidden = false;
      $("#timeline-note").textContent = "No matching BB entries were recorded.";
      return;
    }
    const blocksByName = FUNCS.map((fn) => new Map(fn.blocks.map((block) => [block.name, block])));
    timeline.blocks.forEach(([fn, block], probe) => probeByBlock.set(FUNCS[fn].blocks[block], probe));
    for (const [fn, block] of timeline.blocks) {
      const successors = new Map();
      for (const edge of FUNCS[fn].blocks[block].succs) {
        const probe = probeByBlock.get(blocksByName[fn].get(edge.target));
        if (probe !== undefined) successors.set(probe, edge);
      }
      successorsByProbe.push(successors);
    }
    for (const event of timeline.events) {
      const thread = event[2];
      if (!timelineEventsByThread.has(thread)) timelineEventsByThread.set(thread, []);
      timelineEventsByThread.get(thread).push(event);
    }
    const threadOrder = (thread) => thread === timeline.main_thread ? 0 : thread;
    const threads = [...timelineEventsByThread.keys()].sort((a, b) => threadOrder(a) - threadOrder(b));
    for (const thread of threads) {
      const label = (thread === timeline.main_thread ? "Main · " : "") + thread;
      timelineThread.add(new Option(label, thread));
    }
    timelineThread.addEventListener("change", () => {
      stopPlayback();
      selectTimelineThread();
      seekTimeline(clamp(timelineCursor, threadStart, threadEnd));
    });
    timelineSpeed.addEventListener("change", stopPlayback);
    timelinePrev.addEventListener("click", () => stepTimeline(-1));
    timelineNext.addEventListener("click", () => stepTimeline(1));
    timelinePlay.addEventListener("click", togglePlayback);
    selectTimelineThread();
    configureTimelineRuler();
    timelineCursor = threadStart;
    eventIndex = 0;
  }
