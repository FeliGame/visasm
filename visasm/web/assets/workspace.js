"use strict";

const byId = (id) => document.getElementById(id);
const form = byId("analysis");
const workspace = document.querySelector(".workspace");
const runButtons = document.querySelectorAll(".run-actions button[type=submit]");
const stopButtons = document.querySelectorAll("[data-stop]");
const viewerTabs = document.querySelectorAll("[data-view]");
const narrow = window.matchMedia("(max-width: 620px)");
const reportDate = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const frames = { profile: byId("profile-frame"), trace: byId("trace-frame") };
const reports = {};
const jobs = new Map();
const runOutputs = new Map();
const selected = new Map();
let folder = ".", parent = null;
let preview = null, previewRequest = 0, browseRequest = 0;
let viewer = "profile", outputMode = "profile";
let consoleView = "terminal";

async function request(path, data) {
  const options = data === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  };
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || response.statusText);
  return result;
}

function status(message, error = false) {
  const label = byId("job-status");
  label.textContent = message;
  label.classList.toggle("error", error);
}

function showRunningJobs() {
  const modes = [...jobs.keys()].map(modeLabel);
  status(modes.length ? "Running " + modes.join(" and ") + "…" : "");
}

function setFilesOpen(open) {
  workspace.classList.toggle("files-collapsed", !open);
  byId("toggle-files").setAttribute("aria-expanded", open);
  byId("files").hidden = !open;
}

function highlightFiles() {
  for (const row of byId("file-list").querySelectorAll(".file-row")) {
    if (preview?.path === row.dataset.path) row.setAttribute("aria-current", "true");
    else row.removeAttribute("aria-current");
    const isInput = selected.has(row.dataset.path);
    row.toggleAttribute("data-input", isInput);
    const action = row.nextElementSibling;
    if (action) {
      action.textContent = isInput ? "−" : "+";
      action.title = (isInput ? "Remove " : "Add ") + row.title;
      action.setAttribute("aria-label", action.title);
    }
  }
}

async function browse(path = ".") {
  const version = ++browseRequest;
  try {
    const data = await request("api/files?path=" + encodeURIComponent(path));
    if (version !== browseRequest) return;
    folder = data.path;
    parent = data.parent;
    byId("parent-dir").disabled = parent === null;
    byId("root-path").textContent = byId("root-path").title = data.root;
    byId("current-dir").textContent = byId("current-dir").title = folder === "." ? "/" : folder;
    const items = data.entries.map((entry) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      const icon = document.createElement("i");
      const text = document.createElement("span");
      item.className = "file-entry";
      button.className = "file-row";
      button.type = "button";
      button.dataset.path = entry.path;
      button.title = entry.name;
      icon.className = entry.directory ? "file-icon folder" : "file-icon";
      icon.setAttribute("aria-hidden", "true");
      text.textContent = entry.name;
      button.append(icon, text);
      button.addEventListener("click", () => entry.directory ? browse(entry.path) : showFile(entry));
      item.append(button);
      if (["source", "header", "elf"].includes(entry.kind)) {
        const action = document.createElement("button");
        action.className = "quiet file-action";
        action.type = "button";
        action.addEventListener("click", () => toggleInput(entry));
        item.append(action);
      }
      return item;
    });
    if (!items.length) {
      const empty = document.createElement("li");
      empty.className = "muted";
      empty.textContent = "Empty directory";
      items.push(empty);
    }
    byId("file-list").replaceChildren(...items);
    highlightFiles();
  } catch (error) {
    if (version === browseRequest) status(error.message, true);
  }
}

