  // Embedded in report.js for reports with trace data.
  function renderTraceMeta() {
    $("#runtime").hidden = $("#tab-timeline").hidden = false;
    const scale = timeline.duration_ns / timeline.baseline_ns;
    $("#runtime-stats").innerHTML = [
      ["Before instrumentation", formatTime(timeline.baseline_ns)],
      ["With BB instrumentation", formatTime(timeline.duration_ns)],
      ["Runtime ratio", scale.toFixed(2) + "×"],
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
  const timelineEventsByThread = new Map();
  let threadEvents = [];
  let timelineCursor = 0;
  let eventIndex = -1;
  let playbackFrame = null;

  function formatTime(ns) {
    if (ns >= 1e9) return (ns / 1e9).toFixed(3) + " s";
    if (ns >= 1e6 || ns === 0) return (ns / 1e6).toFixed(3) + " ms";
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

  function seekTimeline(time, index = eventAt(time)) {
    timelineCursor = time;
    eventIndex = index;
    const event = threadEvents[index];
    timelineTime.value = time;
    timelineTime.setAttribute("aria-valuetext", formatTime(time));
    timelinePrev.disabled = index < 0 || (index === 0 && time <= threadEvents[index][0]);
    timelineNext.disabled = index >= threadEvents.length - 1;
    $("#timeline-position").textContent = formatTime(time) +
      (event ? ` · ${(index + 1).toLocaleString()} / ${threadEvents.length.toLocaleString()}` : "");
    if (!event) {
      $("#timeline-location").textContent = "No BB entry recorded for this thread yet";
      if (activeView !== "overview") setView("overview");
      return;
    }
    const [fnIndex, blockIndex] = timeline.blocks[event[1]];
    const fn = FUNCS[fnIndex];
    const block = fn.blocks[blockIndex];
    $("#timeline-location").textContent = `${fn.display} · ${block.name} · ${hex(block.addr)} · entered at ${formatTime(event[0])}`;
    if (activeView !== "function" || current !== fnIndex) showFunction(fnIndex);
    if (selected !== block.name) selectBlock(fn, block.name, true);
  }

  function drawTimelineDensity() {
    const canvas = $("#timeline-density");
    const ctx = canvas.getContext("2d");
    const buckets = new Uint32Array(canvas.width);
    let max = 0;
    for (const [time] of threadEvents) {
      const bucket = Math.min(buckets.length - 1, Math.floor(time / timeline.duration_ns * buckets.length));
      max = Math.max(max, ++buckets[bucket]);
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#2f6feb";
    buckets.forEach((count, bucket) => {
      if (!count) return;
      const height = Math.max(2, (Math.log1p(count) / Math.log1p(max)) * canvas.height);
      ctx.fillRect(bucket, canvas.height - height, 1, height);
    });
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
  }

  function togglePlayback() {
    if (playbackFrame !== null) {
      stopPlayback();
      return;
    }
    const lastTime = threadEvents.at(-1)[0];
    if (eventIndex === threadEvents.length - 1) seekTimeline(threadEvents[0][0], 0);
    const start = performance.now();
    const from = timelineCursor;
    const firstIndex = eventIndex;
    const speed = timelineSpeed.value;
    timelinePlay.textContent = "Pause";
    function tick(now) {
      const elapsed = now - start;
      if (speed === "entries") {
        const next = Math.min(threadEvents.length - 1, Math.max(0, firstIndex + Math.floor(elapsed / 125)));
        seekTimeline(threadEvents[next][0], next);
      } else {
        const rate = speed === "1x" ? 1e6 : timeline.duration_ns / (1000 * Number(speed));
        seekTimeline(Math.min(lastTime, Math.floor(from + elapsed * rate)));
      }
      if (eventIndex === threadEvents.length - 1) stopPlayback();
      else playbackFrame = requestAnimationFrame(tick);
    }
    playbackFrame = requestAnimationFrame(tick);
  }

  function configureTimeline() {
    $("#open-timeline").addEventListener("click", openTimeline);
    $("#tab-timeline").addEventListener("click", openTimeline);
    const note = $("#timeline-note");
    if (!timeline.events.length) {
      $("#timeline-controls").hidden = $("#timeline-axis").hidden = true;
      note.textContent = "No matching BB entries were recorded.";
      return;
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
    timelineTime.max = timeline.duration_ns;
    $("#timeline-end").textContent = formatTime(timeline.duration_ns);
    note.textContent = "Shows the most recent recorded BB entry for the selected thread.";
    timelineThread.addEventListener("change", () => {
      stopPlayback();
      threadEvents = timelineEventsByThread.get(Number(timelineThread.value));
      drawTimelineDensity();
      seekTimeline(timelineCursor);
    });
    timelineSpeed.addEventListener("change", stopPlayback);
    timelineTime.addEventListener("input", () => {
      stopPlayback();
      seekTimeline(Number(timelineTime.value));
    });
    timelinePrev.addEventListener("click", () => stepTimeline(-1));
    timelineNext.addEventListener("click", () => stepTimeline(1));
    timelinePlay.addEventListener("click", togglePlayback);
    threadEvents = timelineEventsByThread.get(threads[0]);
    timelineCursor = threadEvents[0][0];
    eventIndex = 0;
    drawTimelineDensity();
  }
