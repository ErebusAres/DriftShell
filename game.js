"use strict";

// DriftShell: local, hackmud-inspired terminal sim (single-player, offline).
// This is a lightweight homage: scripts are code you can edit and call,
// security levels gate cross-script calls, and locs are breached via lock stacks.

const GAME_TITLE = "DriftShell";
const GAME_ID = "driftshell";
const LEGACY_SAVE_KEY = "hackterm_save_v1";
const LEGACY_SCRATCH_KEY_PREFIX = "hackterm_scratch_v1:";

const SAVE_KEY = `${GAME_ID}_save_v1`;
const SEC_LEVELS = ["NULLSEC", "LOWSEC", "MIDSEC", "HIGHSEC", "FULLSEC"];
const PRIMER_PAYLOAD = "DRIFTLOCAL::SEED=7|11|23|5|13|2";
const WARDEN_PAYLOAD = "WARDEN::PHASE=1|KEY=RELIC|TRACE=4";
const UPLINK_PAYLOAD = "UPLINK::PATCH=1|RELAY=MIRROR";
const UPGRADE_DEFS = {
  "upg.trace_spool": {
    name: "trace_spool",
    apply: () => {
      state.traceMax = Math.min(9, state.traceMax + 2);
    },
    describe: "Increases TRACE limit by +2.",
  },
  "upg.coolant": {
    name: "coolant",
    apply: () => {
      state.trace = Math.max(0, state.trace - 2);
    },
    describe: "Reduces current TRACE by 2.",
  },
  "upg.modem": {
    name: "modem",
    apply: () => {},
    describe: "Improves download speed (~40% faster).",
  },
  "upg.backbone": {
    name: "backbone",
    apply: () => {},
    describe: "Major download speed upgrade (~55% faster).",
  },
  "upg.drive_ext": {
    name: "drive_ext",
    apply: () => {
      state.driveMax = Math.max(state.driveMax || 0, 80_000);
    },
    describe: "Expands drive capacity for downloaded text/cipher files.",
  },
  "upg.siphon": {
    name: "siphon",
    apply: () => {},
    describe: "Enables an optional background GC siphon (risky).",
  },
};

function secRank(level) {
  const idx = SEC_LEVELS.indexOf(level);
  return idx === -1 ? 0 : idx;
}

function checksumUtf8Mod4096(text) {
  const bytes = new TextEncoder().encode(String(text || ""));
  let sum = 0;
  bytes.forEach((b) => {
    sum += b;
  });
  return sum % 4096;
}

function hex3(n) {
  const v = Math.max(0, Math.min(4095, Number(n) || 0));
  return v.toString(16).toUpperCase().padStart(3, "0");
}

function expectedForChecksumPayload(payload) {
  const handle = state.handle ? String(state.handle) : "ghost";
  return hex3(checksumUtf8Mod4096(`${payload}|HANDLE=${handle}`));
}

const screen = document.getElementById("screen");
const input = document.getElementById("cmd");
const prompt = document.getElementById("prompt");
const statusLine = document.getElementById("status-line");
const gcSpan = document.getElementById("gc");
const traceSpan = document.getElementById("trace");
const hint = document.getElementById("hint");
const chatLog = document.getElementById("chat-log");
const chatInput = document.getElementById("chat-input");
const chatChannelLabel = document.getElementById("chat-channel");
const scratchPad = document.getElementById("scratch-pad");
const scratchClear = document.getElementById("scratch-clear");
const quickLinks = document.getElementById("quick-links");

let saveDirty = false;
let autosaveTimer = null;
let autosaveInterval = null;
let lastAutosaveAt = 0;
let siphonInterval = null;
const AUTOSAVE_MIN_INTERVAL_MS = 15_000;
const AUTOSAVE_FORCE_INTERVAL_MS = 60_000;
const NON_DIRTY_COMMANDS = new Set([
  "help",
  "scripts",
  "ls",
  "downloads",
  "drive",
  "uploads",
  "inventory",
  "channels",
  "contacts",
  "jobs",
  "diagnose",
]);

function setCorruption(enabled) {
  setCorruptionLevel(enabled ? 1 : 0);
}

function corruptionLevel() {
  if (state.flags.has("corrupt3")) return 3;
  if (state.flags.has("corrupt2")) return 2;
  if (state.flags.has("corrupt1") || state.flags.has("corruption")) return 1;
  return 0;
}

function applyCorruptionClasses() {
  const level = corruptionLevel();
  document.body.classList.toggle("corrupt", level > 0);
  document.body.classList.toggle("corrupt1", level === 1);
  document.body.classList.toggle("corrupt2", level === 2);
  document.body.classList.toggle("corrupt3", level === 3);
}

function setCorruptionLevel(level) {
  const n = Math.max(0, Math.min(3, Number(level) || 0));
  state.flags.delete("corruption");
  state.flags.delete("corrupt1");
  state.flags.delete("corrupt2");
  state.flags.delete("corrupt3");
  if (n >= 1) state.flags.add("corrupt1");
  if (n >= 2) state.flags.add("corrupt2");
  if (n >= 3) state.flags.add("corrupt3");
  applyCorruptionClasses();
}

function markDirty() {
  saveDirty = true;
  scheduleAutosave();
}

function scheduleAutosave() {
  if (!state.handle) return;
  if (autosaveTimer) return;
  autosaveTimer = window.setTimeout(() => {
    autosaveTimer = null;
    autoSaveNow();
  }, 3000);
}

function autoSaveNow() {
  if (!state.handle) return;
  if (state.editor) return;
  const now = Date.now();
  const stale = now - lastAutosaveAt >= AUTOSAVE_FORCE_INTERVAL_MS;
  if (!saveDirty && !stale) return;
  if (now - lastAutosaveAt < AUTOSAVE_MIN_INTERVAL_MS) return;

  saveState({ silent: true });
  saveDirty = false;
  lastAutosaveAt = now;
}

function ensureAutosaveLoop() {
  if (autosaveInterval) return;
  autosaveInterval = window.setInterval(() => autoSaveNow(), 5000);
  window.addEventListener("beforeunload", () => {
    try {
      saveState({ silent: true });
    } catch {}
  });
}

function siphonPayout(level) {
  if (level === "high") return { gc: 10, heat: 12 };
  if (level === "med") return { gc: 5, heat: 6 };
  return { gc: 2, heat: 3 };
}

function getUploadedFile(locName, fileName) {
  const loc = String(locName || "").trim();
  const file = String(fileName || "").trim();
  if (!loc || !file) return null;
  const bucket = state.uploads && state.uploads[loc] && state.uploads[loc].files;
  if (!bucket) return null;
  const entry = bucket[file];
  return entry ? { loc, file, ...entry } : null;
}

function parseSiphonScriptOutput(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const first = raw.split("\n")[0].trim();

  // JSON: {"gc":2,"heat":3}
  if (first.startsWith("{") && first.endsWith("}")) {
    try {
      const obj = JSON.parse(first);
      const gc = Number(obj.gc);
      const heat = Number(obj.heat);
      if (!Number.isFinite(gc) || !Number.isFinite(heat)) return null;
      return { gc, heat };
    } catch {
      return null;
    }
  }

  // KV: gc=2 heat=3
  const mGc = first.match(/\bgc\s*=\s*(-?\d+(\.\d+)?)\b/i);
  const mHeat = first.match(/\bheat\s*=\s*(-?\d+(\.\d+)?)\b/i);
  if (mGc || mHeat) {
    const gc = mGc ? Number(mGc[1]) : NaN;
    const heat = mHeat ? Number(mHeat[1]) : NaN;
    if (!Number.isFinite(gc) || !Number.isFinite(heat)) return null;
    return { gc, heat };
  }

  return null;
}

function runSiphonScript(code, args) {
  const out = [];
  const sandbox = {
    print: (msg) => out.push(String(msg)),
    scratch: () => {},
    handle: () => String(state.handle || "ghost"),
    util: {
      checksum: (text) => checksumUtf8Mod4096(text),
      hex3: (n) => hex3(n),
    },
    files: () => [],
    read: () => null,
    discover: () => {},
    flag: () => {},
    flagged: () => false,
    addItem: () => {},
    hasItem: () => false,
    call: () => {},
    loc: () => state.loc,
  };

  const fn = new Function("ctx", "args", `"use strict";\n${String(code || "")}`);
  fn(sandbox, args || {});
  return out.join("\n");
}