async function showFile(entry) {
  const version = ++previewRequest;
  try {
    const data = await request("api/source?path=" + encodeURIComponent(entry.path));
    if (version !== previewRequest) return;
    preview = { ...entry, kind: data.kind };
    const view = byId("source-view");
    const fragment = document.createDocumentFragment();
    if (data.kind === "elf" || data.text === null) {
      const label = document.createElement("p");
      label.textContent = data.kind === "elf" ? "ELF executable" : "Binary file";
      fragment.append(label);
    } else {
      data.text.split("\n").forEach((line, index) => {
        const row = document.createElement("div");
        const number = document.createElement("span");
        const code = document.createElement("code");
        row.className = "source-line";
        number.textContent = index + 1;
        code.textContent = line;
        row.append(number, code);
        fragment.append(row);
      });
      if (data.truncated) {
        const label = document.createElement("p");
        label.textContent = "Preview limited to the first 256 KB";
        fragment.append(label);
      }
    }
    view.replaceChildren(fragment);
    view.scrollTop = 0;
    if (narrow.matches) setFilesOpen(false);
    setViewer("source");
    highlightFiles();
  } catch (error) {
    if (version === previewRequest) status(error.message, true);
  }
}

function renderInputs() {
  const inputs = [...selected.values()];
  byId("selected-files").replaceChildren(...inputs.map((entry) => {
    const chip = document.createElement("span");
    const remove = document.createElement("button");
    chip.className = "chip";
    chip.title = entry.path;
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Remove " + entry.name);
    remove.addEventListener("click", () => {
      selected.delete(entry.path);
      renderInputs();
    });
    chip.append(entry.name, remove);
    return chip;
  }));
  const elf = inputs[0]?.kind === "elf";
  for (const name of ["compiler", "flags"]) form.elements.namedItem(name).disabled = elf;
  const cxx = inputs.some((entry) => /\.(cc|cpp|cxx|c\+\+|C)$/.test(entry.name));
  byId("compiler").placeholder = cxx ? "clang++" : "clang";
  const primary = inputs.find((entry) => entry.kind !== "header");
  const firstPath = primary?.path ?? "";
  byId("working-directory").placeholder = firstPath.split("/").slice(0, -1).join("/") || ".";
  byId("input-empty").hidden = Boolean(primary);
  for (const button of runButtons) button.disabled = !primary || jobs.has(button.value);
  for (const button of stopButtons) button.hidden = !jobs.get(button.dataset.stop)?.id;
  highlightFiles();
}

function toggleInput(entry) {
  if (selected.has(entry.path)) selected.delete(entry.path);
  else {
    if (entry.kind === "elf" || [...selected.values()].some((input) => input.kind === "elf")) {
      selected.clear();
    }
    selected.set(entry.path, entry);
  }
  renderInputs();
}

function setViewer(next) {
  viewer = next;
  const report = reports[next];
  const showSource = next === "source" && Boolean(preview);
  const showReport = Boolean(report);
  for (const tab of viewerTabs) tab.setAttribute("aria-pressed", tab.dataset.view === next);
  byId("source-view").hidden = !showSource;
  for (const name of Object.keys(frames)) frames[name].hidden = !showReport || name !== next;
  byId("empty-view").hidden = showSource || showReport;
  byId("empty-title").textContent = next === "source" ? "No file selected" : "No " + modeLabel(next) + " report";
  byId("viewer-name").textContent = showSource ? preview.path : "";
  const updated = byId("report-updated");
  updated.hidden = !report?.updatedAt;
  if (report?.updatedAt) {
    updated.dateTime = report.updatedAt;
    updated.textContent = reportDate.format(new Date(report.updatedAt));
  }
  const download = byId("export-report");
  download.hidden = !showReport;
  if (showReport) download.href = report.url + "?download=1";
  byId("expand-report").hidden = !showReport && !workspace.classList.contains("expanded");
  if (next !== "source") showRunOutput(next);
}

function modeLabel(mode) {
  return mode === "profile" ? "Profile" : "Trace";
}

function showRunOutput(mode) {
  outputMode = mode;
  const output = byId("run-output");
  output.textContent = runOutputs.get(mode) ?? "";
  output.scrollTop = output.scrollHeight;
}