function ensureSiphonLoop() {
  if (siphonInterval) {
    window.clearInterval(siphonInterval);
    siphonInterval = null;
  }
  if (!state.handle) return;
  if (!state.upgrades.has("upg.siphon")) return;
  if (!state.siphon || !state.siphon.on) return;

  siphonInterval = window.setInterval(() => {
    if (!state.handle) return;
    if (!state.upgrades.has("upg.siphon")) return;
    if (!state.siphon || !state.siphon.on) return;

    const lvl = state.siphon.level || "low";
    let payout = siphonPayout(lvl);

    if (state.siphon.mode === "script" && state.siphon.source) {
      const src = state.siphon.source;
      const up = getUploadedFile(src.loc, src.file);
      if (!up) {
        writeLine("sys::siphon.script missing; disabled", "warn");
        state.siphon.on = false;
        ensureSiphonLoop();
        markDirty();
        return;
      }
      try {
        const output = runSiphonScript(up.content, {
          level: lvl,
          heat: Number(state.siphon.heat) || 0,
        });
        const parsed = parseSiphonScriptOutput(output);
        if (parsed) payout = parsed;
      } catch (err) {
        writeLine("sys::siphon.script error; disabled", "warn");
        state.siphon.on = false;
        ensureSiphonLoop();
        markDirty();
        return;
      }
    }

    const gc = Math.max(0, Math.min(20, Math.floor(Number(payout.gc) || 0)));
    const heat = Math.max(0, Math.min(30, Math.floor(Number(payout.heat) || 0)));
    state.gc += gc;
    state.siphon.heat = (Number(state.siphon.heat) || 0) + heat;

    // Risk: too much heat triggers a TRACE spike.
    const threshold = lvl === "high" ? 40 : lvl === "med" ? 60 : 90;
    const jitterChance = lvl === "high" ? 0.22 : lvl === "med" ? 0.12 : 0.06;
    if (state.siphon.heat >= threshold || Math.random() < jitterChance) {
      state.siphon.heat = Math.max(0, state.siphon.heat - 35);
      writeLine("sys::siphon.flagged TRACE +1", "warn");
      failBreach();
      chatPost({
        channel: dmChannel("juniper"),
        from: "juniper",
        body: "Your siphon is loud. Dial it back or get cut loose.",
      });
    }

    updateHud();
    markDirty();
  }, 15_000);
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exportSave() {
  const payload = {
    game: GAME_ID,
    title: GAME_TITLE,
    version: 1,
    exportedAt: new Date().toISOString(),
    data: getSaveData(),
  };
  downloadTextFile(`${GAME_ID}-save.json`, JSON.stringify(payload, null, 2));
  writeLine("Save exported.", "ok");
}

function importSaveObject(obj) {
  if (!obj || typeof obj !== "object") {
    writeLine("Import failed: invalid JSON.", "error");
    return false;
  }
  const data = obj.data && typeof obj.data === "object" ? obj.data : obj;
  if (!data || typeof data !== "object") {
    writeLine("Import failed: missing data.", "error");
    return false;
  }
  if (!data.handle) {
    writeLine("Import failed: missing handle.", "error");
    return false;
  }
  localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  loadState({ silent: true });
  writeLine("Save imported and loaded.", "ok");
  return true;
}

const importPicker =
  typeof document !== "undefined"
    ? (() => {
        const el = document.createElement("input");
        el.type = "file";
        el.accept = "application/json";
        el.style.display = "none";
        el.addEventListener("change", async () => {
          const file = el.files && el.files[0];
          el.value = "";
          if (!file) return;
          try {
            const text = await file.text();
            const obj = JSON.parse(text);
            importSaveObject(obj);
          } catch (err) {
            writeLine(
              "Import failed: " + (err && err.message ? err.message : "invalid file"),
              "error"
            );
          }
        });
        document.body.appendChild(el);
        return el;
      })()
    : null;

function writeLine(text, kind) {
  const line = document.createElement("div");
  line.className = `line${kind ? " " + kind : ""}`;
  renderTerminalRich(line, String(text));
  screen.appendChild(line);
  screen.scrollTop = screen.scrollHeight;
}

function writeBlock(text, kind) {
  if (!text) {
    writeLine("", kind);
    return;
  }
  String(text)
    .split("\n")
    .forEach((line) => writeLine(line, kind));
}

function renderChat() {
  if (!chatLog) return;
  chatLog.innerHTML = "";
  if (chatChannelLabel) chatChannelLabel.textContent = state.chat.channel;
  const messages = state.chat.log.filter((m) => {
    const channel = m.channel || state.chat.channel;
    if (String(channel).startsWith("@")) return true; // DMs are always shown inline
    return channel === state.chat.channel;
  });
  messages.forEach((m) => {
    const row = document.createElement("div");
    row.className = "chat-msg";

    const time = document.createElement("span");
    time.className = "chat-time";
    time.textContent = chatTime(m.t);

    const colorClass = m.kind === "system" ? "dim" : m.color || userColorClass(m.from);
    const uidText = document.createElement("span");
    uidText.className = "uid-text";
    uidText.textContent = String(m.uid || (m.kind === "system" ? "----" : userId4(m.from)));

    const body = document.createElement("span");
    body.className = "chat-body";

    const channel = String(m.channel || state.chat.channel);
    if (channel.startsWith("@")) {
      const dir = document.createElement("span");
      dir.className = "chat-dm-dir dim";
      dir.textContent = m.from === state.handle ? ">>" : "<<";
      body.appendChild(dir);
      body.appendChild(document.createTextNode(" "));

      const tag = document.createElement("span");
      tag.className = "chat-dm-tag tok magenta";
      tag.textContent = channel;
      body.appendChild(tag);
      body.appendChild(document.createTextNode(" "));
    }

    const nameSpan = document.createElement("span");
    nameSpan.className =
      "chat-name " + (m.kind === "system" ? "dim" : colorClass);
    nameSpan.textContent = m.kind === "system" ? "sys" : m.from;
    body.appendChild(nameSpan);
    body.appendChild(document.createTextNode(" :: "));
    const msgSpan = document.createElement("span");
    renderTerminalRich(msgSpan, String(m.body));
    body.appendChild(msgSpan);

    row.appendChild(time);
    row.appendChild(uidText);
    row.appendChild(body);
    chatLog.appendChild(row);
  });
  chatLog.scrollTop = chatLog.scrollHeight;
}

const SCRATCH_KEY_PREFIX = `${GAME_ID}_scratch_v1:`;
let scratchSaveTimer = null;

function scratchKey() {
  const handle = state.handle ? String(state.handle) : "default";
  return SCRATCH_KEY_PREFIX + handle.toLowerCase();
}

function loadScratchFromStorage() {
  if (!scratchPad) return;
  const key = scratchKey();
  const raw = localStorage.getItem(key);
  if (raw !== null) {
    scratchPad.value = raw;
    return;
  }
  // Migrate legacy scratch (pre-rename) once.
  const handle = state.handle ? String(state.handle) : "default";
  const legacyKey = LEGACY_SCRATCH_KEY_PREFIX + handle.toLowerCase();
  const legacy = localStorage.getItem(legacyKey);
  if (legacy !== null) {
    scratchPad.value = legacy;
    localStorage.setItem(key, legacy);
  }
}

function saveScratchToStorage() {
  if (!scratchPad) return;
  localStorage.setItem(scratchKey(), scratchPad.value);
}

function scheduleScratchSave() {
  if (!scratchPad) return;
  if (scratchSaveTimer) window.clearTimeout(scratchSaveTimer);
  scratchSaveTimer = window.setTimeout(() => {
    scratchSaveTimer = null;
    saveScratchToStorage();
  }, 250);
}

function scratchAppend(text) {
  if (!scratchPad) return;
  const line = String(text ?? "").trimEnd();
  if (!line) return;
  const prefix = scratchPad.value && !scratchPad.value.endsWith("\n") ? "\n" : "";
  scratchPad.value = scratchPad.value + prefix + line + "\n";
  scheduleScratchSave();
}

function chatTime(epochMs) {
  const date = new Date(epochMs || Date.now());
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}${mm}`;
}

function hashString32(input) {
  // FNV-1a
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function userColorClass(name) {
  const n = String(name || "user");
  const idx = hashString32(n.toLowerCase()) % 12;
  return "userc" + idx;
}

function userId4(name) {
  const n = String(name || "user");
  const val = hashString32("uid:" + n.toLowerCase()) & 0xffff;
  return val.toString(16).toUpperCase().padStart(4, "0");
}

let knownNamesCacheKey = "";
let knownNamesCacheRegex = null;

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getKnownNamesRegex() {
  const names = new Set();
  if (state.handle) names.add(state.handle);
  Object.keys(NPCS).forEach((n) => names.add(n));
  state.chat.log.slice(-200).forEach((m) => {
    if (m && m.from) names.add(String(m.from));
  });

  const list = Array.from(names)
    .map((n) => String(n).trim())
    .filter((n) => n.length && n.toLowerCase() !== "trust")
    .sort((a, b) => b.length - a.length);

  const key = list.join("|").toLowerCase();
  if (key === knownNamesCacheKey) return knownNamesCacheRegex;
  knownNamesCacheKey = key;

  if (!list.length) {
    knownNamesCacheRegex = null;
    return null;
  }

  const alt = list.map(escapeRegex).join("|");
  // Word-ish boundaries that include underscores.
  knownNamesCacheRegex = new RegExp(`(?<![A-Za-z0-9_])(${alt})(?![A-Za-z0-9_])`, "gi");
  return knownNamesCacheRegex;
}

function renderTerminalRich(container, text) {
  // Light token highlighting to mimic hackmud coloring.
  // Keep it safe: create spans, don't inject HTML.
  const nameRegex = getKnownNamesRegex();
  const patterns = [
    { re: /\bscripts\.trust(?:\.[a-zA-Z0-9_.]+)?\b/g, cls: "tok trust" },
    { re: /\b(FULLSEC|HIGHSEC|MIDSEC|LOWSEC|NULLSEC)\b/g, cls: "tok sec" },
    { re: /\bkit\.[a-zA-Z0-9_]+\b/g, cls: "tok kit" },
    { re: /(^|[\s])([#@][a-zA-Z0-9_-]+)/g, cls: "tok chan", group: 2 },
    ...(nameRegex
      ? [
          {
            re: nameRegex,
            dynamic: (raw) => userColorClass(raw),
          },
        ]
      : []),
    // File-like tokens: base dim + extension lime (common hackmud vibe).
    {
      re: /\b([a-zA-Z0-9_-]+)\.(s|txt|log|b64|rot13|sig|dat|upg|key|arc)\b/g,
      cls: "tok file",
      file: true,
    },
  ];

  const segments = [];
  let cursor = 0;
  const matches = [];
  patterns.forEach((p) => {
    let m;
    while ((m = p.re.exec(text))) {
      const idx = p.group ? m.index + m[0].indexOf(m[p.group]) : m.index;
      const raw = p.group ? m[p.group] : m[0];
      matches.push({
        start: idx,
        end: idx + raw.length,
        cls: p.dynamic ? p.dynamic(raw) : p.cls,
        raw,
        file: Boolean(p.file),
        fileBase: p.file ? m[1] : null,
        fileExt: p.file ? m[2] : null,
      });
      if (m.index === p.re.lastIndex) p.re.lastIndex++;
    }
  });

  // Prefer "stronger" semantic matches (trust/sec/channel) over file tokens.
  const clsPriority = (cls, file) => {
    if (cls.includes("trust")) return 5;
    if (cls.includes("sec")) return 4;
    if (cls.includes("chan")) return 3;
    if (cls.includes("kit")) return 2;
    if (file) return 1;
    return 0;
  };
  matches.sort(
    (a, b) =>
      a.start - b.start ||
      clsPriority(b.cls, b.file) - clsPriority(a.cls, a.file) ||
      b.end - a.end
  );

  const nonOverlapping = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.start < lastEnd) continue;
    nonOverlapping.push(m);
    lastEnd = m.end;
  }

  container.textContent = "";
  nonOverlapping.forEach((m) => {
    if (cursor < m.start) segments.push({ kind: "text", raw: text.slice(cursor, m.start) });
    if (m.file) {
      segments.push({ kind: "tok", raw: m.fileBase, cls: "tok filebase" });
      segments.push({ kind: "text", raw: "." });
      segments.push({ kind: "tok", raw: m.fileExt, cls: "tok ext" });
    } else {
      segments.push({ kind: "tok", raw: text.slice(m.start, m.end), cls: m.cls });
    }
    cursor = m.end;
  });
  if (cursor < text.length) segments.push({ kind: "text", raw: text.slice(cursor) });

  const frag = document.createDocumentFragment();
  segments.forEach((s) => {
    if (s.kind === "text") {
      frag.appendChild(document.createTextNode(s.raw));
      return;
    }
    const span = document.createElement("span");
    span.className = s.cls;
    span.textContent = s.raw;
    frag.appendChild(span);
  });
  container.appendChild(frag);
}

function chatPost({ channel, from, body, kind }) {
  const resolvedFrom = from || state.handle || "ghost";
  const resolvedKind = kind || "user";
  state.chat.log.push({
    t: Date.now(),
    channel: channel || state.chat.channel,
    from: resolvedFrom,
    body: String(body || ""),
    kind: resolvedKind,
    color: resolvedKind === "system" ? null : userColorClass(resolvedFrom),
    uid: resolvedKind === "system" ? "----" : userId4(resolvedFrom),
  });
  renderChat();
}

function chatSystem(body) {
  chatPost({ from: "sys", body, kind: "system" });
}

function chatJoin(channel) {
  if (!channel.startsWith("#") && !channel.startsWith("@")) channel = "#" + channel;
  // Joining wipes the current channel buffer (IRC-style) but preserves DMs.
  state.chat.log = state.chat.log.filter((m) => String(m.channel || "").startsWith("@"));
  state.chat.channels.add(channel);
  state.chat.channel = channel;
  chatSystem("joined " + channel + " (buffer cleared)");
}

function chatSwitch(channel) {
  // Single-channel view; switch behaves like join.
  chatJoin(channel);
}

function chatHelp() {
  chatSystem("chat commands: /help, /join #chan, /switch #chan, /channels, /tell <npc> <msg>");
}

const NPCS = {
  switchboard: {
    id: "switchboard",
    display: "switchboard",
    intro:
      "I route you. I don't save you. Type `tutorial` to pull the route overlay, or `help` for examples.",
  },
  juniper: {
    id: "juniper",
    display: "juniper",
    intro:
      "Welcome to my exchange. I sell junk, not morals. Ask for `work` if you want a contract.",
  },
  archivist: {
    id: "archivist",
    display: "archivist",
    intro:
      "The Sable Archive isn’t a place. It’s a habit. Bring me a sigil and I’ll bring you a door.",
  },
  weaver: {
    id: "weaver",
    display: "weaver",
    intro:
      "We stitch meaning onto noise. Tokens, marks, masks. Don’t confuse them.",
  },
};

function npcKnown(id) {
  return state.npcs.known.has(id);
}

function npcIntroduce(id) {
  const npc = NPCS[id];
  if (!npc) return;
  if (!npcKnown(id)) state.npcs.known.add(id);
  chatPost({ channel: "#kernel", from: npc.display, body: npc.intro });
}

function dmChannel(npcId) {
  return "@" + npcId;
}

function ensureDm(npcId) {
  const chan = dmChannel(npcId);
  state.chat.channels.add(chan);
  if (!npcKnown(npcId)) npcIntroduce(npcId);
}

function npcReply(npcId, body) {
  const msg = String(body || "").toLowerCase();

  if (npcId === "switchboard") {
    if (msg.includes("chk") || msg.includes("checksum helper") || msg.includes("example")) {
      chatPost({
        channel: dmChannel(npcId),
        from: "switchboard",
        body:
          "If you want the slow, clean way: `edit chk` and write it line-by-line. If you want speed: `edit chk --example`.",
      });
      chatPost({
        channel: dmChannel(npcId),
        from: "switchboard",
        body:
          "Line 1: read the primer -> `const primer = ctx.read('primer.dat') || ''` (gets the payload text).",
      });
      chatPost({
        channel: dmChannel(npcId),
        from: "switchboard",
        body:
          "Line 2: extract payload -> find `payload=` and strip it (so you don't hardcode secrets).",
      });
      chatPost({
        channel: dmChannel(npcId),
        from: "switchboard",
        body:
          "Line 3: bind to YOU -> `text = payload + '|HANDLE=' + ctx.handle()` (locks are handle-dependent).",
      });
      chatPost({
        channel: dmChannel(npcId),
        from: "switchboard",
        body:
          "Line 4: compute + format -> `ctx.util.checksum(text)` then `ctx.util.hex3(sum)` then `ctx.print(out)`.",
      });
      chatPost({
        channel: dmChannel(npcId),
        from: "switchboard",
        body: "Check your work any time: `cat " + (state.handle || "you") + ".chk`.",
      });
      return;
    }
    if (msg.includes("checksum") || msg.includes("primer")) {
      chatPost({
        channel: dmChannel(npcId),
        from: "switchboard",
        body:
          "Checksums are habits. Read the payload, append your handle, compute. In scripts: `ctx.util.checksum(text)` then `ctx.util.hex3(n)`.",
      });
      return;
    }
    if (msg.includes("warden")) {
      chatPost({
        channel: dmChannel(npcId),
        from: "switchboard",
        body:
          "The Warden isn't security. It's a reflex. It punishes hesitation. Precompute what you can before you breach.",
      });
      return;
    }
    if (msg.includes("why") || msg.includes("drift") || msg.includes("what")) {
      chatPost({
        channel: dmChannel(npcId),
        from: "switchboard",
        body:
          "The Drift isn't a place. It's what happened when people taught systems to lie politely. We live in the leftover behavior.",
      });
      chatPost({
        channel: dmChannel(npcId),
        from: "switchboard",
        body:
          "Signals lead to locks, locks lead to stories. Keep notes. Write scripts to survive repetition.",
      });
      return;
    }
    if (msg.includes("hint") || msg.includes("lost")) {
      const current = tutorialCurrent();
      chatPost({
        channel: dmChannel(npcId),
        from: "switchboard",
        body: current ? `Route: ${current.title} - ${current.hint}` : "Type `tutorial` to pull the route overlay.",
      });
      return;
    }
    if (msg.includes("script")) {
      chatPost({
        channel: dmChannel(npcId),
        from: "switchboard",
        body:
          "Local scripts are JS. You get `ctx` and `args`. Example: `ctx.print(JSON.stringify(args))`.",
      });
      chatPost({
        channel: dmChannel(npcId),
        from: "switchboard",
        body: "Try: `edit echo` then save with `:wq`, then `call <your_handle>.echo msg=\"hi\"`.",
      });
      return;
    }
    if (msg.includes("upload") || msg.includes("uplink")) {
      chatPost({
        channel: dmChannel(npcId),
        from: "switchboard",
        body:
          "Uploads are how you push your work back into the net. Connect `relay.uplink` to unlock remote upload routing.",
      });
      chatPost({
        channel: dmChannel(npcId),
        from: "switchboard",
        body:
          "Flow: `drive` to list downloaded files; `upload drive:loc/file relay.uplink` or `upload <you>.patch patch.s`. Track with `uploads`.",
      });
      return;
    }
    chatPost({
      channel: dmChannel(npcId),
      from: "switchboard",
      body: "Ask `why`, ask for a `hint`, or ask about `scripts`.",
    });
    return;
  }

  if (npcId === "juniper") {
    if (msg.includes("work")) {
      chatPost({
        channel: dmChannel(npcId),
        from: "juniper",
        body:
          "Contract: pull `mask.dat` (use `download spoof.s` then `call kit.spoof`). Bring it back here and say `turnin mask`.",
      });
      state.flags.add("q_juniper_mask");
      return;
    }
    if (msg.includes("turnin") && msg.includes("mask")) {
      if (!state.inventory.has("mask.dat")) {
        chatPost({
          channel: dmChannel(npcId),
          from: "juniper",
          body: "You don't have the mask. Don't waste my time.",
        });
        return;
      }
      if (state.flags.has("q_juniper_mask_done")) {
        chatPost({
          channel: dmChannel(npcId),
          from: "juniper",
          body: "Already paid.",
        });
        return;
      }
      state.flags.add("q_juniper_mask_done");
      state.gc += 50;
      chatPost({
        channel: dmChannel(npcId),
        from: "juniper",
        body: "Clean enough. +50GC. Tip: breach `archives.arc` once you’ve got the ember phrase.",
      });
      updateHud();
      return;
    }
    if (msg.includes("locks")) {
      chatPost({
        channel: dmChannel(npcId),
        from: "juniper",
        body:
          "Locks aren't doors, they're conversations. You don't guess-you collect. Files, phrases, habits. Then you answer like you meant it.",
      });
      return;
    }
    if (msg.includes("pier")) {
      chatPost({
        channel: dmChannel(npcId),
        from: "juniper",
        body: "A pier on a dead net? Cute. If you see a clean edge, it's bait. Still-bait can pay.",
      });
      return;
    }
    chatPost({
      channel: dmChannel(npcId),
      from: "juniper",
      body: "Say `work` for a contract, or ask about `locks`, `scripts`, or `trace`.",
    });
    return;
  }

  if (npcId === "archivist") {
    if (msg.includes("sigil") || msg.includes("lattice")) {
      if (!state.flags.has("lattice_sigil")) {
        chatPost({
          channel: dmChannel(npcId),
          from: "archivist",
          body: "Bring me the words, not the vibe. Decode `key.b64` in the archive.",
        });
        return;
      }
      chatPost({
        channel: dmChannel(npcId),
        from: "archivist",
        body: "Good. Now find the cache. The lattice reads tokens and marks.",
      });
      return;
    }
    if (msg.includes("drift") || msg.includes("archive")) {
      chatPost({
        channel: dmChannel(npcId),
        from: "archivist",
        body:
          "The archive keeps what the Drift tries to forget. Every operator leaves fingerprints. Some catalog them. Some erase them.",
      });
      return;
    }
    if (msg.includes("warden") || msg.includes("relic")) {
      chatPost({
        channel: dmChannel(npcId),
        from: "archivist",
        body:
          "The Warden is a lie the net tells itself so it can sleep. If you wake the relic, you'll inherit the lie-or break it.",
      });
      return;
    }
    chatPost({
      channel: dmChannel(npcId),
      from: "archivist",
      body: "Ask about `sigil` or `the drift`.",
    });
    return;
  }

  if (npcId === "weaver") {
    if (msg.includes("token") || msg.includes("splice")) {
      chatPost({
        channel: dmChannel(npcId),
        from: "weaver",
        body:
          "Token recipe: badge.sig + mask.dat + weaver.mark. Run `call kit.splice` after you download it.",
      });
      return;
    }
    if (msg.includes("marks")) {
      chatPost({
        channel: dmChannel(npcId),
        from: "weaver",
        body:
          "Marks are receipts. They prove you were somewhere without telling anyone how you got in. Some locks respect that.",
      });
      return;
    }
    if (msg.includes("slipper") || msg.includes("seam") || msg.includes("hole")) {
      chatPost({
        channel: dmChannel(npcId),
        from: "weaver",
        body:
          "Seams are where the Drift forgets to pretend. If you found one, don't brag. Stitch it shut-or crawl through quietly.",
      });
      return;
    }
    chatPost({
      channel: dmChannel(npcId),
      from: "weaver",
      body: "Ask about `token`, `ghost`, or `marks`.",
    });
    return;
  }

  chatPost({ channel: dmChannel(npcId), from: npcId, body: "…" });
}

function tellNpc(npcId, message) {
  const id = String(npcId || "").toLowerCase().trim();
  if (!id) {
    writeLine("Usage: tell <npc> <message>", "warn");
    return;
  }
  if (!NPCS[id]) {
    writeLine("Unknown NPC. Try `contacts`.", "warn");
    return;
  }
  ensureDm(id);
  const text = String(message || "").trim();
  if (!text) {
    chatPost({ channel: dmChannel(id), from: state.handle || "ghost", body: "(ping)" });
  } else {
    chatPost({ channel: dmChannel(id), from: state.handle || "ghost", body: text });
  }
  state.flags.add("told_anyone");
  tutorialAdvance();
  npcReply(id, text);
}

function listContacts() {
  writeLine("CONTACTS", "header");
  Array.from(state.npcs.known)
    .sort()
    .forEach((id) => {
      const npc = NPCS[id];
      writeLine(`- ${id}${npc ? " (" + npc.display + ")" : ""}`, "dim");
    });
  writeLine("Tip: `tell juniper hi`", "dim");
}

function splitArgs(inputText) {
  const text = String(inputText || "");
  const parts = [];
  let current = "";
  let quote = null; // "'" | '"'

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current.length) parts.push(current);
  return parts;
}

function parseScriptArgs(tokens) {
  const args = { _: [] };
  tokens.forEach((token) => {
    if (token.includes("=")) {
      const [key, value] = token.split("=", 2);
      args[key] = value;
    } else {
      args._.push(token);
    }
  });
  return args;
}

const state = {
  handle: null,
  loc: "home.hub",
  gc: 120,
  discovered: new Set(["home.hub", "training.node", "public.exchange", "sable.gate"]),
  unlocked: new Set(["home.hub", "public.exchange"]),
  inventory: new Set(),
  drive: {},
  kit: {},
  userScripts: {},
  uploads: {},
  flags: new Set(),
  marks: new Set(),
  upgrades: new Set(),
  trace: 0,
  traceMax: 4,
  driveMax: 12_000,
  siphon: { on: false, level: "low", heat: 0, mode: "fixed", source: null },
  lockoutUntil: 0,
  wait: { lastAt: 0, streak: 0 },
  lastCipher: null,
  breach: null,
  editor: null,
  history: [],
  historyIndex: 0,
  chat: {
    channel: "#kernel",
    channels: new Set(["#kernel"]),
    log: [],
  },
  confirm: null,
  tutorial: {
    enabled: true,
    stepIndex: 0,
    completed: new Set(),
  },
  npcs: {
    known: new Set(["switchboard"]),
  },
  downloads: {
    active: null,
    queue: [],
  },
};

const MARKS = [
  { id: "mark.scan", text: "Run scripts.trust.scan" },
  { id: "mark.download", text: "Download a script from a loc" },
  { id: "mark.edit", text: "Create a script with edit" },
  { id: "mark.breach", text: "Breach a lock stack" },
  { id: "mark.install", text: "Install an upgrade" },
];

const LOCS = {
  "home.hub": {
    title: "HUB/HOME",
    desc: [
      "A sterile hub and a dead net outside the glass.",
      "The prompt waits. The drift is quiet tonight.",
    ],
    requirements: {},
    locks: [],
    links: ["training.node", "public.exchange", "sable.gate"],
    files: {
      "readme.txt": {
        type: "text",
        content: [
          "DRIFTSHELL//BOOTSTRAP",
          "This shell simulates a dead net for training and salvage.",
          "",
          "Core commands:",
          "  scripts                  list scripts",
          "  call <script> [args]     run a script",
          "  edit <name>              create or overwrite a script",
          "  connect <loc>            jump to a loc",
          "  breach <loc>             start lock sequence",
          "  unlock <answer>          submit an answer to the active lock",
          "  ls / cat / download      file operations",
          "  decode rot13|b64         decode the last cipher file",
          "  inventory                list items and kit",
          "  save / load              save or load",
          "  export / import          move saves between browsers",
        ].join("\n"),
      },
      "primer.dat": {
        type: "text",
        content: [
          "PRIMER.DAT",
          "",
          "You want to feel like a hacker? Stop guessing.",
          "Collect. Compute. Answer.",
          "",
          "ALGO: checksum(text) = (sum of UTF-8 bytes) % 4096",
          "Format as 3-hex (uppercase). Example: 00A, 8EB, FFF",
          "",
          "payload=" + PRIMER_PAYLOAD,
          "text = payload + '|HANDLE=<your_handle>'",
          "",
          "Target: training.node lock expects checksum(text).",
        ].join("\n"),
      },
      "chk.example": {
        type: "text",
        content: [
          "CHK.EXAMPLE",
          "Paste this into `edit chk` and save with `:wq`.",
          "",
          "const primer = ctx.read('primer.dat') || '';",
          "const payloadLine = (primer.split('\\n').find(l => l.startsWith('payload=')) || '');",
          "const payload = payloadLine.replace('payload=','').trim();",
          "if (!payload) { ctx.print('no payload'); return; }",
          "const text = payload + '|HANDLE=' + ctx.handle();",
          "const sum = ctx.util.checksum(text);",
          "const out = ctx.util.hex3(sum);",
          "ctx.print(out);",
        ].join("\n"),
      },
      "message.txt": {
        type: "text",
        content: [
          "FROM: SWITCHBOARD",
          "SUBJ: ember signal",
          "",
          "We caught a pulse in the Drift. It points at the Sable Archive.",
          "Follow the ember. Bring back what you can. Decide if it should",
          "leave the net or stay buried.",
          "",
          "Start by running scripts.trust.scan, then pull a kit script.",
        ].join("\n"),
      },
      "pier.note": {
        type: "text",
        content: [
          "PIER.NOTE",
          "",
          "If the Drift ever offers you a pier, it's not offering you water.",
          "It's offering you an edge where rules fall off.",
          "",
          "Code phrase: PIER//OPEN",
        ].join("\n"),
      },
    },
  },
  "training.node": {
    title: "LAB/TRAINING",
    desc: [
      "A sandboxed node with a single purpose: teach you to compute.",
      "No prize. Just competence.",
    ],
    requirements: {},
    locks: [
      {
        prompt: "LOCK: provide primer checksum (hex3)",
        answer: () => expectedForChecksumPayload(PRIMER_PAYLOAD),
        hint: "Read primer.dat at home.hub. Answer is checksum(payload|HANDLE=<your_handle>).",
      },
    ],
    links: ["home.hub"],
    files: {
      "lab.log": {
        type: "text",
        content: [
          "LAB LOG",
          "If you cleared this, you're ready to leave the lab.",
          "Next: connect public.exchange, pull tools, breach gates.",
          "",
          "Tip: write helper scripts. Example:",
          "  edit chk",
          "  ctx.read('primer.dat')",
          "  compute the checksum",
          "  ctx.print(result)",
        ].join("\n"),
      },
    },
  },
  "public.exchange": {
    title: "SCRAP EXCHANGE",
    desc: [
      "A low signal bazaar built from scavenged hardware.",
      "Deals are cheap. Trust is not.",
    ],
    requirements: {},
    locks: [],
    links: ["home.hub", "sable.gate", "weaver.den"],
    files: {
      "stall.log": {
        type: "text",
        content: [
          "SCRAP EXCHANGE LOG",
          "Juniper keeps old routines in plain sight.",
          "Run tracer.s to map the edge. Spoof a mask with spoof.s.",
          "Sniffer pulses find hidden dens. Use sniffer.s.",
        ].join("\n"),
      },
      "cipher.txt": {
        type: "text",
        cipher: true,
        content: "rzore vf gur qevsg",
      },
      "badge.sig": {
        type: "item",
        item: "badge.sig",
        content: [
          "BADGE.SIG",
          "Issuer: Lotus-Kline perimeter",
          "Signature: 9f3a-77b1",
        ].join("\n"),
      },
      "tracer.s": {
        type: "script",
        script: {
          name: "tracer",
          sec: "FULLSEC",
          code: [
             "// @sec FULLSEC",
             "ctx.print('Tracer online. Mesh resolving...');",
             "ctx.flag('trace_open');",
             "ctx.discover(['archives.arc','pier.gate','relay.uplink']);",
           ].join("\n"),
         },
        content: [
          "/* tracer.s */",
          "function main(ctx,args){",
          "  // Map the perimeter mesh and expose reachable locs.",
          "}",
        ].join("\n"),
      },
      "spoof.s": {
        type: "script",
        script: {
          name: "spoof",
          sec: "FULLSEC",
          code: [
            "// @sec FULLSEC",
            "if (ctx.hasItem('mask.dat')) { ctx.print('Mask already minted.'); return; }",
            "ctx.addItem('mask.dat');",
            "ctx.print('Mask minted: mask.dat');",
          ].join("\n"),
        },
        content: [
          "/* spoof.s */",
          "function main(ctx,args){",
          "  // Spoof a temporary mask signature.",
          "}",
        ].join("\n"),
      },
      "sniffer.s": {
        type: "script",
        script: {
          name: "sniffer",
          sec: "HIGHSEC",
          code: [
            "// @sec HIGHSEC",
            "if (ctx.flagged('sniffer_run')) { ctx.print('Sniffer already swept the quiet bands.'); return; }",
            "ctx.flag('sniffer_run');",
            "ctx.discover(['weaver.den','corp.audit','lattice.cache','monument.beacon']);",
            "ctx.print('Weaver phrase acquired: THREAD THE DRIFT');",
            "ctx.print('Sniffer pulse complete.');",
          ].join("\n"),
        },
        content: [
          "/* sniffer.s */",
          "function main(ctx,args){",
          "  // Sweep the quiet bands for hidden signals.",
          "}",
        ].join("\n"),
      },
    },
  },
  "pier.gate": {
    title: "EMBER.PIER//GATE",
    desc: [
      "A thin gate on the edge of the mesh.",
      "It doesn't look locked so much as unwilling.",
    ],
    requirements: { flags: ["trace_open"] },
    locks: [
      {
        prompt: "LOCK: pier phrase",
        answer: "PIER//OPEN",
        hint: "Read pier.note at home.hub.",
      },
    ],
    links: ["public.exchange"],
    files: {
      "edge.log": {
        type: "text",
        content: [
          "EDGE LOG",
          "Somewhere out there is a pier the old operators used to watch the Drift breathe.",
          "If you're reading this, you're about to.",
        ].join("\n"),
      },
    },
  },
  "ember.pier": {
    title: "EMBER.PIER",
    desc: [
      "A dock made of dead protocols and glowing headers.",
      "The Drift laps at your feet like a hungry dog that learned your name.",
    ],
    requirements: { flags: ["trace_open"], items: ["badge.sig"] },
    locks: [],
    links: ["pier.gate", "sable.gate"],
    files: {
      "pier.log": {
        type: "text",
        content: [
          "EMBER PIER",
          "You watch the Drift compile itself in real time.",
          "Packets that should be local drift past like weather.",
          "",
          "Somebody tagged the pier with a warning:",
          "  'Don't look for meaning. You'll find it anyway.'",
        ].join("\n"),
      },
      "pier.b64": {
        type: "text",
        cipher: true,
        content: "QUNUIEkgRkVFTDogWU9VJ1JFIEEgSEFDS0VS",
      },
    },
  },
  "sable.gate": {
    title: "PERIMETER.GATE",
    desc: [
      "The Lotus-Kline perimeter still hums with old security.",
      "A quiet node, a long memory.",
    ],
    requirements: {},
    locks: [
      {
        prompt: "LOCK: badge.sig required",
        answer: "badge.sig",
        hint: "Pull badge.sig from the exchange.",
      },
      {
        prompt: "LOCK: respond with the ember phrase",
        answer: "EMBER IS THE DRIFT",
        hint: "Decode rot13: `rzore vf gur qevsg` (see cipher.txt at public.exchange).",
      },
    ],
    links: ["home.hub", "public.exchange", "archives.arc"],
    files: {
      "access.log": {
        type: "text",
        content: [
          "PERIMETER ACCESS LOG",
          "Gate rejects unmasked access. Badge required.",
          "Attached note looks like rot13. See cipher.txt.",
        ].join("\n"),
      },
      "cipher.txt": {
        type: "text",
        cipher: true,
        content: "rzore vf gur qevsg",
      },
    },
  },
  "archives.arc": {
    title: "SABLE ARCHIVE",
    desc: [
      "Cold stacks of memory and a faint relay tone.",
      "The archive is here, waiting.",
    ],
    requirements: { items: ["mask.dat"], flags: ["trace_open"] },
    locks: [
      {
        prompt: "LOCK: mask.dat required",
        answer: "mask.dat",
        hint: "Use spoof.s at the exchange to mint the mask.",
      },
    ],
    links: ["sable.gate", "lattice.cache"],
    files: {
      "lore.log": {
        type: "text",
        content: [
          "SABLE ARCHIVE INDEX",
          "The archive remembers the first operators and the patch that",
          "turned the net to drift. A relay called the Relic is folded",
          "inside. The old manifest warns: sigil stored in base64.",
          "",
          "Pull fork.s to split the relay channel.",
        ].join("\n"),
      },
      "key.b64": { type: "text", cipher: true, content: "U0lHSUw6IExBVFRJQ0U=" },
      "fork.s": {
        type: "script",
        script: {
          name: "fork",
          sec: "MIDSEC",
          code: [
            "// @sec MIDSEC",
            "if (ctx.flagged('forked')) { ctx.print('Relay already forked.'); return; }",
            "ctx.flag('forked');",
            "ctx.discover(['core.relic']);",
            "ctx.print('Relay forked. Core channel exposed.');",
          ].join("\n"),
        },
        content: [
          "/* fork.s */",
          "function main(ctx,args){",
          "  // Split a relay channel to expose the core.",
          "}",
        ].join("\n"),
      },
    },
  },
  "relay.uplink": {
    title: "RELAY/UPLINK",
    desc: [
      "A maintenance uplink. Half-dead, still listening.",
      "It accepts payloads like it misses being useful.",
    ],
    requirements: { flags: ["trace_open"] },
    locks: [],
    links: ["public.exchange", "sable.gate", "archives.arc"],
    files: {
      "uplink.req": {
        type: "text",
        content: [
          "RELAY.UPLINK :: PATCH SLOT",
          "",
          "This node accepts uploads. Think: you push a payload, the net runs it, the door blinks.",
          "",
          "Goal: craft a script that prints the expected checksum for your handle.",
          "",
          "payload=" + UPLINK_PAYLOAD,
          "text = payload + '|HANDLE=<your_handle>'",
          "expected = checksum(text) formatted as 3-hex (uppercase)",
          "",
          "Suggested flow:",
          "  edit patch",
          "  (write code that computes the checksum and ctx.print()s it)",
          "  :wq",
          "  upload <your_handle>.patch patch.s",
          "  call scripts.trust.uplink.sync",
          "",
          "Note: this is optional. It's a clean way to practice: scripts + uploads + verification.",
        ].join("\n"),
      },
    },
  },
  "mirror.gate": {
    title: "MIRROR/GATE",
    desc: [
      "A thin door in the Drift. A reflection that doesn't match you.",
      "It only opens for operators who can prove they compute instead of guess.",
    ],
    requirements: { flags: ["uplink_patched"] },
    locks: [],
    links: ["relay.uplink", "sable.gate"],
    files: {
      "mirror.log": {
        type: "text",
        content: [
          "MIRROR.GATE",
          "",
          "Behind the maintenance uplink is a soft door nobody wrote down.",
          "It doesn't care about your badge or your mask.",
          "It cares that you can reproduce a value on demand.",
          "",
          "If the Drift can make you do that, it can make you do worse.",
        ].join("\n"),
      },
      "coolant.upg": {
        type: "upgrade",
        item: "upg.coolant",
        content: [
          "UPG.COOLANT",
          "A cold pack for your mistakes.",
          "Install to reduce current TRACE by 2.",
        ].join("\n"),
      },
    },
  },
  "weaver.den": {
    title: "WEAVER.DEN",
    desc: [
      "A low-lit workshop of stitched code and soft voices.",
      "The Weavers trade in patterns and provenance.",
    ],
    requirements: { flags: ["sniffer_run"] },
    locks: [
      {
        prompt: "LOCK: supply a weave phrase",
        answer: "THREAD THE DRIFT",
        hint: "Run sniffer first. It prints the phrase.",
      },
    ],
    links: ["public.exchange", "corp.audit", "lattice.cache"],
    files: {
      "weaver.log": {
        type: "text",
        content: [
          "WEAVER.DEN LOG",
          "Bring proof of thread. The lattice cache honors a token spliced",
          "from badge.sig + mask.dat + weaver.mark. Use splice.s.",
          "Ghost your trail with ghost.s to reach the corporate audit node.",
          "",
          "Weave phrase: THREAD THE DRIFT",
        ].join("\n"),
      },
      "weaver.mark": {
        type: "item",
        item: "weaver.mark",
        content: ["WEAVER.MARK", "A stitched glyph accepted by those who know."].join(
          "\n"
        ),
      },
      "splice.s": {
        type: "script",
        script: {
          name: "splice",
          sec: "MIDSEC",
          code: [
            "// @sec MIDSEC",
            "const need = ['badge.sig','mask.dat','weaver.mark'].filter(i => !ctx.hasItem(i));",
            "if (need.length) { ctx.print('Splice failed. Missing: ' + need.join(', ')); return; }",
            "if (ctx.hasItem('token.key')) { ctx.print('Token already forged.'); return; }",
            "ctx.addItem('token.key');",
            "ctx.print('Token forged: token.key');",
          ].join("\n"),
        },
        content: ["/* splice.s */", "function main(ctx,args){", "  // ...", "}"].join(
          "\n"
        ),
      },
      "ghost.s": {
        type: "script",
        script: {
          name: "ghost",
          sec: "LOWSEC",
          code: [
            "// @sec LOWSEC",
            "if (ctx.flagged('ghosted')) { ctx.print('Ghost protocol already active.'); return; }",
            "if (!ctx.hasItem('weaver.mark')) { ctx.print('Ghost protocol requires weaver.mark.'); return; }",
            "ctx.flag('ghosted');",
            "ctx.discover(['corp.audit']);",
            "ctx.print('Audit shard sequence: 3-1-4');",
            "ctx.print('Ghost protocol active. Trail is cold.');",
          ].join("\n"),
        },
        content: ["/* ghost.s */", "function main(ctx,args){", "  // ...", "}"].join(
          "\n"
        ),
      },
    },
  },
  "corp.audit": {
    title: "CORP.AUDIT",
    desc: ["An audit chamber lit by cold LEDs.", "Anything unmasked gets burned."],
    requirements: { flags: ["ghosted"] },
    locks: [
      {
        prompt: "LOCK: supply the shard sequence (3-1-4)",
        answer: "3-1-4",
        hint: "Run ghost.s; it prints the sequence.",
      },
    ],
    links: ["weaver.den"],
    files: {
      "audit.log": {
        type: "text",
        content: ["CORP AUDIT SUMMARY", "Sequence: 3-1-4"].join("\n"),
      },
      "relay.shard": {
        type: "item",
        item: "relay.shard",
        content: ["RELAY.SHARD", "Segment: LK-ACCT/relay", "Status: cold"].join("\n"),
      },
    },
  },
  "lattice.cache": {
    title: "LATTICE.CACHE",
    desc: [
      "A vault of interlocked lattice.",
      "The air tastes like static and old promises.",
    ],
    requirements: { items: ["token.key", "weaver.mark"], flags: ["lattice_sigil"] },
    locks: [
      {
        prompt: "LOCK: confirm lattice sigil",
        answer: "SIGIL: LATTICE",
        hint: "Decode key.b64 in the archive.",
      },
    ],
    links: ["archives.arc", "core.relic"],
    files: {
      "cache.log": {
        type: "text",
        content: [
          "LATTICE CACHE",
          "The lattice accepts the token and the weaver mark.",
          "The relic key rests inside.",
        ].join("\n"),
      },
      "warden.dat": {
        type: "text",
        content: [
          "WARDEN.DAT",
          "",
          "If you made it here, you're deep enough to attract attention.",
          "The Drift is noticing you back.",
          "",
          "ALGO: checksum(text) = (sum of UTF-8 bytes) % 4096, hex3 uppercase",
          "",
          "payload=" + WARDEN_PAYLOAD,
          "text = payload + '|HANDLE=<your_handle>'",
        ].join("\n"),
      },
      "warden.b64": {
        type: "text",
        cipher: true,
        content: "S0VFUCBUSEUgUkVMSUMgU0xFRVBJTkc=",
      },
      "relic.key": {
        type: "item",
        item: "relic.key",
        content: ["RELIC.KEY", "Access key for CORE RELIC."].join("\n"),
      },
    },
  },
  "core.relic": {
    title: "CORE RELIC",
    desc: [
      "A buried relay and a voice in the static.",
      "You can feel the drift pull at the edges.",
    ],
    requirements: { items: ["relay.shard", "relic.key"], flags: ["forked"] },
    locks: [
      {
        prompt: "WARDEN: checksum required (hex3)",
        answer: () => expectedForChecksumPayload(WARDEN_PAYLOAD),
        hint: "Compute from warden.dat at lattice.cache: checksum(payload|HANDLE=<your_handle>) -> hex3.",
      },
      {
        prompt: "WARDEN: recite the vow",
        answer: "KEEP THE RELIC SLEEPING",
        hint: "Decode warden.b64 at lattice.cache.",
      },
      {
        prompt: "WARDEN: confirm fork state",
        answer: "FORKED",
        hint: "You only get here by forking. Say it.",
      },
    ],
    links: ["lattice.cache"],
    files: {
      "core.log": {
        type: "text",
        content: [
          "CORE RELIC",
          "The relic wakes. It asks for a choice.",
          "",
          "Type: exfiltrate  - lift it out into a private shell",
          "Type: restore     - bind it back to the Drift",
        ].join("\n"),
      },
    },
  },
  "monument.beacon": {
    title: "MONUMENT.BEACON",
    desc: [
      "A public monument, half propaganda and half prayer.",
      "Somebody left a beacon lit in the drift like it wanted to be found.",
    ],
    requirements: { flags: ["sniffer_run"] },
    locks: [],
    links: ["public.exchange"],
    files: {
      "plaque.txt": {
        type: "text",
        content: [
          "PLAQUE",
          "A corporate motto carved into cheap alloy.",
          "Letters rubbed smooth: IN RISK WE TRUST",
        ].join("\n"),
      },
      "beacon.b64": {
        type: "text",
        cipher: true,
        content: "QkVBQ09OOiBTTElQUEVSIElOIFRIRSBEUklGVA==",
      },
      "coolant.upg": {
        type: "upgrade",
        item: "upg.coolant",
        content: [
          "UPGRADE: COOLANT",
          "A black-market coolant line. It can pull heat out of your trace.",
        ].join("\n"),
      },
    },
  },
  "echo.after": {
    title: "ECHO.AFTER",
    desc: [
      "A quiet channel that only exists after you touch the relic.",
      "Echoes loop here. Some are yours.",
    ],
    requirements: { flags: ["touched_relic"] },
    locks: [],
    links: ["home.hub"],
    files: {
      "echo.log": {
        type: "text",
        content: [
          "ECHO LOG",
          "If you carried the relic, you carry the consequences.",
          "If you restored it, you still altered the drift.",
        ].join("\n"),
      },
      "after_echo.txt": {
        type: "text",
        content: [
          "AFTER.ECHO",
          "You did it. The Warden screamed in machine-time, then fell silent.",
          "",
          "Victory doesn't feel like fireworks here.",
          "It feels like a room finally letting you breathe.",
          "",
          "But the Drift remembers operators by the shapes they leave behind.",
          "If you missed something, it will keep humming until you return.",
        ].join("\n"),
      },
      "spool.upg": {
        type: "upgrade",
        item: "upg.trace_spool",
        content: ["UPGRADE: TRACE_SPOOL", "Coils that widen your trace budget."].join(
          "\n"
        ),
      },
    },
  },
  "victory.hall": {
    title: "VICTORY.HALL",
    desc: [
      "A clean room that shouldn't exist in a corrupted net.",
      "Somebody built it as a promise: you can win and still be human.",
    ],
    requirements: { flags: ["touched_relic"] },
    locks: [],
    links: ["home.hub", "echo.after"],
    files: {
      "victory.log": {
        type: "text",
        content: [
          "VICTORY LOG",
          "You are standing in the afterimage of your own choices.",
          "Juniper would sell this moment for 50GC.",
          "Archivist would seal it in glass.",
          "Weaver would stitch it into a mark and call it proof.",
          "",
          "If you found the Slipper seam, you know: this isn't over.",
        ].join("\n"),
      },
    },
  },
  "slipper.hole": {
    title: "SLIPPER.HOLE",
    desc: [
      "A seam in the Drift you can only see after the beacon words land.",
      "It smells like burnt ozone and old formatting.",
    ],
    requirements: { flags: ["slipper_signal"] },
    locks: [],
    links: ["home.hub", "monument.beacon"],
    files: {
      "slipper.log": {
        type: "text",
        content: [
          "SLIPPER HOLE",
          "You shouldn't be able to route here on a local net.",
          "But the Drift doesn't care what 'local' means.",
          "",
          "Somebody left a note in a dead protocol:",
          "  'When you write scripts, you write yourself.'",
          "",
          "The rest is checksum noise.",
        ].join("\n"),
      },
      "glitch.rot13": {
        type: "text",
        cipher: true,
        content: "gur qevsg qbrfa'g gel gb oernx lbh. vg gebjf lbh.",
      },
    },
  },
};

function getLoc(name) {
  return LOCS[name] || null;
}

function discover(locs) {
  const newly = [];
  locs.forEach((loc) => {
    if (!state.discovered.has(loc)) {
      state.discovered.add(loc);
      newly.push(loc);
    }
  });
  return newly;
}

function setMark(id) {
  state.marks.add(id);
}

function listMarks() {
  writeLine("MARKS", "header");
  MARKS.forEach((mark) => {
    const done = state.marks.has(mark.id) ? "[X]" : "[ ]";
    writeLine(`${done} ${mark.text}`, "dim");
  });
}