async function monitorRun(run) {
  try {
    const result = await request("api/jobs/" + run.id + "?offset=" + run.offset);
    run.offset = result.offset;
    const output = byId("run-output");
    if (result.output) {
      runOutputs.set(run.mode, runOutputs.get(run.mode) + result.output);
      if (run.mode === outputMode) {
        output.append(document.createTextNode(result.output));
        output.scrollTop = output.scrollHeight;
      }
    }
    if (result.state === "running" || result.output) {
      setTimeout(() => monitorRun(run), 150);
      return;
    }
    jobs.delete(run.mode);
    if (result.state === "complete") {
      const url = "reports/" + run.id;
      reports[run.mode] = { url, updatedAt: result.updated_at };
      frames[run.mode].src = url;
      if (viewer === run.mode) setViewer(run.mode);
      if (!byId("job-status").classList.contains("error")) showRunningJobs();
    } else {
      status(modeLabel(run.mode) + (result.state === "cancelled" ? " stopped" : " failed"), result.state === "failed");
    }
  } catch (error) {
    jobs.delete(run.mode);
    status(error.message, true);
  }
  renderInputs();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const mode = event.submitter?.value ?? "profile";
  if (jobs.has(mode) || ![...selected.values()].some((entry) => entry.kind !== "header")) return;
  const options = Object.fromEntries(new FormData(form));
  if (!options.cwd.trim()) delete options.cwd;
  const run = { mode, id: null, offset: 0 };
  jobs.set(mode, run);
  renderInputs();
  showRunningJobs();
  runOutputs.set(mode, "");
  setViewer(mode);
  setConsole(true, "output");
  try {
    const result = await request("api/jobs", {
      ...options, mode, inputs: [...selected.keys()], "no-source": options["no-source"] === "on",
    });
    run.id = result.id;
    renderInputs();
    monitorRun(run);
  } catch (error) {
    jobs.delete(mode);
    status(error.message, true);
    renderInputs();
  }
});