function listLocs() {
  writeLine("LOCATIONS", "header");
  Array.from(state.discovered)
    .sort()
    .forEach((locName) => {
      const node = getLoc(locName);
      const unlocked = state.unlocked.has(locName) ? "OPEN" : "LOCKED";
      const title = node ? node.title : "UNKNOWN";
      writeLine(`${locName} [${unlocked}] :: ${title}`, "dim");
    });
}

function showLoc() {
  const loc = getLoc(state.loc);
  if (!loc) {
    writeLine("Unknown location.", "error");
    return;
  }
  writeLine(`:: ${state.loc} :: ${loc.title}`, "header");
  writeBlock(loc.desc.join("\n"), "dim");
}

function listFiles() {
  const loc = getLoc(state.loc);
  const names = Object.keys(loc.files || {});
  if (!names.length) {
    writeLine("No files.", "dim");
    return;
  }
  names.forEach((name) => {
    const entry = loc.files[name];
    writeLine(`${name} (${entry.type})`, "dim");
  });
}

const STORE_ITEMS = [
  {
    id: "upg.drive_ext",
    price: 80,
    when: () => true,
    desc: "Drive expansion (store more downloaded text/ciphers).",
  },
  {
    id: "upg.modem",
    price: 160,
    when: () => state.flags.has("trace_open"),
    desc: "Faster downloads (reliable).",
  },
  {
    id: "upg.coolant",
    price: 60,
    when: () => state.flags.has("trace_open"),
    desc: "Reduce TRACE now (install to apply).",
  },
  {
    id: "upg.siphon",
    price: 220,
    when: () => state.unlocked.has("sable.gate"),
    desc: "Background GC trickle (risk of TRACE spikes).",
  },
  {
    id: "upg.backbone",
    price: 420,
    when: () => state.unlocked.has("archives.arc"),
    desc: "Serious download acceleration (expensive).",
  },
];

function storeAvailable() {
  return state.loc === "public.exchange";
}

function listStore() {
  if (!storeAvailable()) {
    writeLine("No store at this loc.", "warn");
    writeLine("Tip: `connect public.exchange`", "dim");
    return;
  }
  writeLine("JUNIPER//STORE", "header");
  writeLine(`GC: ${state.gc}`, "dim");
  STORE_ITEMS.filter((it) => (it.when ? it.when() : true)).forEach((it) => {
    const owned = state.inventory.has(it.id) || state.upgrades.has(it.id);
    const label = owned ? "[OWNED]" : state.gc >= it.price ? "[BUY]" : "[LOCKED]";
    writeLine(`${label} ${it.id} :: ${it.price} GC`, "dim");
    writeLine(`  ${it.desc}`, "dim");
  });
  writeLine("Buy: `buy <item>`", "dim");
}

function buyItem(id) {
  if (!storeAvailable()) {
    writeLine("No store at this loc.", "warn");
    return;
  }
  const key = String(id || "").trim();
  if (!key) {
    writeLine("Usage: buy <item>", "warn");
    return;
  }
  const item = STORE_ITEMS.find((it) => it.id.toLowerCase() === key.toLowerCase());
  if (!item || (item.when && !item.when())) {
    writeLine("Item not available.", "warn");
    return;
  }
  if (state.inventory.has(item.id) || state.upgrades.has(item.id)) {
    writeLine("Already owned.", "dim");
    return;
  }
  if (state.gc < item.price) {
    writeLine("Insufficient GC.", "warn");
    return;
  }
  state.gc -= item.price;
  state.inventory.add(item.id);
  writeLine(`Purchased ${item.id} (-${item.price} GC)`, "ok");
  writeLine("Tip: `install " + item.id + "`", "dim");
  markDirty();
  updateHud();
}

function globToRegex(glob) {
  // Simple glob: * and ? only.
  const escaped = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp("^" + escaped + "$", "i");
}

function isDownloadableEntry(entry) {
  if (!entry) return false;
  if (entry.downloadable === false) return false;
  return (
    entry.type === "item" ||
    entry.type === "script" ||
    entry.type === "upgrade" ||
    entry.type === "text"
  );
}

function entrySize(entry) {
  if (!entry) return 0;
  const content = String(entry.content || "");
  if (entry.type === "script") {
    const code = String((entry.script && entry.script.code) || "");
    return content.length + code.length;
  }
  return content.length;
}

function driveBytesUsed() {
  const entries = Object.values(state.drive || {});
  let total = 0;
  entries.forEach((e) => {
    total += new TextEncoder().encode(String((e && e.content) || "")).length;
  });
  return total;
}

function driveId(locName, fileName) {
  return `${locName}/${fileName}`;
}

function driveRef(id) {
  return `drive:${id}`;
}

function getDriveEntry(ref) {
  const key = String(ref || "")
    .trim()
    .replace(/^drive:/i, "");
  if (!key) return null;
  const e = state.drive && state.drive[key];
  if (!e) return null;
  return { id: key, ...e };
}

function listDrive() {
  writeLine("DRIVE", "header");
  const keys = Object.keys(state.drive || {}).sort();
  if (!keys.length) {
    writeLine("(empty)", "dim");
    writeLine("Tip: `download cipher.txt` then `cat drive:sable.gate/cipher.txt`", "dim");
    return;
  }
  writeLine(`capacity: ${driveBytesUsed()}/${state.driveMax} bytes`, "dim");
  keys.slice(0, 40).forEach((k) => {
    const e = state.drive[k];
    const bytes = new TextEncoder().encode(String((e && e.content) || "")).length;
    writeLine(`${driveRef(k)}  (${bytes} bytes)`, "dim");
  });
  if (keys.length > 40) writeLine("...", "dim");
}

function delCommand(args) {
  const a = args || [];
  const target = String(a[0] || "").trim();
  if (!target) {
    writeLine("Usage: del drive:<loc>/<file> | del <your_handle>.<script> [--confirm]", "warn");
    return;
  }

  const drive = getDriveEntry(target);
  if (drive) {
    delete state.drive[drive.id];
    writeLine(`deleted ${driveRef(drive.id)}`, "ok");
    markDirty();
    return;
  }

  const confirm = a.includes("--confirm");
  const raw = target;
  const prefix = `${state.handle}.`;
  const name = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  if (!name || name.includes("/") || name.includes(":")) {
    writeLine("Unknown delete target.", "warn");
    return;
  }

  if (!state.userScripts || !state.userScripts[name]) {
    writeLine("Not a local script. Tip: you can only delete your own scripts.", "warn");
    return;
  }

  if (!confirm) {
    writeLine("Refusing to delete a script without confirmation.", "warn");
    writeLine(`Run: del ${state.handle}.${name} --confirm`, "dim");
    return;
  }

  delete state.userScripts[name];
  writeLine(`deleted ${state.handle}.${name}`, "ok");
  markDirty();
}

function ensureUploadsBucket(locName) {
  if (!state.uploads || typeof state.uploads !== "object") state.uploads = {};
  const cur = state.uploads[locName];
  if (!cur || typeof cur !== "object") {
    state.uploads[locName] = { files: {} };
    return state.uploads[locName];
  }
  if (!cur.files || typeof cur.files !== "object") cur.files = {};
  return cur;
}

function uploadTargetInfo(locName) {
  const bucket = ensureUploadsBucket(locName);
  const keys = Object.keys(bucket.files || {}).sort();
  return { bucket, keys };
}

function listUploads() {
  writeLine("UPLOADS", "header");
  const locs = Object.keys(state.uploads || {}).sort();
  if (!locs.length) {
    writeLine("(none)", "dim");
    writeLine("Tip: connect relay.uplink then `upload <script> relay.uplink`", "dim");
    return;
  }
  locs.forEach((locName) => {
    const { keys } = uploadTargetInfo(locName);
    if (!keys.length) return;
    writeLine(locName, "dim");
    keys.slice(0, 20).forEach((k) => {
      const u = state.uploads[locName].files[k];
      const tag = u && u.edited ? " edited" : "";
      const hash = u && u.hash ? ` ${u.hash}` : "";
      writeLine(`- ${k}${hash}${tag}`, "dim");
    });
    if (keys.length > 20) writeLine("...", "dim");
  });
}

function resolveUploadSource(source) {
  const s = String(source || "").trim();
  if (!s) return null;

  const drive = getDriveEntry(s);
  if (drive) {
    return {
      kind: "text",
      name: drive.name,
      content: String(drive.content || ""),
      edited: false,
      detail: driveRef(drive.id),
    };
  }

  const script = resolveScript(s);
  if (script && script.owner !== "scripts.trust") {
    return {
      kind: "script",
      name: `${script.name}.s`,
      content: String(script.code || ""),
      sec: script.sec,
      edited: script.owner !== "kit",
      detail: `${script.owner === "kit" ? "kit" : state.handle}.${script.name}`,
    };
  }

  return null;
}

function uploadCommand(args) {
  if (state.lockoutUntil && Date.now() < state.lockoutUntil) {
    writeLine("CONNECTION THROTTLED. WAIT.", "warn");
    return;
  }
  const a = args || [];
  const source = a[0];
  if (!source) {
    writeLine("Usage: upload <drive:loc/file|script> [loc|file|loc:file] [file]", "warn");
    return;
  }

  const src = resolveUploadSource(source);
  if (!src) {
    writeLine("Upload source not found. Tip: `drive` or `scripts`.", "warn");
    return;
  }

  let destLoc = state.loc;
  let destFile = null;

  if (a.length >= 3) {
    destLoc = a[1];
    destFile = a[2];
  } else if (a.length === 2) {
    const target = String(a[1] || "").trim();
    if (target.includes(":")) {
      const parts = target.split(":", 2);
      destLoc = parts[0] || destLoc;
      destFile = parts[1] || null;
    } else if (getLoc(target)) {
      destLoc = target;
    } else {
      destFile = target;
    }
  }

  if (!destFile) destFile = src.name || "upload.bin";

  const loc = getLoc(destLoc);
  if (!loc) {
    writeLine("Loc not found.", "error");
    return;
  }
  if (!state.discovered.has(destLoc)) {
    writeLine("Loc not discovered.", "warn");
    return;
  }
  if (!state.unlocked.has(destLoc)) {
    writeLine("Loc locked. Breach it first.", "warn");
    return;
  }

  if (destLoc !== state.loc && state.loc !== "relay.uplink") {
    writeLine("Remote upload requires `connect relay.uplink`.", "warn");
    return;
  }

  const content = String(src.content || "");
  const hash = hex3(checksumUtf8Mod4096(content));
  const bucket = ensureUploadsBucket(destLoc);
  bucket.files[destFile] = {
    kind: src.kind,
    from: state.handle,
    detail: src.detail,
    sec: src.sec || null,
    edited: !!src.edited,
    bytes: new TextEncoder().encode(content).length,
    hash,
    content,
    uploadedAt: Date.now(),
  };

  writeLine(`uploaded ${src.detail} -> ${destLoc}/${destFile} (${hash})`, "ok");
  markDirty();
  storyChatTick();
}

function scheduleDownload(locName, fileName) {
  const loc = getLoc(locName);
  const entry = loc && loc.files && loc.files[fileName];
  if (!entry || !isDownloadableEntry(entry)) return false;

  // Skip duplicates already acquired.
  if (entry.type === "item" && state.inventory.has(entry.item)) return false;
  if (entry.type === "upgrade" && state.inventory.has(entry.item)) return false;
  if (entry.type === "script" && state.kit[entry.script.name]) return false;
  if (entry.type === "text" && state.drive[driveId(locName, fileName)]) return false;

  const alreadyQueued =
    (state.downloads.active &&
      state.downloads.active.loc === locName &&
      state.downloads.active.file === fileName) ||
    state.downloads.queue.some((q) => q.loc === locName && q.file === fileName);
  if (alreadyQueued) return false;

  state.downloads.queue.push({ loc: locName, file: fileName });
  return true;
}

function startNextDownloadIfIdle() {
  if (state.downloads.active) return;
  const next = state.downloads.queue.shift();
  if (!next) {
    updateHud();
    return;
  }

  const loc = getLoc(next.loc);
  const entry = loc.files[next.file];
  const size = entrySize(entry);
  const base = 520;
  const scaled = Math.floor(size / 22);
  const jitter = Math.floor(Math.random() * 140);
  let durationMs = Math.max(520, Math.min(4200, base + scaled + jitter));
  if (state.upgrades.has("upg.modem")) durationMs = Math.floor(durationMs * 0.6);
  if (state.upgrades.has("upg.backbone")) durationMs = Math.floor(durationMs * 0.45);

  state.downloads.active = {
    loc: next.loc,
    file: next.file,
    durationMs,
    startedAt: Date.now(),
    timer: null,
    tick: null,
  };
  writeLine(`downloading ${next.file}...`, "dim");

  state.downloads.active.tick = window.setInterval(() => updateHud(), 120);
  state.downloads.active.timer = window.setTimeout(() => {
    completeActiveDownload();
  }, durationMs);
  updateHud();
}

function completeActiveDownload() {
  if (!state.downloads.active) return;
  const active = state.downloads.active;
  const loc = getLoc(active.loc);
  const entry = loc && loc.files && loc.files[active.file];

  if (active.tick) window.clearInterval(active.tick);
  if (active.timer) window.clearTimeout(active.timer);
  state.downloads.active = null;

  if (!entry || !isDownloadableEntry(entry)) {
    writeLine(`download failed: ${active.file}`, "error");
    startNextDownloadIfIdle();
    return;
  }

  // Apply acquisition
  if (entry.type === "item") {
    state.inventory.add(entry.item);
    writeLine(`download complete: ${active.file} -> ${entry.item}`, "ok");
  } else if (entry.type === "upgrade") {
    state.inventory.add(entry.item);
    writeLine(`download complete: ${active.file} -> ${entry.item}`, "ok");
    writeLine("Tip: install " + entry.item, "dim");
  } else if (entry.type === "script") {
    state.kit[entry.script.name] = {
      owner: "kit",
      name: entry.script.name,
      sec: entry.script.sec,
      code: entry.script.code,
    };
    writeLine(`download complete: ${active.file} -> kit.${entry.script.name}`, "ok");
    state.marks.add("mark.download");
  } else if (entry.type === "text") {
    const bytes = new TextEncoder().encode(String(entry.content || "")).length;
    if (driveBytesUsed() + bytes > state.driveMax) {
      writeLine("download failed: drive full", "error");
      writeLine("Tip: buy `upg.drive_ext` at the exchange (store), or delete saves / restart.", "dim");
      startNextDownloadIfIdle();
      return;
    }
    const id = driveId(active.loc, active.file);
    state.drive[id] = {
      loc: active.loc,
      name: active.file,
      content: String(entry.content || ""),
      cipher: !!entry.cipher,
      downloadedAt: Date.now(),
    };
    writeLine(`download complete: ${active.file} -> ${driveRef(id)}`, "ok");
  }
  markDirty();

  // Keep tutorial/story reactive.
  storyChatTick();
  tutorialAdvance();
  updateHud();
  startNextDownloadIfIdle();
}

function downloadCommand(pattern) {
  const target = String(pattern || "").trim();
  if (!target) {
    writeLine("Usage: download <file> | download *.s", "warn");
    return;
  }
  const loc = getLoc(state.loc);
  const files = Object.keys((loc && loc.files) || {});
  const isGlob = target.includes("*") || target.includes("?");

  const matches = isGlob
    ? files.filter((f) => globToRegex(target).test(f))
    : [target];

  if (!matches.length) {
    writeLine("No matches.", "warn");
    return;
  }

  let queued = 0;
  let skipped = 0;
  for (const name of matches) {
    const entry = loc.files[name];
    if (!entry) {
      skipped += 1;
      continue;
    }
    if (!isDownloadableEntry(entry)) {
      skipped += 1;
      continue;
    }
    const ok = scheduleDownload(state.loc, name);
    if (ok) queued += 1;
    else skipped += 1;
  }

  if (!queued) {
    writeLine("Nothing new to download.", "dim");
    return;
  }
  writeLine(`queued ${queued} download(s)${skipped ? ` (${skipped} skipped)` : ""}`, "dim");
  startNextDownloadIfIdle();
}

function downloadsStatus() {
  writeLine("DOWNLOADS", "header");
  if (state.downloads.active) {
    writeLine(`active: ${state.downloads.active.file}`, "dim");
  } else {
    writeLine("active: (none)", "dim");
  }
  if (state.downloads.queue.length) {
    writeLine("queue:", "dim");
    state.downloads.queue.slice(0, 12).forEach((q) => writeLine(`- ${q.file}`, "dim"));
    if (state.downloads.queue.length > 12) writeLine("...", "dim");
  } else {
    writeLine("queue: (empty)", "dim");
  }
}

function readFile(name) {
  const drive = getDriveEntry(name);
  if (drive) {
    writeBlock(drive.content, "dim");
    if (drive.cipher) state.lastCipher = drive.content;
    return;
  }
  const loc = getLoc(state.loc);
  const entry = loc.files[name];
  if (!entry) {
    const script = resolveScript(name);
    if (!script) {
      writeLine("File not found.", "error");
      return;
    }
    writeLine(`${script.owner}.${script.name} [${script.sec}]`, "header");
    if (script.owner === "scripts.trust") {
      writeLine("BUILTIN :: source not exposed", "dim");
      writeLine(`Run: call ${script.owner}.${script.name}`, "dim");
      return;
    }
    writeBlock(String(script.code || ""), "dim");
    return;
  }
  writeBlock(entry.content, "dim");
  if (String(name || "").toLowerCase() === "primer.dat") state.flags.add("read_primer");
  if (entry.cipher) {
    state.lastCipher = entry.content;
  }
}

function downloadFile(name) {
  const loc = getLoc(state.loc);
  const entry = loc.files[name];
  if (!entry) {
    writeLine("File not found.", "error");
    return;
  }
  if (!isDownloadableEntry(entry)) {
    writeLine("Nothing to download.", "warn");
    return;
  }
  const ok = scheduleDownload(state.loc, name);
  if (!ok) {
    writeLine("Already acquired or queued.", "dim");
    return;
  }
  writeLine("queued 1 download", "dim");
  startNextDownloadIfIdle();
}

function installUpgrade(itemId) {
  const key = String(itemId || "").trim();
  if (!key) {
    writeLine("Usage: install <upgrade>", "warn");
    return;
  }
  if (!state.inventory.has(key)) {
    writeLine("Upgrade not in inventory.", "warn");
    return;
  }
  const def = UPGRADE_DEFS[key];
  if (!def) {
    writeLine("Unknown upgrade.", "warn");
    return;
  }
  if (state.upgrades.has(key)) {
    writeLine("Upgrade already installed.", "dim");
    return;
  }
  def.apply();
  state.upgrades.add(key);
  writeLine(`Installed ${key}`, "ok");
  writeLine(def.describe, "dim");
  if (key === "upg.siphon") {
    writeLine("Tip: `siphon on` then `siphon set low|med|high`", "dim");
  }
  setMark("mark.install");
  markDirty();
  updateHud();
}

function waitTick() {
  const now = Date.now();
  if (!state.wait || typeof state.wait !== "object") state.wait = { lastAt: 0, streak: 0 };

  const since = now - (Number(state.wait.lastAt) || 0);
  const fast = since < 2200;
  state.wait.lastAt = now;
  state.wait.streak = fast ? (Number(state.wait.streak) || 0) + 1 : 0;

  writeLine("...waiting...", "dim");

  if (!fast) {
    if (state.trace > 0) state.trace -= 1;
    if (state.trace === 0) writeLine("trace is cold", "ok");
    storyChatTick();
    markDirty();
    return;
  }

  writeLine("still hot (don't spam wait)", "warn");
  // Light punishment: repeated spam can raise trace a bit.
  if (state.wait.streak >= 3 && Math.random() < 0.35) {
    writeLine("passive scan catches movement", "warn");
    failBreach();
  }
}

function siphonStatus() {
  writeLine("SIPHON", "header");
  if (!state.upgrades.has("upg.siphon")) {
    writeLine("not installed", "dim");
    writeLine("Tip: store -> buy upg.siphon, then `install upg.siphon`", "dim");
    return;
  }
  writeLine(`state: ${state.siphon && state.siphon.on ? "ON" : "OFF"}`, "dim");
  writeLine(`level: ${(state.siphon && state.siphon.level) || "low"}`, "dim");
  writeLine(`heat: ${Number((state.siphon && state.siphon.heat) || 0)}`, "dim");
  const mode = (state.siphon && state.siphon.mode) || "fixed";
  writeLine(`mode: ${mode}`, "dim");
  if (mode === "script" && state.siphon && state.siphon.source) {
    writeLine(`script: ${state.siphon.source.loc}:${state.siphon.source.file}`, "dim");
  }
  writeLine("Commands:", "dim");
  writeLine("  siphon on | siphon off | siphon set low|med|high", "dim");
  writeLine("  siphon use <loc:file>   (use an uploaded script for payout)", "dim");
  writeLine("  siphon clear            (back to fixed payout)", "dim");
}

function siphonCommand(args) {
  const a0 = String((args && args[0]) || "").toLowerCase();
  if (!a0 || a0 === "status") {
    siphonStatus();
    return;
  }
  if (!state.upgrades.has("upg.siphon")) {
    writeLine("Siphon not installed.", "warn");
    return;
  }
  if (!state.siphon || typeof state.siphon !== "object") {
    state.siphon = { on: false, level: "low", heat: 0, mode: "fixed", source: null };
  }

  if (a0 === "on") {
    state.siphon.on = true;
    writeLine("siphon enabled", "ok");
    ensureSiphonLoop();
    markDirty();
    return;
  }
  if (a0 === "off") {
    state.siphon.on = false;
    writeLine("siphon disabled", "dim");
    ensureSiphonLoop();
    markDirty();
    return;
  }
  if (a0 === "set") {
    const lvl = String((args && args[1]) || "").toLowerCase();
    if (!["low", "med", "high"].includes(lvl)) {
      writeLine("Usage: siphon set low|med|high", "warn");
      return;
    }
    state.siphon.level = lvl;
    writeLine("siphon level set: " + lvl, "ok");
    ensureSiphonLoop();
    markDirty();
    return;
  }

  if (a0 === "use") {
    const target = String((args && args[1]) || "").trim();
    if (!target || !target.includes(":")) {
      writeLine("Usage: siphon use <loc:file>", "warn");
      writeLine("Tip: upload a script first: `upload <you>.siphon relay.uplink:siphon.s`", "dim");
      return;
    }
    const [loc, file] = target.split(":", 2).map((s) => String(s || "").trim());
    const up = getUploadedFile(loc, file);
    if (!up) {
      writeLine("No uploaded file at that target.", "warn");
      writeLine("Tip: `uploads` to see what you pushed.", "dim");
      return;
    }
    if (up.kind !== "script") {
      writeLine("That upload isn't marked as a script, but I'll try to run it anyway.", "warn");
    }
    try {
      const output = runSiphonScript(up.content, {
        level: state.siphon.level || "low",
        heat: Number(state.siphon.heat) || 0,
      });
      const parsed = parseSiphonScriptOutput(output);
      if (!parsed) {
        writeLine("Script did not return a payout line.", "warn");
        writeLine("Expected: `ctx.print('gc=2 heat=3')` or JSON `{ \"gc\":2, \"heat\":3 }`", "dim");
        return;
      }
    } catch (err) {
      writeLine("Script failed to run: " + (err && err.message ? err.message : "error"), "error");
      return;
    }

    state.siphon.mode = "script";
    state.siphon.source = { loc, file };
    writeLine(`siphon script set: ${loc}:${file}`, "ok");
    ensureSiphonLoop();
    markDirty();
    return;
  }

  if (a0 === "clear") {
    state.siphon.mode = "fixed";
    state.siphon.source = null;
    writeLine("siphon script cleared", "dim");
    ensureSiphonLoop();
    markDirty();
    return;
  }

  writeLine("Usage: siphon on|off|set low|med|high|status", "warn");
}

function hookUi() {
  if (scratchClear && scratchPad) {
    scratchClear.addEventListener("click", () => {
      scratchPad.value = "";
      saveScratchToStorage();
      chatSystem("scratch cleared");
    });
  }
  if (scratchPad) {
    scratchPad.addEventListener("input", () => scheduleScratchSave());
  }
  if (quickLinks) {
    quickLinks.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const btn = target.closest("button[data-call]");
      if (!btn) return;
      const call = btn.getAttribute("data-call");
      if (!call) return;
      writeLine(`${prompt.textContent} call ${call}`, "dim");
      runScript(call, { _: [] });
      tutorialAdvance();
      updateHud();
    });
  }
}

function resetToFreshState(keepChat) {
  const priorChat = keepChat ? state.chat : null;
  state.handle = null;
  state.loc = "home.hub";
  state.gc = 120;
  state.discovered = new Set(["home.hub", "training.node", "public.exchange", "sable.gate"]);
  state.unlocked = new Set(["home.hub", "public.exchange"]);
  state.inventory = new Set();
  state.drive = {};
  state.kit = {};
  state.userScripts = {};
  state.uploads = {};
  state.flags = new Set();
  state.marks = new Set();
  state.upgrades = new Set();
  state.trace = 0;
  state.traceMax = 4;
  state.driveMax = 12_000;
  state.siphon = { on: false, level: "low", heat: 0, mode: "fixed", source: null };
  state.lockoutUntil = 0;
  state.wait = { lastAt: 0, streak: 0 };
  state.lastCipher = null;
  state.breach = null;
  state.editor = null;
  state.history = [];
  state.historyIndex = 0;
  state.confirm = null;
  state.tutorial = { enabled: true, stepIndex: 0, completed: new Set() };
  state.npcs = { known: new Set(["switchboard"]) };
  state.downloads = { active: null, queue: [] };
  state.chat = priorChat || {
    channel: "#kernel",
    channels: new Set(["#kernel"]),
    log: [],
  };
  renderChat();
  if (scratchPad) scratchPad.value = "";
  updateHud();
}

const TUTORIAL_STEPS = [
  {
    id: "t_handle",
    title: "Set Your Handle",
    hint: "Type any handle and press Enter.",
    check: () => Boolean(state.handle),
    onStart: () =>
      chatPost({ channel: "#kernel", from: "switchboard", body: "Pick a handle." }),
  },
  {
    id: "t_scan",
    title: "Scan For Signals",
    hint: "Run `scan`.",
    check: () => state.marks.has("mark.scan"),
    onStart: () =>
      chatPost({
        channel: "#kernel",
        from: "switchboard",
        body: "First rule: never walk blind. Run `scan`.",
      }),
  },
  {
    id: "t_primer",
    title: "Read The Primer",
    hint: "Run `cat primer.dat` at home.hub.",
    check: () => state.flags.has("read_primer"),
    onStart: () =>
      chatPost({
        channel: "#kernel",
        from: "switchboard",
        body: "Training first: read `primer.dat` at home.hub. The Drift respects operators who compute.",
      }),
  },
  {
    id: "t_edit",
    title: "Write Your First Script",
    hint: "Run `edit chk --example`, then `:wq` to save.",
    check: () => state.marks.has("mark.edit"),
    onStart: () =>
      chatPost({
        channel: "#kernel",
        from: "switchboard",
        body:
          "Make a helper script named `chk`. Easiest: `edit chk --example` then `:wq`. You can inspect it with `cat <your_handle>.chk`.",
      }),
  },
  {
    id: "t_user_run",
    title: "Run Your Script",
    hint: "Run `call <your_handle>.chk`.",
    check: () => state.flags.has("ran_user_script"),
    onStart: () =>
      chatPost({
        channel: "#kernel",
        from: "switchboard",
        body: "Your scripts take `ctx` and `args`. Try `help call ?` when you’re ready.",
      }),
  },
  {
    id: "t_training",
    title: "Open The Training Node",
    hint: "Run `breach training.node`, then `unlock <hex3>`, then `connect training.node`.",
    check: () => state.unlocked.has("training.node") && state.loc === "training.node",
    onStart: () =>
      chatPost({
        channel: "#kernel",
        from: "switchboard",
        body: "Use your checksum output to open `training.node`. No guessing.",
      }),
  },
  {
    id: "t_exchange",
    title: "Reach The Exchange",
    hint: "Run `connect public.exchange`.",
    check: () => state.loc === "public.exchange",
    onStart: () =>
      chatPost({
        channel: "#kernel",
        from: "switchboard",
        body: "Patch into the exchange: `connect public.exchange`.",
      }),
  },
  {
    id: "t_download",
    title: "Download A Script",
    hint: "Run `download tracer.s`.",
    check: () => Boolean(state.kit.tracer),
    onStart: () =>
      chatPost({
        channel: "#kernel",
        from: "juniper",
        body: "Grab tracer.s. If you break it, you bought it.",
      }),
  },
  {
    id: "t_run",
    title: "Run A Script",
    hint: "Run `call kit.tracer`.",
    check: () => state.flags.has("trace_open"),
    onStart: () =>
      chatPost({
        channel: "#kernel",
        from: "switchboard",
        body: "Run it: `call kit.tracer`.",
      }),
  },
  {
    id: "t_mask",
    title: "Mint A Mask",
    hint: "Run `download spoof.s`, then `call kit.spoof`.",
    check: () => state.inventory.has("mask.dat"),
    onStart: () =>
      chatPost({
        channel: "#kernel",
        from: "juniper",
        body: "You want the archive? You'll need a mask. Pull `spoof.s` and run it.",
      }),
  },
  {
    id: "t_badge",
    title: "Acquire Credentials",
    hint: "Run `download badge.sig`.",
    check: () => state.inventory.has("badge.sig"),
    onStart: () =>
      chatPost({
        channel: "#kernel",
        from: "juniper",
        body: "Badge is hot. Keep it anyway. `download badge.sig`.",
      }),
  },
  {
    id: "t_gate",
    title: "Decode The Ember Phrase",
    hint: "From the exchange: `connect public.exchange`, `cat cipher.txt`, then `decode rot13`.",
    check: () => state.flags.has("ember_phrase"),
    onStart: () =>
      chatPost({
        channel: "#kernel",
        from: "switchboard",
        body: "Read the rot13 note. Decode it. Then we go deeper.",
      }),
  },
  {
    id: "t_decode",
    title: "Breach The Gate",
    hint: "Run `breach sable.gate`, then `unlock badge.sig`, then `unlock EMBER IS THE DRIFT`.",
    check: () => state.unlocked.has("sable.gate"),
    onStart: () =>
      chatPost({
        channel: "#kernel",
        from: "switchboard",
        body: "Gate time. `breach sable.gate` and answer both locks.",
      }),
  },
  {
    id: "t_archive",
    title: "Breach The Archive",
    hint: "Run `breach archives.arc`, then `unlock mask.dat`, then `connect archives.arc`.",
    check: () => state.unlocked.has("archives.arc") && state.loc === "archives.arc",
    onStart: () =>
      chatPost({
        channel: "#kernel",
        from: "switchboard",
        body: "The Sable Archive is next. Bring your mask and don't spike trace.",
      }),
  },
  {
    id: "t_b64",
    title: "Pull The Lattice Sigil",
    hint: "Run `cat key.b64`, then `decode b64`.",
    check: () => state.flags.has("lattice_sigil"),
    onStart: () =>
      chatPost({
        channel: "#kernel",
        from: "archivist",
        body: "There is a sigil folded into base64. Read it clean.",
      }),
  },
  {
    id: "t_sniffer",
    title: "Find The Weaver",
    hint: "From exchange: `connect public.exchange`, `download sniffer.s`, then `call kit.sniffer`.",
    check: () => state.flags.has("sniffer_run"),
    onStart: () =>
      chatPost({
        channel: "#kernel",
        from: "switchboard",
        body: "You need a token. Sniffer will find the hands that still make them.",
      }),
  },
  {
    id: "t_weaver",
    title: "Breach Weaver.Den",
    hint: "Run `breach weaver.den`, then `unlock THREAD THE DRIFT`, then `connect weaver.den`.",
    check: () => state.unlocked.has("weaver.den") && state.loc === "weaver.den",
    onStart: () =>
      chatPost({
        channel: "#kernel",
        from: "weaver",
        body: "Bring proof of thread. Read `weaver.log` if you forgot the phrase.",
      }),
  },
  {
    id: "t_token",
    title: "Forge A Token",
    hint: "Run `download weaver.mark`, `download splice.s`, then `call kit.splice`.",
    check: () => state.inventory.has("token.key"),
    onStart: () =>
      chatPost({
        channel: "#kernel",
        from: "weaver",
        body: "Splice requires three pieces: badge.sig + mask.dat + weaver.mark.",
      }),
  },
  {
    id: "t_cache",
    title: "Open Lattice.Cache",
    hint: "Run `breach lattice.cache`, then `unlock SIGIL: LATTICE`, then `connect lattice.cache`.",
    check: () => state.unlocked.has("lattice.cache") && state.loc === "lattice.cache",
    onStart: () =>
      chatPost({
        channel: "#kernel",
        from: "trust",
        body: "lattice.cache waiting :: token + mark verified",
        kind: "trust",
      }),
  },
  {
    id: "t_audit",
    title: "Steal The Shard",
    hint: "Run `download ghost.s`, `call kit.ghost`, then `breach corp.audit` and `download relay.shard`.",
    check: () => state.inventory.has("relay.shard"),
    onStart: () =>
      chatPost({
        channel: "#kernel",
        from: "switchboard",
        body: "One last piece: a relay shard. Ghost your trail and hit corp.audit fast.",
      }),
  },
  {
    id: "t_relic",
    title: "Reach The Core",
    hint: "From lattice.cache: `cat warden.dat`, compute checksum, `decode b64 warden.b64`, then `breach core.relic`.",
    check: () => state.loc === "core.relic",
    onStart: () =>
      chatPost({
        channel: "#kernel",
        from: "archivist",
        body: "The Warden will press you. Compute your checksum before you breach the core.",
      }),
  },
  {
    id: "t_choice",
    title: "Make The Choice",
    hint: "At core.relic: `cat core.log`, then choose `exfiltrate` or `restore`.",
    check: () => state.flags.has("touched_relic"),
    onStart: () =>
      chatPost({
        channel: "#kernel",
        from: "switchboard",
        body: "Last step: decide what you are. Exfiltrate it, or restore it.",
      }),
  },
  {
    id: "t_social",
    title: "Talk To Someone",
    hint: "Try `tell juniper hi` (local NPC DMs).",
    check: () => state.flags.has("told_anyone"),
    onStart: () =>
      chatPost({
        channel: "#kernel",
        from: "switchboard",
        body: "You’re solo out here. NPCs are your network. Try `tell juniper hi`.",
      }),
  },
];

function tutorialCurrent() {
  if (!state.tutorial.enabled) return null;
  const idx = Math.max(
    0,
    Math.min(TUTORIAL_STEPS.length - 1, state.tutorial.stepIndex)
  );
  return TUTORIAL_STEPS[idx] || null;
}

function tutorialAdvance() {
  if (!state.tutorial.enabled) return;

  while (state.tutorial.stepIndex < TUTORIAL_STEPS.length) {
    const step = TUTORIAL_STEPS[state.tutorial.stepIndex];
    if (!step) break;
    if (state.tutorial.completed.has(step.id)) {
      state.tutorial.stepIndex += 1;
      continue;
    }
    if (step.check()) {
      state.tutorial.completed.add(step.id);
      state.tutorial.stepIndex += 1;
      continue;
    }
    break;
  }

  const current = tutorialCurrent();
  if (!current) return;
  const startKey = "tutorial_start_" + current.id;
  if (!state.flags.has(startKey)) {
    state.flags.add(startKey);
    if (current.onStart) current.onStart();
  }
  updateHud();
}

function tutorialPrint() {
  tutorialStatus();
}

function tutorialStatus() {
  writeLine("TRAINING ROUTE", "header");
  TUTORIAL_STEPS.forEach((step, i) => {
    const done = state.tutorial.completed.has(step.id) ? "[X]" : "[ ]";
    const here = i === state.tutorial.stepIndex ? " <" : "";
    writeLine(`${done} ${step.title}${here}`, "dim");
    if (i === state.tutorial.stepIndex && state.tutorial.enabled) {
      writeLine("  " + step.hint, "dim");
    }
  });
}

function tutorialNextHint() {
  tutorialAdvance();
}

function tutorialSetEnabled(enabled) {
  state.tutorial.enabled = Boolean(enabled);
  if (state.tutorial.enabled) tutorialAdvance();
  updateHud();
}

function listInventory() {
  if (!state.inventory.size && !Object.keys(state.kit).length) {
    writeLine("Inventory empty.", "dim");
    return;
  }
  if (state.inventory.size) {
    writeLine("Items: " + Array.from(state.inventory).sort().join(", "), "dim");
  }
  if (state.upgrades && state.upgrades.size) {
    writeLine("Installed: " + Array.from(state.upgrades).sort().join(", "), "dim");
  }
  if (Object.keys(state.kit).length) {
    writeLine("Kit: " + Object.keys(state.kit).sort().join(", "), "dim");
  }
}

function decodeCipher(type, payload) {
  const data = payload || state.lastCipher;
  if (!data) {
    writeLine("No cached cipher. Read a cipher file first.", "warn");
    return;
  }
  let output = "";
  if (type === "rot13") {
    output = data.replace(/[a-zA-Z]/g, (c) => {
      const base = c <= "Z" ? 65 : 97;
      return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
    });
  } else if (type === "b64") {
    try {
      output = atob(data);
    } catch {
      writeLine("Base64 decode failed.", "error");
      return;
    }
  } else {
    writeLine("Unknown cipher type. Use rot13 or b64.", "warn");
    return;
  }
  writeLine("Decoded:", "header");
  writeBlock(output, "ok");
  const upper = output.toUpperCase();
  if (upper.includes("EMBER")) state.flags.add("ember_phrase");
  if (upper.includes("LATTICE")) state.flags.add("lattice_sigil");
  if (upper.includes("SLIPPER")) state.flags.add("slipper_signal");
  storyChatTick();
}