for (const button of stopButtons) {
  button.addEventListener("click", async () => {
    const job = jobs.get(button.dataset.stop);
    if (!job?.id) return;
    button.disabled = true;
    try {
      await request("api/jobs/" + job.id + "/cancel", {});
    } catch (error) {
      status(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
}

let shell = null, terminalOffset = 0, shellOpen = false, openingShell = false, shellVersion = 0;
let terminalInput = Promise.resolve();
let lastSize = "";

function terminalStatus(message) {
  if (shell) shell.writeln("\r\n" + message);
}

function terminalSize() {
  const container = byId("shell");
  const screen = container.querySelector(".xterm-screen");
  if (!screen?.clientWidth) return { rows: 12, columns: 80 };
  return {
    rows: Math.max(1, Math.min(500, Math.floor((container.clientHeight - 16) * shell.rows / screen.clientHeight))),
    columns: Math.max(2, Math.min(500, Math.floor((container.clientWidth - 23) * shell.cols / screen.clientWidth))),
  };
}

function fitTerminal() {
  if (!shell || byId("shell").hidden || byId("console-body").hidden || !byId("shell").clientHeight) return;
  const { rows, columns } = terminalSize();
  const size = rows + ":" + columns;
  if (size === lastSize) return;
  lastSize = size;
  shell.resize(columns, rows);
  if (shellOpen) request("api/terminal/resize", { rows, columns }).catch((error) => terminalStatus(error.message));
}

async function pollTerminal(version) {
  try {
    const result = await request("api/terminal?offset=" + terminalOffset);
    if (version !== shellVersion) return;
    terminalOffset = result.offset;
    if (result.output) shell.write(Uint8Array.from(atob(result.output), (char) => char.charCodeAt(0)));
    if (!result.finished) {
      setTimeout(() => pollTerminal(version), byId("console-body").hidden ? 750 : 100);
      return;
    }
    terminalStatus("Terminal exited");
  } catch (error) {
    if (version !== shellVersion) return;
    terminalStatus(error.message);
  }
  shellOpen = false;
}

async function openTerminal() {
  if (openingShell) return;
  if (!shell) {
    const style = getComputedStyle(byId("shell"));
    const paper = style.getPropertyValue("--paper").trim();
    const text = style.getPropertyValue("--text").trim();
    const accent = style.getPropertyValue("--accent").trim();
    const muted = style.getPropertyValue("--muted").trim();
    shell = new Terminal({
      fontFamily: style.getPropertyValue("--mono").trim(),
      fontSize: 13,
      theme: {
        background: paper, foreground: text, cursor: accent, cursorAccent: paper,
        selectionBackground: "#d9e8ff",
        black: text, red: "#a62932", green: "#197040", yellow: "#805700",
        blue: accent, magenta: "#803ea0", cyan: "#006d78", white: muted,
        brightBlack: muted, brightRed: "#b83440", brightGreen: "#117b4e", brightYellow: "#8c6200",
        brightBlue: "#285eb5", brightMagenta: "#9647ae", brightCyan: "#047884", brightWhite: "#334867",
      },
      scrollback: 3000,
    });
    shell.open(byId("shell"));
    shell.onData((data) => {
      const version = shellVersion;
      terminalInput = terminalInput.then(() => {
        if (shellOpen && version === shellVersion) return request("api/terminal/input", { data });
      }).catch((error) => terminalStatus(error.message));
    });
    new ResizeObserver(fitTerminal).observe(byId("shell"));
  }
  if (!shellOpen) {
    openingShell = true;
    const version = ++shellVersion;
    terminalOffset = 0;
    try {
      const size = terminalSize();
      await request("api/terminal/open", { ...size, cwd: folder });
      shell.reset();
      shellOpen = true;
      lastSize = "";
      fitTerminal();
      pollTerminal(version);
    } catch (error) {
      terminalStatus(error.message);
    } finally {
      openingShell = false;
    }
  }
  if (consoleView === "terminal" && !byId("console-body").hidden) shell.focus();
}

function setConsole(open, next = consoleView) {
  consoleView = next;
  const terminal = next === "terminal";
  byId("console-body").hidden = !open;
  const toggle = byId("toggle-console");
  toggle.setAttribute("aria-expanded", open);
  toggle.setAttribute("aria-label", open ? "Collapse bottom panel" : "Expand bottom panel");
  byId("show-terminal").setAttribute("aria-pressed", terminal);
  byId("show-output").setAttribute("aria-pressed", !terminal);
  byId("shell").hidden = !terminal;
  byId("run-output").hidden = terminal;
  if (open && terminal) openTerminal();
}

for (const tab of viewerTabs) tab.addEventListener("click", () => setViewer(tab.dataset.view));
byId("toggle-files").addEventListener("click", () => setFilesOpen(byId("files").hidden));
byId("refresh-files").addEventListener("click", () => browse(folder));
byId("parent-dir").addEventListener("click", () => browse(parent));
byId("expand-report").addEventListener("click", (event) => {
  const expanded = workspace.classList.toggle("expanded");
  event.currentTarget.setAttribute("aria-pressed", expanded);
  event.currentTarget.textContent = expanded ? "Restore" : "Expand";
  setViewer(viewer);
});
byId("toggle-console").addEventListener("click", () => {
  setConsole(byId("console-body").hidden);
});
byId("show-terminal").addEventListener("click", () => setConsole(true, "terminal"));
byId("show-output").addEventListener("click", () => setConsole(true, "output"));

setFilesOpen(!narrow.matches);
browse();
request("api/config").then((config) => {
  for (const [name, value] of Object.entries(config)) {
    const input = form.elements.namedItem(name);
    if (!input.value) input.value = value;
  }
}).catch((error) => status(error.message, true));