const trustScripts = {
  "scripts.trust.scan": {
    owner: "scripts.trust",
    name: "scan",
    sec: "FULLSEC",
    run: (ctx) => {
      ctx.print("Scanning...");
      listLocs();
      setMark("mark.scan");
    },
  },
  "scripts.trust.get_level": {
    owner: "scripts.trust",
    name: "get_level",
    sec: "FULLSEC",
    run: (ctx, args) => {
      const target = args._[0];
      if (!target) {
        ctx.print("Usage: call scripts.trust.get_level <script>");
        return;
      }
      const script = resolveScript(target);
      if (!script) {
        ctx.print("Script not found.");
        return;
      }
      ctx.print(`${script.owner}.${script.name} :: ${script.sec}`);
    },
  },
  "scripts.trust.probe": {
    owner: "scripts.trust",
    name: "probe",
    sec: "FULLSEC",
    run: (ctx, args) => {
      const target = args._[0];
      if (!target) {
        ctx.print("Usage: call scripts.trust.probe <loc>");
        return;
      }
      const loc = getLoc(target);
      if (!loc) {
        ctx.print("Loc not found.");
        return;
      }
      if (!state.discovered.has(target)) {
        ctx.print("Loc not discovered.");
        return;
      }
      if (!loc.locks.length) {
        ctx.print("No locks detected.");
        return;
      }
      ctx.print(`LOCK STACK (${loc.locks.length})`);
      loc.locks.forEach((lock, index) => ctx.print(`${index + 1}. ${lock.prompt}`));
    },
  },
  "scripts.trust.accts.balance": {
    owner: "scripts.trust",
    name: "accts.balance",
    sec: "HIGHSEC",
    run: (ctx) => {
      ctx.print(`GC balance: ${state.gc}`);
    },
  },
  "scripts.trust.sys.loc": {
    owner: "scripts.trust",
    name: "sys.loc",
    sec: "LOWSEC",
    run: (ctx) => {
      ctx.print(`Current loc: ${state.loc}`);
    },
  },
  "scripts.trust.marks": {
    owner: "scripts.trust",
    name: "marks",
    sec: "FULLSEC",
    run: () => listMarks(),
  },
  "scripts.trust.uplink.sync": {
    owner: "scripts.trust",
    name: "uplink.sync",
    sec: "MIDSEC",
    run: (ctx) => {
      if (!state.unlocked.has("relay.uplink")) {
        ctx.print("uplink offline.");
        return;
      }

      const bucket = ensureUploadsBucket("relay.uplink");
      const up = bucket.files["patch.s"];
      if (!up) {
        ctx.print("No patch uploaded.");
        ctx.print("Flow: connect relay.uplink; edit patch; upload <you>.patch patch.s; call scripts.trust.uplink.sync");
        return;
      }
      if (up.kind !== "script") {
        ctx.print("patch.s must be a script upload.");
        return;
      }

      const expected = expectedForChecksumPayload(UPLINK_PAYLOAD);
      const out = [];
      const sandbox = {
        print: (msg) => out.push(String(msg)),
        scratch: () => {},
        handle: () => String(state.handle || "ghost"),
        util: {
          checksum: (text) => checksumUtf8Mod4096(text),
          hex3: (n) => hex3(n),
        },
        files: () => [],
        read: () => null,
        discover: () => {},
        flag: () => {},
        flagged: () => false,
        addItem: () => {},
        hasItem: () => false,
        call: () => {},
        loc: () => "relay.uplink",
      };

      let firstLine = "";
      try {
        const fn = new Function("ctx", "args", `"use strict";\n${String(up.content || "")}`);
        fn(sandbox, { _: [] });
        firstLine = String(out.join("\n").split("\n")[0] || "").trim().toUpperCase();
      } catch (err) {
        ctx.print("Patch crashed: " + err.message);
        return;
      }

      if (firstLine !== expected) {
        ctx.print("Patch rejected.");
        ctx.print("Hint: print checksum(payload + '|HANDLE=' + ctx.handle()) as 3-hex.");
        ctx.print("See uplink.req for payload.");
        return;
      }

      if (!state.flags.has("uplink_patched")) {
        state.flags.add("uplink_patched");
        discover(["mirror.gate"]);
        state.unlocked.add("mirror.gate");
        ctx.print("Patch accepted. Mirror route exposed.");
        chatPost({
          channel: dmChannel("switchboard"),
          from: "switchboard",
          body: "Uplink took your patch. New door: `mirror.gate`. Optional, but it pays in confidence.",
        });
        markDirty();
      } else {
        ctx.print("Already patched.");
      }
    },
  },
  "scripts.trust.chats.send": {
    owner: "scripts.trust",
    name: "chats.send",
    sec: "FULLSEC",
    run: (_ctx, args) => {
      const msg = (args.msg || args._.join(" ") || "").trim();
      if (!msg) {
        chatSystem("Usage: call scripts.trust.chats.send msg=\"hello\"");
        return;
      }
      chatPost({ body: msg });
    },
  },
  "scripts.trust.chats.join": {
    owner: "scripts.trust",
    name: "chats.join",
    sec: "MIDSEC",
    run: (_ctx, args) => {
      const channel = (args.chan || args._[0] || "").trim();
      if (!channel) {
        chatSystem("Usage: call scripts.trust.chats.join chan=\"#kernel\"");
        return;
      }
      chatJoin(channel);
    },
  },
  "scripts.trust.chats.switch": {
    owner: "scripts.trust",
    name: "chats.switch",
    sec: "FULLSEC",
    run: (_ctx, args) => {
      const channel = (args.chan || args._[0] || "").trim();
      if (!channel) {
        chatSystem("Usage: call scripts.trust.chats.switch chan=\"#kernel\"");
        return;
      }
      chatSwitch(channel);
    },
  },
  "scripts.trust.chats.tell": {
    owner: "scripts.trust",
    name: "chats.tell",
    sec: "FULLSEC",
    run: (_ctx, args) => {
      const npc = (args.to || args._[0] || "").trim();
      const msg = (args.msg || args._.slice(1).join(" ") || "").trim();
      if (!npc) {
        chatSystem("Usage: call scripts.trust.chats.tell to=\"juniper\" msg=\"hi\"");
        return;
      }
      tellNpc(npc, msg);
    },
  },
};

function resolveScript(name) {
  if (!name) return null;
  if (trustScripts[name]) return trustScripts[name];

  if (name.startsWith("kit.")) {
    const kitName = name.slice(4);
    return state.kit[kitName] || null;
  }

  if (name.includes(".")) {
    const prefix = `${state.handle}.`;
    if (state.handle && name.startsWith(prefix)) {
      const local = name.slice(prefix.length);
      const s = state.userScripts[local];
      if (s) return { ...s, owner: state.handle };
    }
    return null;
  }

  if (state.userScripts[name]) return { ...state.userScripts[name], owner: state.handle };
  if (state.kit[name]) return state.kit[name];
  return null;
}

function buildContext(currentScript, outputKind) {
  const kind = outputKind || "dim";
  return {
    print: (msg) => writeBlock(String(msg), kind),
    scratch: (msg) => scratchAppend(String(msg)),
    handle: () => String(state.handle || "ghost"),
    util: {
      checksum: (text) => checksumUtf8Mod4096(text),
      hex3: (n) => hex3(n),
    },
    files: () => {
      const loc = getLoc(state.loc);
      return Object.keys((loc && loc.files) || {});
    },
    read: (name) => {
      const key = String(name || "").trim();
      if (!key) return null;

      // Allow scripts to read from the local drive as well.
      const drive = getDriveEntry(key);
      if (drive) return String(drive.content || "");

      // Default: current loc, with a fallback to home.hub so common primers work anywhere.
      let text = getLocFileText(state.loc, key);
      if (text === null) text = getLocFileText("home.hub", key);
      return text === null ? null : String(text);
    },
    discover: (locs) => {
      const added = discover(locs || []);
      if (added.length) writeLine("New signals: " + added.join(", "), "ok");
    },
    flag: (flag) => state.flags.add(flag),
    flagged: (flag) => state.flags.has(flag),
    addItem: (item) => state.inventory.add(item),
    hasItem: (item) => state.inventory.has(item),
    call: (scriptName, scriptArgs) => runScript(scriptName, scriptArgs, currentScript),
    loc: () => state.loc,
  };
}

function runUserScript(script, args) {
  const ctx = buildContext(script, "dim");
  try {
    const fn = new Function("ctx", "args", `"use strict";\n${script.code}`);
    fn(ctx, args);
    state.flags.add("ran_user_script");
  } catch (err) {
    writeLine(`Script error: ${err.message}`, "error");
  }
}

function runScript(name, args, caller) {
  const script = typeof name === "string" ? resolveScript(name) : name;
  if (!script) {
    writeLine("Script not found.", "error");
    return;
  }

  const callerSec = caller ? caller.sec : "FULLSEC";
  // In this sim: higher security can call lower security, but not vice-versa.
  if (secRank(script.sec) > secRank(callerSec)) {
    writeLine(
      `SECURITY VIOLATION: ${callerSec} cannot call ${script.sec}`,
      "error"
    );
    return;
  }

  const header = `running ${script.owner}.${script.name} [${script.sec}]`;
  writeLine(header, script.owner === "scripts.trust" ? "trust" : "dim");

  if (script.owner === "scripts.trust") {
    script.run(buildContext(script, "trust"), args || { _: [] });
  } else {
    runUserScript(script, args || { _: [] });
  }

  // Some scripts affect loc requirements via flags/items; reflect that in chat.
  if (script.owner !== "scripts.trust" && script.name === "tracer") {
    chatPost({ channel: "#kernel", from: "switchboard", body: "Signals updated. Try `breach archives.arc` next." });
  }
  if (script.owner === "scripts.trust" && script.name === "scan") {
    tutorialNextHint();
  }
}

function updateHud() {
  gcSpan.textContent = state.gc;
  traceSpan.textContent = `${state.trace}/${state.traceMax}`;
  const dl = state.downloads && (state.downloads.active || state.downloads.queue.length);
  let dlStatus = "";
  if (state.downloads.active) {
    const now = Date.now();
    const elapsed = now - state.downloads.active.startedAt;
    const pct = Math.max(
      0,
      Math.min(100, Math.floor((elapsed / state.downloads.active.durationMs) * 100))
    );
    dlStatus = ` | dl ${state.downloads.active.file} ${pct}% (+${state.downloads.queue.length})`;
  } else if (state.downloads.queue.length) {
    dlStatus = ` | dl queue ${state.downloads.queue.length}`;
  }

  statusLine.textContent = state.handle
    ? `${state.handle}@${state.loc}${dlStatus}`
    : "enter handle or type load";
  prompt.textContent = state.editor ? "edit>" : ">>";

  if (hint) {
    const current = tutorialCurrent();
    if (current && state.tutorial.enabled) {
      hint.textContent = `Objective: ${current.title} — ${current.hint}`;
    } else {
      hint.textContent =
        "Type `help` for commands. Use `scripts` to list available scripts.";
    }
  }
}

function storyChatTick() {
  if (!state.handle) return;
  if (state.loc === "home.hub" && !state.flags.has("chat_intro")) {
    state.flags.add("chat_intro");
    chatPost({
      channel: "#kernel",
      from: "switchboard",
      body: "Run scripts.trust.scan. The Drift is talking tonight.",
    });
    return;
  }
  if (state.unlocked.has("training.node") && !state.flags.has("chat_prologue_done")) {
    state.flags.add("chat_prologue_done");
    chatPost({
      channel: "#kernel",
      from: "switchboard",
      body: "Training node cleared. Route to the exchange and pull tools.",
    });
    return;
  }
  if (state.unlocked.has("pier.gate") && !state.flags.has("chat_pier_gate")) {
    state.flags.add("chat_pier_gate");
    discover(["ember.pier"]);
    chatPost({
      channel: "#kernel",
      from: "switchboard",
      body: "Signal edge widened. New loc: `ember.pier` (breach it, then connect).",
    });
    return;
  }
  if (state.flags.has("ember_phrase") && !state.flags.has("chat_ember")) {
    state.flags.add("chat_ember");
    chatPost({
      channel: "#kernel",
      from: "switchboard",
      body: "Good. Ember confirmed. Breach sable.gate and don't spike trace.",
    });
    return;
  }
  if (state.unlocked.has("sable.gate") && !state.flags.has("chat_gate_open")) {
    state.flags.add("chat_gate_open");
    chatPost({
      channel: "#kernel",
      from: "switchboard",
      body: "Gate open. Next target is `archives.arc` (needs `mask.dat` + tracer signal).",
    });
    return;
  }
  if (state.unlocked.has("archives.arc") && !state.flags.has("chat_archive")) {
    state.flags.add("chat_archive");
    chatPost({
      channel: "#kernel",
      from: "archivist",
      body: "If you can read the sigil, the lattice can read you back.",
    });
  }
  if (state.unlocked.has("lattice.cache") && !state.flags.has("chat_act3")) {
    state.flags.add("chat_act3");
    if (!state.flags.has("corrupt_act3")) {
      state.flags.add("corrupt_act3");
      setCorruptionLevel(Math.max(corruptionLevel(), 2));
    }
    chatPost({
      channel: "#kernel",
      from: "archivist",
      body: "The Warden wakes when you approach the core. Compute clean. Move fast.",
    });
    return;
  }
  if (state.flags.has("sniffer_run") && !state.flags.has("chat_sniffer")) {
    state.flags.add("chat_sniffer");
    if (!state.flags.has("corrupt_act2")) {
      state.flags.add("corrupt_act2");
      setCorruptionLevel(Math.max(corruptionLevel(), 1));
    }
    chatPost({
      channel: "#kernel",
      from: "switchboard",
      body: "Sniffer found a public beacon and a Weaver den. Both can help.",
    });
    return;
  }
  if (state.flags.has("trace_open") && state.discovered.has("relay.uplink") && !state.flags.has("chat_uplink")) {
    state.flags.add("chat_uplink");
    chatPost({
      channel: "#kernel",
      from: "switchboard",
      body: "Optional route: `relay.uplink` (breach it; no locks). It supports `upload` and a verification gate.",
    });
    return;
  }
  if (state.flags.has("slipper_signal") && !state.flags.has("chat_slipper")) {
    state.flags.add("chat_slipper");
    const added = discover(["slipper.hole"]);
    if (added.length) {
      chatPost({
        channel: "#kernel",
        from: "switchboard",
        body: "Beacon decoded. A thin spot opened: `slipper.hole`.",
      });
    }
    return;
  }
  if (state.unlocked.has("monument.beacon") && !state.flags.has("chat_beacon")) {
    state.flags.add("chat_beacon");
    writeLine("monument:: IN RISK WE TRUST", "trust");
    return;
  }
  if (state.flags.has("q_juniper_mask") && !state.flags.has("chat_juniper_contract")) {
    state.flags.add("chat_juniper_contract");
    chatPost({
      channel: "#kernel",
      from: "juniper",
      body: "DM me for work: `tell juniper work`.",
    });
  }
}

function listScripts() {
  writeLine("TRUST SCRIPTS", "header");
  Object.keys(trustScripts)
    .sort()
    .forEach((name) => writeLine(`${name} [${trustScripts[name].sec}]`, "trust"));

  writeLine("USER SCRIPTS", "header");
  const userNames = Object.keys(state.userScripts);
  if (!userNames.length) writeLine("(none)", "dim");
  userNames
    .sort()
    .forEach((name) => writeLine(`${state.handle}.${name} [${state.userScripts[name].sec}]`, "dim"));

  writeLine("KIT SCRIPTS", "header");
  const kitNames = Object.keys(state.kit);
  if (!kitNames.length) writeLine("(none)", "dim");
  kitNames
    .sort()
    .forEach((name) => writeLine(`kit.${name} [${state.kit[name].sec}]`, "dim"));
}

function canAttemptLoc(locName) {
  const loc = getLoc(locName);
  const req = (loc && loc.requirements) || {};
  const missingItems = (req.items || []).filter((item) => !state.inventory.has(item));
  const missingFlags = (req.flags || []).filter((flag) => !state.flags.has(flag));
  return { ok: !missingItems.length && !missingFlags.length, missingItems, missingFlags };
}

function startBreach(locName) {
  if (state.lockoutUntil && Date.now() < state.lockoutUntil) {
    writeLine("CONNECTION THROTTLED. WAIT.", "warn");
    return;
  }
  // Clear any prior breach pressure loop.
  if (state.breach && state.breach.pressure) {
    try {
      window.clearInterval(state.breach.pressure);
    } catch {}
  }
  const loc = getLoc(locName);
  if (!loc) {
    writeLine("Loc not found.", "error");
    return;
  }
  if (!state.discovered.has(locName)) {
    writeLine("Loc not discovered.", "warn");
    return;
  }
  if (state.unlocked.has(locName)) {
    writeLine("Loc already unlocked.", "dim");
    return;
  }
  const req = canAttemptLoc(locName);
  if (!req.ok) {
    const needs = [];
    if (req.missingItems.length) needs.push("items: " + req.missingItems.join(", "));
    if (req.missingFlags.length) needs.push("signals: " + req.missingFlags.join(", "));
    writeLine("Pre-check failed. Missing " + needs.join(" | "), "warn");
    return;
  }
  state.breach = { loc: locName, index: 0, pressure: null };
  writeLine(`BREACHING ${locName}`, "header");
  writeLine(`sys::breach.start ${locName}`, "trust");
  if (!loc.locks.length) {
    writeLine("No locks detected. Access open.", "ok");
    state.unlocked.add(locName);
    setMark("mark.breach");
    state.breach = null;
    return;
  }

  // Boss-like pressure: the warden pulses trace while you're inside the core lock stack.
  if (locName === "core.relic") {
    setCorruptionLevel(Math.max(corruptionLevel(), 2));
    state.breach.pressure = window.setInterval(() => {
      if (!state.breach || state.breach.loc !== "core.relic") return;
      writeLine("WARDEN PULSE :: trace rising", "warn");
      failBreach();
    }, 7000);
  }

  writeLine(loc.locks[0].prompt, "warn");
}

function failBreach() {
  state.trace += 1;
  if (state.trace >= state.traceMax) {
    writeLine("TRACE LIMIT HIT. CONNECTION DROPPED.", "error");

    // Game-ified penalty: you get kicked, downloads are dropped, and you eat a small fine.
    try {
      if (state.downloads && state.downloads.active) {
        if (state.downloads.active.tick) window.clearInterval(state.downloads.active.tick);
        if (state.downloads.active.timer) window.clearTimeout(state.downloads.active.timer);
      }
    } catch {}
    state.downloads = { active: null, queue: [] };

    const fine = Math.min(50, Math.max(0, Number(state.gc) || 0));
    if (fine > 0) {
      state.gc -= fine;
      writeLine(`sys::audit.fine -${fine}GC`, "warn");
    }

    if (state.siphon && state.siphon.on) {
      state.siphon.on = false;
      state.siphon.heat = Math.max(0, (Number(state.siphon.heat) || 0) - 25);
      ensureSiphonLoop();
      chatPost({
        channel: dmChannel("juniper"),
        from: "juniper",
        body: "You got flagged. Siphon disabled. Next time you pay more than GC.",
      });
    }

    state.lockoutUntil = Date.now() + 9000;
    state.loc = "home.hub";
    state.trace = 0;
    state.breach = null;
    showLoc();
    updateHud();
    markDirty();
    return;
  }
  writeLine(`TRACE +1 (${state.trace}/${state.traceMax})`, "warn");
}

function unlockAttempt(answer) {
  if (!state.breach) {
    writeLine("No active breach.", "warn");
    return;
  }
  const pressure = state.breach.pressure;
  const loc = getLoc(state.breach.loc);
  const lock = loc.locks[state.breach.index];
  if (!lock) {
    writeLine("Lock stack exhausted.", "dim");
    if (pressure) window.clearInterval(pressure);
    state.breach = null;
    return;
  }
  const normalized = String(answer || "").trim();
  if (!normalized) {
    writeLine("Supply an answer.", "warn");
    return;
  }
  const expected =
    typeof lock.answer === "function" ? String(lock.answer()) : String(lock.answer || "");
  if (normalized.toUpperCase() === expected.toUpperCase()) {
    writeLine("LOCK CLEARED", "ok");
    writeLine("sys::lock.cleared", "trust");
    state.breach.index += 1;
    if (state.breach.index >= loc.locks.length) {
      writeLine("STACK CLEARED. ACCESS OPEN.", "ok");
      state.unlocked.add(state.breach.loc);
      setMark("mark.breach");
      if (pressure) window.clearInterval(pressure);
      writeLine(`sys::breach.success ${state.breach.loc}`, "trust");
      state.breach = null;
      return;
    }
    writeLine(loc.locks[state.breach.index].prompt, "warn");
    return;
  }
  writeLine("LOCK FAILED.", "error");
  writeLine("Hint: " + lock.hint, "dim");
  failBreach();
}

function connectLoc(locName) {
  if (!state.discovered.has(locName)) {
    writeLine("Unknown loc. Run scripts.trust.scan or discover it.", "warn");
    return;
  }
  if (!state.unlocked.has(locName)) {
    writeLine("Access denied. Use breach to solve the lock stack.", "warn");
    return;
  }
  state.loc = locName;
  showLoc();
  if (!state.flags.has("seen_" + locName)) {
    state.flags.add("seen_" + locName);
    if (locName === "monument.beacon") {
      chatPost({
        channel: "#kernel",
        from: "switchboard",
        body: "That motto is everywhere. Breach it if you want the coolant.",
      });
    }
    if (locName === "public.exchange") {
      npcIntroduce("juniper");
    }
    if (locName === "ember.pier") {
      chatPost({
        channel: "#kernel",
        from: "switchboard",
        body: "The pier watches you back. Decode pier.b64 if you want the vibe.",
      });
    }
    if (locName === "archives.arc") {
      npcIntroduce("archivist");
    }
    if (locName === "relay.uplink") {
      chatPost({
        channel: "#kernel",
        from: "switchboard",
        body: "Uplink is live. Read `uplink.req`. Then try: `edit patch`, `upload <you>.patch patch.s`, `call scripts.trust.uplink.sync`.",
      });
    }
    if (locName === "weaver.den") {
      npcIntroduce("weaver");
    }
    if (locName === "echo.after") {
      chatPost({
        channel: "#kernel",
        from: "echo",
        body: "Install upgrades. Cool trace. Then decide what kind of operator you are.",
      });
    }
  }
}

function getLocFileText(locName, fileName) {
  const loc = getLoc(locName);
  const entry = loc && loc.files && loc.files[String(fileName || "").trim()];
  if (!entry) return null;
  if (typeof entry.content === "string") return entry.content;
  return String(entry.content || "");
}

function readAnyText(ref) {
  const drive = getDriveEntry(ref);
  if (drive) return String(drive.content || "");
  const loc = getLoc(state.loc);
  const entry = loc && loc.files && loc.files[String(ref || "").trim()];
  if (!entry) return null;
  if (typeof entry.content === "string") return entry.content;
  return String(entry.content || "");
}

function setEditor(name, options) {
  const opts = options || {};
  const prefill = typeof opts.prefill === "string" ? opts.prefill : null;
  state.editor = { name, lines: prefill ? String(prefill).split("\n") : [] };
  writeLine("EDITOR MODE :: type :wq to save, :q to abort", "warn");
  writeLine(`Editing ${state.handle}.${name}`, "dim");
  writeLine("Tip: add `// @sec FULLSEC|HIGHSEC|MIDSEC|LOWSEC|NULLSEC`", "dim");
  if (prefill) writeLine("Loaded template. Edit, then `:wq`.", "dim");
}

function finishEditor(save) {
  const editor = state.editor;
  state.editor = null;
  if (!save) {
    writeLine("Editor aborted.", "warn");
    return;
  }
  const code = editor.lines.join("\n");
  const match = code.match(/@sec\s+(FULLSEC|HIGHSEC|MIDSEC|LOWSEC|NULLSEC)/i);
  const sec = match ? match[1].toUpperCase() : "FULLSEC";
  state.userScripts[editor.name] = { owner: state.handle, name: editor.name, sec, code };
  writeLine(`Saved ${state.handle}.${editor.name} [${sec}]`, "ok");
  setMark("mark.edit");
  markDirty();
}

function getSaveData() {
  return {
    handle: state.handle,
    loc: state.loc,
    gc: state.gc,
    discovered: Array.from(state.discovered),
    unlocked: Array.from(state.unlocked),
    inventory: Array.from(state.inventory),
    drive: state.drive,
    kit: state.kit,
    userScripts: state.userScripts,
    uploads: state.uploads,
    flags: Array.from(state.flags),
    marks: Array.from(state.marks),
    upgrades: Array.from(state.upgrades),
    driveMax: state.driveMax,
    siphon: state.siphon,
    lockoutUntil: state.lockoutUntil,
    wait: state.wait,
    tutorial: {
      enabled: state.tutorial.enabled,
      stepIndex: state.tutorial.stepIndex,
      completed: Array.from(state.tutorial.completed),
    },
    npcs: {
      known: Array.from(state.npcs.known),
    },
    scratch: scratchPad ? scratchPad.value : "",
    chat: {
      channel: state.chat.channel,
      channels: Array.from(state.chat.channels),
      log: state.chat.log,
    },
    trace: state.trace,
    traceMax: state.traceMax,
    lastCipher: state.lastCipher,
  };
}

function saveState(options) {
  const opts = options || {};
  const data = getSaveData();
  localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  saveDirty = false;
  lastAutosaveAt = Date.now();
  if (!opts.silent) writeLine("State saved.", "ok");
}

function loadState(options) {
  const opts = options || {};
  let raw = localStorage.getItem(SAVE_KEY);
  if (!raw) raw = localStorage.getItem(LEGACY_SAVE_KEY);
  if (!raw) {
    if (!opts.silent) writeLine("No save found.", "warn");
    return false;
  }
  const parsed = JSON.parse(raw);
  const data = parsed && parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
  state.handle = data.handle;
  state.loc = data.loc || "home.hub";
  state.gc = data.gc ?? 0;
  state.discovered = new Set(data.discovered || []);
  state.unlocked = new Set(data.unlocked || []);
  state.inventory = new Set(data.inventory || []);
  state.drive = data.drive && typeof data.drive === "object" ? data.drive : {};
  state.kit = data.kit || {};
  state.userScripts = data.userScripts || {};
  state.uploads = data.uploads && typeof data.uploads === "object" ? data.uploads : {};
  state.flags = new Set(data.flags || []);
  state.marks = new Set(data.marks || []);
  state.upgrades = new Set(data.upgrades || []);
  state.driveMax = Number(data.driveMax) > 0 ? Number(data.driveMax) : state.driveMax || 12_000;
  state.siphon =
    data.siphon && typeof data.siphon === "object"
      ? {
          on: !!data.siphon.on,
          level: ["low", "med", "high"].includes(String(data.siphon.level)) ? String(data.siphon.level) : "low",
          heat: Number(data.siphon.heat) || 0,
          mode: String(data.siphon.mode) === "script" ? "script" : "fixed",
          source:
            data.siphon.source && typeof data.siphon.source === "object"
              ? {
                  loc: String(data.siphon.source.loc || ""),
                  file: String(data.siphon.source.file || ""),
                }
              : null,
        }
      : state.siphon || { on: false, level: "low", heat: 0, mode: "fixed", source: null };
  state.lockoutUntil = Number(data.lockoutUntil) || 0;
  state.wait =
    data.wait && typeof data.wait === "object"
      ? { lastAt: Number(data.wait.lastAt) || 0, streak: Number(data.wait.streak) || 0 }
      : state.wait || { lastAt: 0, streak: 0 };
  if (data.tutorial) {
    state.tutorial.enabled = data.tutorial.enabled !== false;
    state.tutorial.completed = new Set(data.tutorial.completed || []);
    // Recompute current step from completion set so tutorial stays stable
    // even if step ordering changes between versions.
    state.tutorial.stepIndex = 0;
  }
  if (data.npcs) {
    state.npcs.known = new Set(data.npcs.known || ["switchboard"]);
  }
  if (scratchPad) {
    if (typeof data.scratch === "string") {
      scratchPad.value = data.scratch;
      saveScratchToStorage();
    } else {
      loadScratchFromStorage();
    }
  }
  state.trace = data.trace || 0;
  state.traceMax = data.traceMax || 4;
  state.lastCipher = data.lastCipher || null;
  if (data.chat) {
    state.chat.channel = data.chat.channel || "#kernel";
    state.chat.channels = new Set(data.chat.channels || ["#kernel"]);
    state.chat.log = (data.chat.log || state.chat.log)
      .filter((m) => !(m && (m.kind === "trust" || m.from === "trust")))
      .map((m) => ({
        ...m,
        color: m.kind === "system" ? null : m.color || userColorClass(m.from),
        uid: m.uid || (m.kind === "system" ? "----" : userId4(m.from)),
      }));
    renderChat();
  }
  // scratchpad is user-authored; don't clear on load
  if (!opts.silent) writeLine("State loaded.", "ok");
  applyCorruptionClasses();
  showLoc();
  storyChatTick();
  tutorialAdvance();
  ensureSiphonLoop();
  // If we loaded from legacy key, persist in the new namespace.
  if (localStorage.getItem(SAVE_KEY) === null) localStorage.setItem(SAVE_KEY, JSON.stringify(JSON.parse(raw)));
  saveDirty = false;
  return true;
}

function listJobs() {
  writeLine("JOBS", "header");
  const jobs = [];

  if (npcKnown("juniper") && !state.flags.has("q_juniper_mask_done")) {
    jobs.push({
      id: "mask",
      npc: "juniper",
      title: "Mask Run",
      status: state.inventory.has("mask.dat") ? "[READY]" : "[ACTIVE]",
      detail:
        "Mint `mask.dat` (download spoof.s; call kit.spoof) then `turnin mask` at public.exchange (+50GC).",
    });
  }

  if (npcKnown("weaver") && state.inventory.has("token.key") && !state.flags.has("q_weaver_token_done")) {
    jobs.push({
      id: "token",
      npc: "weaver",
      title: "Token Proof",
      status: "[READY]",
      detail: "Bring `token.key` to weaver.den and `turnin token` (+upg.trace_spool).",
    });
  }

  if (state.discovered.has("relay.uplink") && !state.flags.has("uplink_patched")) {
    const hasPatch = !!(
      state.uploads &&
      state.uploads["relay.uplink"] &&
      state.uploads["relay.uplink"].files &&
      state.uploads["relay.uplink"].files["patch.s"]
    );
    jobs.push({
      id: "uplink",
      npc: "switchboard",
      title: "Uplink Patch",
      status: hasPatch ? "[READY]" : "[ACTIVE]",
      detail:
        "Breach + connect `relay.uplink`, read `uplink.req`, then `edit patch`, `upload <you>.patch patch.s`, `call scripts.trust.uplink.sync` (+mirror route).",
    });
  }

  if (!jobs.length) {
    writeLine("(none)", "dim");
    writeLine("Tip: NPCs offer contracts in DMs. Try `tell juniper work`.", "dim");
    return;
  }

  jobs.forEach((j) => {
    writeLine(`${j.status} ${j.npc} :: ${j.title}`, "dim");
    writeLine(`  id: ${j.id}`, "dim");
    writeLine(`  ${j.detail}`, "dim");
  });
}

function turnIn(what) {
  const id = String(what || "").toLowerCase().trim();
  if (!id) {
    writeLine("Usage: turnin <mask|token>", "warn");
    return;
  }

  if (id === "mask") {
    if (state.loc !== "public.exchange") {
      writeLine("Turn-in requires `connect public.exchange`.", "warn");
      return;
    }
    if (!state.inventory.has("mask.dat")) {
      writeLine("Missing item: mask.dat", "warn");
      return;
    }
    if (state.flags.has("q_juniper_mask_done")) {
      writeLine("Already turned in.", "dim");
      return;
    }
    state.flags.add("q_juniper_mask_done");
    state.gc += 50;
    writeLine("Turn-in accepted. +50GC", "ok");
    chatPost({ channel: dmChannel("juniper"), from: "juniper", body: "Clean enough. +50GC." });
    updateHud();
    return;
  }

  if (id === "token") {
    if (state.loc !== "weaver.den") {
      writeLine("Turn-in requires `connect weaver.den`.", "warn");
      return;
    }
    if (!state.inventory.has("token.key")) {
      writeLine("Missing item: token.key", "warn");
      return;
    }
    if (state.flags.has("q_weaver_token_done")) {
      writeLine("Already turned in.", "dim");
      return;
    }
    state.flags.add("q_weaver_token_done");
    state.inventory.add("upg.trace_spool");
    writeLine("Turn-in accepted. Received: upg.trace_spool", "ok");
    writeLine("Tip: `install upg.trace_spool`", "dim");
    chatPost({
      channel: dmChannel("weaver"),
      from: "weaver",
      body: "Proof accepted. Take a spool. It buys you mistakes.",
    });
    return;
  }

  writeLine("Unknown turn-in. Try: `turnin mask` or `turnin token`.", "warn");
}

function diagnoseProgress() {
  writeLine("DIAGNOSE", "header");
  const discovered = Array.from(state.discovered).sort();
  const locked = discovered.filter((l) => !state.unlocked.has(l));
  if (!locked.length) {
    writeLine("No discovered locs are locked.", "dim");
  } else {
    locked.forEach((locName) => {
      const loc = getLoc(locName);
      const req = canAttemptLoc(locName);
      const need = [];
      if (req.missingItems.length) need.push("items: " + req.missingItems.join(", "));
      if (req.missingFlags.length) need.push("signals: " + req.missingFlags.join(", "));
      writeLine(`${locName} :: LOCKED`, "warn");
      if (need.length) writeLine("  pre-check missing " + need.join(" | "), "dim");
      if (loc && loc.locks && loc.locks.length) writeLine("  first lock: " + loc.locks[0].prompt, "dim");
    });
  }
  writeLine("Tip: `tutorial` shows the recommended path.", "dim");
}

function handleCommand(inputText) {
  const raw = String(inputText || "");
  const trimmed = raw.trim();
  if (!trimmed) return;

  if (state.editor) {
    if (trimmed === ":q") {
      finishEditor(false);
      updateHud();
      return;
    }
    if (trimmed === ":wq") {
      finishEditor(true);
      updateHud();
      return;
    }
    state.editor.lines.push(raw);
    return;
  }

  if (!state.handle) {
    if (trimmed.toLowerCase() === "load") {
      loadState();
      updateHud();
      return;
    }
    state.handle = trimmed || "ghost";
    writeLine(`HANDLE SET: ${state.handle}`, "ok");
    chatPost({ channel: state.chat.channel, from: "sys", body: `*** ${state.handle} connected`, kind: "system" });
    loadScratchFromStorage();
    showLoc();
    storyChatTick();
    tutorialPrint();
    updateHud();
    ensureAutosaveLoop();
    ensureSiphonLoop();
    markDirty();
    autoSaveNow();
    return;
  }

  const parts = splitArgs(trimmed);
  const cmd = (parts[0] || "").toLowerCase();
  const args = parts.slice(1);
  const flags = new Set(args.filter((a) => a.startsWith("--")));

  switch (cmd) {
    case "help":
      if (args[0]) {
        const topic = args[0].toLowerCase();
        const wantsArgs = args[1] === "?";

        if (topic === "scripts") {
          writeLine("help scripts", "header");
          writeLine("List scripts: `scripts`", "dim");
          writeLine("Check sec level: `call scripts.trust.get_level scripts.trust.scan`", "dim");
          writeLine("Run a kit script: `call kit.tracer`", "dim");
          break;
        }

        if (topic === "call" || topic === "run") {
          writeLine("help call", "header");
          writeLine("Usage: `call <script> [args]`", "dim");
          writeLine("Trust: `call scripts.trust.accts.balance`", "dim");
          writeLine("Kit: `call kit.tracer`", "dim");
          writeLine("Named args: `call scripts.trust.chats.send msg=\"hello\"`", "dim");
          if (wantsArgs) {
            writeLine("Args format:", "header");
            writeLine("Positional: `call some.script a b c` -> `args._ = [\"a\",\"b\",\"c\"]`", "dim");
            writeLine("Named: `call some.script key=value` -> `args.key = \"value\"`", "dim");
            writeLine("Quotes: `msg=\"hello world\"` (values are strings)", "dim");
          } else {
            writeLine("Tip: `help call ?` to see args format.", "dim");
          }
          break;
        }

        if (topic === "download") {
          writeLine("help download", "header");
          writeLine("Queue file downloads. Time depends on file size.", "dim");
          writeLine("Single file: `download tracer.s`", "dim");
          writeLine("Wildcard: `download *.s` (only works for `download`)", "dim");
          writeLine("Queue status: `downloads`", "dim");
          writeLine("Text files download to drive: `drive` then `cat drive:loc/file`", "dim");
          if (wantsArgs) {
            writeLine("Wildcard rules:", "header");
            writeLine("`*` matches any run of characters; `?` matches one character.", "dim");
            writeLine("Globs only apply to `download` (not `cat`, not `breach`).", "dim");
          }
          break;
        }

        if (topic === "cat") {
          writeLine("help cat", "header");
          writeLine("Read a file in the current loc: `cat primer.dat`", "dim");
          writeLine("Read a downloaded text file: `cat drive:sable.gate/cipher.txt`", "dim");
          writeLine("View script source: `cat kit.tracer` or `cat <your_handle>.chk`", "dim");
          break;
        }

        if (topic === "edit") {
          writeLine("help edit", "header");
          writeLine("Create or overwrite a script: `edit chk` then `:wq`", "dim");
          writeLine("Load the checksum template: `edit chk --example`", "dim");
          writeLine("Or: `edit chk --from chk.example`", "dim");
          break;
        }

        if (topic === "del" || topic === "delete" || topic === "rm") {
          writeLine("help del", "header");
          writeLine("Delete downloaded drive files or your local scripts.", "dim");
          writeLine("Delete a drive file: `del drive:sable.gate/cipher.txt`", "dim");
          writeLine("Delete your script: `del <your_handle>.chk --confirm`", "dim");
          break;
        }

        if (topic === "drive") {
          writeLine("help drive", "header");
          writeLine("List downloaded text/cipher files: `drive`", "dim");
          writeLine("Read one: `cat drive:sable.gate/cipher.txt`", "dim");
          writeLine("Tip: cipher files set your decode buffer (like `cat` does).", "dim");
          break;
        }

        if (topic === "upload" || topic === "uploads") {
          writeLine("help upload", "header");
          writeLine("Upload a local script or drive file back into a loc.", "dim");
          writeLine("Upload (current loc): `upload drive:sable.gate/cipher.txt note.txt`", "dim");
          writeLine("Upload a script: `upload <your_handle>.patch patch.s`", "dim");
          writeLine("Remote upload: connect `relay.uplink` then `upload <src> some.loc:file`", "dim");
          writeLine("View uploads: `uploads`", "dim");
          break;
        }

        if (topic === "store" || topic === "buy") {
          writeLine("help store", "header");
          writeLine("Juniper sells upgrades at the exchange.", "dim");
          writeLine("List: `store` (only at public.exchange)", "dim");
          writeLine("Buy: `buy upg.modem`", "dim");
          writeLine("Install: `install upg.modem`", "dim");
          break;
        }

        if (topic === "siphon") {
          writeLine("help siphon", "header");
          writeLine("Optional passive GC income (risky). Requires `install upg.siphon`.", "dim");
          writeLine("Status: `siphon`", "dim");
          writeLine("Enable/disable: `siphon on` / `siphon off`", "dim");
          writeLine("Intensity: `siphon set low|med|high` (higher = more GC + more risk)", "dim");
          writeLine("Scripted payout: upload a script, then `siphon use relay.uplink:siphon.s`", "dim");
          writeLine("Script output: `ctx.print('gc=2 heat=3')` or `ctx.print(JSON.stringify({gc:2,heat:3}))`", "dim");
          break;
        }

        if (topic === "breach") {
          writeLine("help breach", "header");
          writeLine("Start: `breach sable.gate`", "dim");
          writeLine("Answer: `unlock badge.sig`", "dim");
          writeLine("If you fail too often, TRACE kicks you back. Use `wait`.", "dim");
          break;
        }

        if (topic === "chat") {
          writeLine("help chat", "header");
          writeLine("Send: `say hello`", "dim");
          writeLine("Join: `join #ops`", "dim");
          writeLine("Switch: `switch #kernel`", "dim");
          writeLine("DM an NPC: `tell juniper hi`", "dim");
          writeLine("Or use the chat box: `/help`, `/join #ops`", "dim");
          break;
        }

        writeLine("Unknown help topic. Try: `help`", "warn");
        break;
      }

      writeBlock(
        [
          "Commands:",
          "  scan | probe <loc> | connect <loc>",
          "  breach <loc> | unlock <answer> | wait",
          "  ls | cat <file> | download <file|glob> | downloads",
          "  drive | upload <src> [loc|file|loc:file] [file] | uploads",
          "  store | buy <item> | install <upgrade> | siphon ...",
          "  scripts | call <script> [args] | edit <name> | decode rot13|b64 [text]",
          "  say <text> | join #chan | switch #chan | channels | tell <npc> <msg>",
          "  inventory | install <upgrade> | marks | jobs | turnin <mask|token>",
          "  diagnose | stabilize | corrupt",
          "  save | load | export | import | reset | clear | restart --confirm",
          "",
          "Tips:",
          "  help call        (examples)",
          "  help call ?      (args format)",
          "  help download    (queue + wildcards)",
          "  help download ?  (glob rules)",
        ].join("\n"),
        "dim"
      );
      break;
    case "scripts":
      listScripts();
      break;
    case "call":
    case "run":
      if (!args.length) {
        writeLine("Usage: call <script> [args]", "warn");
        break;
      }
      runScript(args[0], parseScriptArgs(args.slice(1)));
      break;
    case "edit":
      if (!args.length) {
        writeLine("Usage: edit <name>", "warn");
        break;
      }
      {
        const name = args[0];
        let from = null;
        for (let i = 1; i < args.length; i++) {
          const a = String(args[i] || "");
          if (a === "--example") from = "chk.example";
          if (a === "--from" && args[i + 1]) {
            from = String(args[i + 1]);
            i += 1;
          }
          if (a.startsWith("--from=")) from = a.slice("--from=".length);
        }

        const template = from
          ? readAnyText(from) || getLocFileText("home.hub", from)
          : null;
        if (from && !template) {
          writeLine("Template not found.", "warn");
          writeLine("Tip: at home.hub: `cat chk.example`", "dim");
          setEditor(name);
          break;
        }
        setEditor(name, template ? { prefill: template } : undefined);
      }
      break;
    case "scan":
      runScript("scripts.trust.scan", { _: [] });
      storyChatTick();
      tutorialNextHint();
      break;
    case "probe":
      runScript("scripts.trust.probe", parseScriptArgs(args));
      break;
    case "connect":
      if (!args.length) {
        writeLine("Usage: connect <loc>", "warn");
        break;
      }
      connectLoc(args[0]);
      storyChatTick();
      tutorialNextHint();
      break;
    case "breach":
      if (!args.length) {
        writeLine("Usage: breach <loc>", "warn");
        break;
      }
      startBreach(args[0]);
      break;
    case "unlock":
      unlockAttempt(args.join(" "));
      storyChatTick();
      tutorialNextHint();
      break;
    case "ls":
      listFiles();
      break;
    case "cat":
      if (!args.length) {
        writeLine("Usage: cat <file>", "warn");
        break;
      }
      readFile(args[0]);
      storyChatTick();
      break;
    case "download":
      if (!args.length) {
        writeLine("Usage: download <file>", "warn");
        break;
      }
      downloadCommand(args[0]);
      storyChatTick();
      tutorialNextHint();
      break;
    case "downloads":
      downloadsStatus();
      break;
    case "drive":
      listDrive();
      break;
    case "store":
      listStore();
      break;
    case "buy":
      buyItem(args[0]);
      break;
    case "upload":
      uploadCommand(args);
      break;
    case "uploads":
      listUploads();
      break;
    case "del":
      delCommand(args);
      break;
    case "inventory":
      listInventory();
      break;
    case "jobs":
      listJobs();
      break;
    case "turnin":
      turnIn(args[0]);
      break;
    case "diagnose":
      diagnoseProgress();
      break;
    case "store":
      listStore();
      break;
    case "buy":
      buyItem(args[0]);
      break;
    case "siphon":
      siphonCommand(args);
      break;
    case "stabilize":
      setCorruption(false);
      writeLine("Signal stabilized.", "ok");
      break;
    case "corrupt":
      setCorruption(true);
      writeLine("Signal corruption enabled.", "warn");
      break;
    case "decode": {
      const type = (args[0] || "").toLowerCase();
      if (!type) {
        writeLine("Usage: decode rot13|b64 [text]", "warn");
        break;
      }
      const payload = args.slice(1).join(" ");
      decodeCipher(type === "base64" ? "b64" : type, payload);
      break;
    }
    case "marks":
      runScript("scripts.trust.marks", { _: [] });
      break;
    case "say":
      chatPost({ body: args.join(" ") });
      break;
    case "join":
      chatJoin(args[0] || "#kernel");
      break;
    case "switch":
      chatSwitch(args[0] || "#kernel");
      break;
    case "channels":
      chatSystem("channels: " + Array.from(state.chat.channels).sort().join(", "));
      break;
    case "install":
      installUpgrade(args[0]);
      break;
    case "siphon":
      siphonCommand(args);
      break;
    case "wait":
      waitTick();
      break;
    case "tutorial":
      if (args[0] === "off") tutorialSetEnabled(false);
      else if (args[0] === "on") tutorialSetEnabled(true);
      else if (args[0] === "reset") {
        state.tutorial.stepIndex = 0;
        state.tutorial.completed = new Set();
        state.flags.forEach((f) => {
          if (String(f).startsWith("tutorial_start_")) state.flags.delete(f);
        });
        tutorialAdvance();
      }
      tutorialPrint();
      break;
    case "contacts":
      listContacts();
      break;
    case "tell":
      tellNpc(args[0], args.slice(1).join(" "));
      break;
    case "reset": {
      const confirm = flags.has("--confirm");
      if (!confirm) {
        writeLine("WARNING: this deletes your saved game (localStorage).", "warn");
        writeLine("Type: reset --confirm", "warn");
        break;
      }
      localStorage.removeItem(SAVE_KEY);
      writeLine("Save deleted.", "ok");
      break;
    }
    case "restart": {
      const confirm = flags.has("--confirm");
      if (!confirm) {
        writeLine("WARNING: this restarts from scratch and deletes your save.", "warn");
        writeLine("Type: restart --confirm", "warn");
        break;
      }
      if (state.handle) {
        chatPost({ channel: state.chat.channel, from: "sys", body: `*** ${state.handle} disconnected`, kind: "system" });
      }
      localStorage.removeItem(SAVE_KEY);
      screen.innerHTML = "";
      resetToFreshState(true);
      writeLine("Restarted.", "ok");
      writeLine("Enter a handle to begin.", "dim");
      break;
    }
    case "save":
      saveState();
      break;
    case "load":
      loadState();
      break;
    case "export":
      exportSave();
      break;
    case "import": {
      if (!args.length) {
        if (!importPicker) {
          writeLine("Import not available.", "warn");
          break;
        }
        importPicker.click();
        writeLine("Select a save JSON to import...", "dim");
        break;
      }
      const payload = args.join(" ");
      try {
        importSaveObject(JSON.parse(payload));
      } catch (err) {
        writeLine("Import failed: invalid JSON.", "error");
      }
      break;
    }
    case "clear":
      screen.innerHTML = "";
      break;
    case "exfiltrate":
      if (state.loc !== "core.relic") {
        writeLine("No target to exfiltrate here.", "warn");
        break;
      }
      state.flags.add("touched_relic");
      setCorruptionLevel(3);
      writeLine("SIGNAL CORRUPTION DETECTED. Type `stabilize` to clear.", "warn");
      discover(["echo.after", "victory.hall"]);
      state.unlocked.add("echo.after");
      state.unlocked.add("victory.hall");
      chatPost({
        channel: "#kernel",
        from: "archivist",
        body: "If you took it, follow the echo. (connect echo.after)",
      });
      chatPost({
        channel: "#kernel",
        from: "switchboard",
        body: "A clean pocket opens in the aftermath. (connect victory.hall)",
      });
      writeBlock(
        [
          "You lift the relic into your shell. The Drift goes quiet behind you.",
          "A new story begins, sealed from the old net.",
        ].join("\n"),
        "ok"
      );
      break;
    case "restore":
      if (state.loc !== "core.relic") {
        writeLine("No target to restore here.", "warn");
        break;
      }
      state.flags.add("touched_relic");
      setCorruptionLevel(3);
      writeLine("SIGNAL CORRUPTION DETECTED. Type `stabilize` to clear.", "warn");
      discover(["echo.after", "victory.hall"]);
      state.unlocked.add("echo.after");
      state.unlocked.add("victory.hall");
      chatPost({
        channel: "#kernel",
        from: "archivist",
        body: "You left it, but it left a mark. Follow the echo. (connect echo.after)",
      });
      chatPost({
        channel: "#kernel",
        from: "switchboard",
        body: "A clean pocket opens in the aftermath. (connect victory.hall)",
      });
      writeBlock(
        [
          "You bind the relic back to the Drift. The net exhales.",
          "The archive sleeps, but its signal will haunt the edges.",
        ].join("\n"),
        "ok"
      );
      break;
    default:
      writeLine("Unknown command. Type help.", "warn");
      break;
  }

  if (!NON_DIRTY_COMMANDS.has(cmd)) markDirty();
  ensureAutosaveLoop();
  autoSaveNow();
  tutorialAdvance();
  updateHud();
}

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();

    const raw = input.value;
    // Always clear immediately so the box empties even if command handling errors.
    input.value = "";
    const value = String(raw || "").trim();
    if (!value) return;

    writeLine(`${prompt.textContent} ${value}`, "dim");
    state.history.push(value);
    state.historyIndex = state.history.length;
    try {
      handleCommand(value);
    } catch (err) {
      // Keep UI responsive; surface the actual error to help debugging.
      try {
        // eslint-disable-next-line no-console
        console.error(err);
      } catch {}
      const msg =
        err && typeof err === "object" && "message" in err
          ? String(err.message)
          : String(err);
      writeLine(`Command error: ${msg}`, "error");
    }
    return;
  }

  if (event.key === "ArrowUp") {
    if (!state.history.length) return;
    state.historyIndex = Math.max(0, state.historyIndex - 1);
    input.value = state.history[state.historyIndex] || "";
    event.preventDefault();
    return;
  }

  if (event.key === "ArrowDown") {
    if (!state.history.length) return;
    state.historyIndex = Math.min(state.history.length, state.historyIndex + 1);
    input.value = state.history[state.historyIndex] || "";
    event.preventDefault();
  }

  if (event.key === "Tab") {
    event.preventDefault();
    completeInput();
  }
});

// Don't steal focus when users are selecting/copying text from the terminal/chat.
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  // Allow selecting/clicking inside these panels without stealing focus.
  if (
    target.closest("#screen") ||
    target.closest("#chat") ||
    target.closest("#scratch") ||
    target.closest("#right")
  ) {
    return;
  }

  if (target.closest("#cmd") || target.closest("#input-row")) {
    input.focus();
    return;
  }

  if (target.closest("#shell") || target.closest("#layout")) input.focus();
});
setTimeout(() => input.focus(), 0);

if (chatInput) {
  chatInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();

    const raw = chatInput.value;
    const value = raw.trim();
    // Always clear the box on Enter (even if the command is invalid).
    chatInput.value = "";
    if (!value) return;

    if (value.startsWith("/")) {
      const parts = splitArgs(value.slice(1));
      const cmd = (parts[0] || "").toLowerCase();
      const args = parts.slice(1);
      if (cmd === "help") {
        chatHelp();
        return;
      }
      if (cmd === "join") {
        if (!args[0]) {
          chatSystem("Usage: /join #channel");
          return;
        }
        chatJoin(args[0]);
        return;
      }
      if (cmd === "switch") {
        if (!args[0]) {
          chatSystem("Usage: /switch #channel");
          return;
        }
        chatSwitch(args[0]);
        return;
      }
      if (cmd === "channels") {
        chatSystem("channels: " + Array.from(state.chat.channels).sort().join(", "));
        return;
      }
      if (cmd === "tell" || cmd === "dm" || cmd === "whisper") {
        if (!args[0]) {
          chatSystem("Usage: /tell <npc> <msg>");
          return;
        }
        const npc = args[0];
        const msg = args.slice(1).join(" ");
        tellNpc(npc, msg);
        return;
      }
      chatSystem("Unknown chat command. Try /help");
      return;
    }

    // Plain text in the chat box behaves like `say ...`
    chatPost({ body: value });
  });
}

function uniqueSorted(list) {
  return Array.from(new Set(list)).sort();
}

function allScriptNames() {
  const trust = Object.keys(trustScripts);
  const kit = Object.keys(state.kit).map((n) => "kit." + n);
  const user =
    state.handle && state.handle.length
      ? Object.keys(state.userScripts).map((n) => state.handle + "." + n)
      : Object.keys(state.userScripts);
  return uniqueSorted([...trust, ...kit, ...user, ...Object.keys(state.kit), ...Object.keys(state.userScripts)]);
}

function allLocNames() {
  return uniqueSorted(Array.from(state.discovered));
}

function allFileNames() {
  const loc = getLoc(state.loc);
  return uniqueSorted(Object.keys((loc && loc.files) || {}));
}

function allDriveRefs() {
  return uniqueSorted(Object.keys(state.drive || {}).map((k) => driveRef(k)));
}

function allUserScriptRefs() {
  const handle = String(state.handle || "").trim();
  if (!handle) return [];
  return uniqueSorted(Object.keys(state.userScripts || {}).map((n) => `${handle}.${n}`));
}

function allUploadSourceRefs() {
  const scripts = allScriptNames().filter((n) => !String(n).startsWith("scripts.trust"));
  return uniqueSorted([...allDriveRefs(), ...scripts]);
}

function allUpgradeNames() {
  return uniqueSorted(Array.from(state.inventory).filter((i) => i.startsWith("upg.")));
}

function allCommandNames() {
  return [
    "help",
    "scripts",
    "call",
    "run",
    "edit",
    "scan",
    "probe",
    "connect",
    "breach",
    "unlock",
    "ls",
    "cat",
    "download",
    "downloads",
    "drive",
    "store",
    "buy",
    "upload",
    "uploads",
    "del",
    "inventory",
    "jobs",
    "turnin",
    "diagnose",
    "decode",
    "marks",
    "siphon",
    "say",
    "join",
    "switch",
    "channels",
    "contacts",
    "tell",
    "install",
    "wait",
    "tutorial",
    "save",
    "load",
    "export",
    "import",
    "reset",
    "clear",
    "exfiltrate",
    "restore",
    "stabilize",
    "corrupt",
    "restart",
  ];
}

function completeInput() {
  const text = input.value;
  const cursor = input.selectionStart ?? text.length;
  const before = text.slice(0, cursor);
  const after = text.slice(cursor);

  const match = before.match(/(^|\s)([^\s]+)$/);
  const token = match ? match[2] : "";
  const tokenStart = match ? before.length - token.length : before.length;

  const parts = splitArgs(before);
  const cmd = (parts[0] || "").toLowerCase();

  let candidates = [];
  if (parts.length <= 1) {
    candidates = allCommandNames();
  } else if (cmd === "cat") {
    candidates = uniqueSorted([...allFileNames(), ...allDriveRefs(), ...allScriptNames()]);
  } else if (cmd === "download") {
    candidates = allFileNames();
  } else if (cmd === "connect" || cmd === "breach") {
    candidates = allLocNames();
  } else if (cmd === "probe") {
    candidates = allLocNames();
  } else if (cmd === "call" || cmd === "run") {
    candidates = allScriptNames();
  } else if (cmd === "upload") {
    if (parts.length === 2) candidates = allUploadSourceRefs();
    else candidates = allLocNames();
  } else if (cmd === "del") {
    candidates = uniqueSorted([...allDriveRefs(), ...allUserScriptRefs()]);
  } else if (cmd === "decode") {
    candidates = ["rot13", "b64"];
  } else if (cmd === "install") {
    candidates = allUpgradeNames();
  } else if (cmd === "join" || cmd === "switch") {
    candidates = uniqueSorted(Array.from(state.chat.channels));
  } else if (cmd === "tell") {
    candidates = uniqueSorted(Object.keys(NPCS));
  } else if (cmd === "edit") {
    candidates = [];
  }

  const filtered = candidates.filter((c) => c.toLowerCase().startsWith(token.toLowerCase()));
  if (!filtered.length) return;
  if (filtered.length === 1) {
    const next = filtered[0];
    input.value = before.slice(0, tokenStart) + next + after;
    const newCursor = tokenStart + next.length;
    input.setSelectionRange(newCursor, newCursor);
    return;
  }

  // Multiple matches: fill common prefix, then print options to screen.
  let prefix = filtered[0];
  for (let i = 1; i < filtered.length; i++) {
    while (!filtered[i].toLowerCase().startsWith(prefix.toLowerCase()) && prefix.length) {
      prefix = prefix.slice(0, -1);
    }
    if (!prefix.length) break;
  }
  if (prefix.length > token.length) {
    input.value = before.slice(0, tokenStart) + prefix + after;
    const newCursor = tokenStart + prefix.length;
    input.setSelectionRange(newCursor, newCursor);
    return;
  }
  writeLine(filtered.join("    "), "dim");
}

function boot() {
  writeLine("driftshell // local drift sim", "header");
  hookUi();
  renderChat();
  ensureAutosaveLoop();
  if (!loadState({ silent: true })) {
    writeLine("Enter a handle to begin.", "dim");
    writeLine("Tip: type `help` for examples, or `tutorial` to reprint steps.", "dim");
    loadScratchFromStorage();
    tutorialAdvance();
  } else {
    writeLine("Auto-loaded save.", "ok");
    writeLine("Tip: type `restart --confirm` to start over.", "dim");
    tutorialAdvance();
  }
  ensureSiphonLoop();
  updateHud();
}

boot();
