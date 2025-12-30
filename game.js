"use strict";

// DriftShell: local, hackmud-inspired terminal sim (single-player, offline).
// This is a lightweight homage: scripts are code you can edit and call,
// security levels gate cross-script calls, and locs are breached via lock stacks.

const GAME_TITLE = "DriftShell";
const GAME_ID = "driftshell";
const LEGACY_SAVE_KEY = "hackterm_save_v1";
const LEGACY_SCRATCH_KEY_PREFIX = "hackterm_scratch_v1:";

const SAVE_KEY = `${GAME_ID}_save_v1`;
const BRIEF_SEEN_KEY = `${GAME_ID}_brief_seen_v1`;
const LOCAL_FOLDER_DB = `${GAME_ID}_local_folder_v1`;
const LOCAL_FOLDER_STORE = "handles";
const LOCAL_FOLDER_KEY = "scriptsFolder";
const LOCAL_SCRATCH_FILE = "scratch.txt";
const TRUST_MAX_LEVEL = 4;
const TRUST_MIN_LEVEL = 1;
const TRUST_HEAT_THRESHOLD = 6;
const TRUST_COOLDOWN_ON_WAIT = 2;
// Trust/heat/trace framing (in-world, never shown as glossary):
// - Trust: long-memory of the network (changes are rare and costly).
// - Heat: short noise from actions (rises fast, cools fast).
// - Trace: active response when watchers move (escalates from heat/noise).
const SEC_LEVELS = ["NULLSEC", "LOWSEC", "MIDSEC", "HIGHSEC", "FULLSEC"];
// Drive capacity is an in-world abstraction of browser localStorage limits.
// Keep it comfortably below typical per-origin quotas (~5MB).
const DRIVE_MAX_CAP_BYTES = 4_000_000;
// Hackmud-like corruption glyph for "missing" characters in the signal.
const GLITCH_GLYPH = "█";
const PRIMER_PAYLOAD = "DRIFTLOCAL::SEED=7|11|23|5|13|2";
const TRAINING_WORD = "WELCOME";
const TRAINING_HOME = "HOME";
const WARDEN_PAYLOAD = "WARDEN::PHASE=1|KEY=RELIC|TRACE=4";
const UPLINK_PAYLOAD = "UPLINK::PATCH=1|RELAY=MIRROR";
const ROGUE_PAYLOAD = "ROGUE::CORE=3|PATCH=7|TRACE=ADAPT";
const CINDER_PAYLOAD = "CINDER::DEPTH=5|CORE=MANTLE|TRACE=9";
const NARRATIVE_STEPS = [
  {
    id: "island_intro",
    title: "Isolated intro net",
    beats: ["scan", "read", "checksum"],
    nodes: ["island.grid", "island.echo"],
    summary: "A sealed grid that teaches scanning, reading primers, and printing your first keys.",
  },
  {
    name: "trust",
    summary: "Show current trust/heat and narrative beats.",
    usage: ["trust"],
    notes: ["Rapid scans and failed locks raise heat; wait or visit trust.anchor to cool."],
  },
  {
    id: "mesh_explore",
    title: "Outer mesh exploration",
    beats: ["exchange", "sniffer", "weaver"],
    nodes: ["public.exchange", "weaver.den", "monument.beacon"],
    summary: "You leave the island and scrape GC, scripts, and lore from the bazaar and side dens.",
  },
  {
    id: "trust_pressure",
    title: "Security and trust",
    beats: ["trace", "locks", "coolant"],
    nodes: ["trust.anchor", "corp.audit"],
    summary: "Actions raise heat; balanced routing and coolant keep you from getting locked out.",
  },
  {
    id: "glitch_arc",
    title: "Glitched data arc",
    beats: ["fragments", "decode", "repair"],
    nodes: ["glitch.cache", "slipper.hole"],
    summary: "Corrupted fragments hide a chant. Decode, replace missing glyphs, and weave the message.",
  },
  {
    id: "rogue_finale",
    title: "Rogue core showdown",
    beats: ["checksum", "trust", "upload"],
    nodes: ["core.relic", "rogue.core"],
    summary: "A rogue process adapts to you; combine every learned mechanic to pin it down.",
  },
  {
    id: "cinder_depths",
    title: "Cinder depth recovery",
    beats: ["mantle", "trust", "chant"],
    nodes: ["deep.slate", "trench.node", "cinder.core"],
    summary: "An optional depth dive with extra locks, checksum proofs, and repaired chants.",
  },
];
const GLITCH_FRAGMENTS = {
  alpha: { id: "alpha", clue: "FRACTURE", desc: "A sliver that says the drift cracked first." },
  beta: { id: "beta", clue: "MIRROR", desc: "A reflection that does not match the caller." },
  gamma: { id: "gamma", clue: "EMBER", desc: "A spark that keeps burning inside signal noise." },
  delta: { id: "delta", clue: "STILL", desc: "The reminder to slow down when trace rises." },
};
const GLITCH_FRAGMENT_IDS = Object.keys(GLITCH_FRAGMENTS);
const NARRATIVE_CUES = {
  island_intro: "Isolated grid hums back. Heat is a rumor; keys are facts.",
  mesh_explore: "Outer mesh hears you now. Cheap signals, loud watchers.",
  trust_pressure: "Security eyes narrow. Trust and trace move together.",
  glitch_arc: "Corrupted caches surface. Fragments want repair, not pity.",
  rogue_finale: "The rogue listens for a chant and a checksum. Bring both.",
  cinder_depths: "Depth heat leaks upward. Mantle echoes wait for a patient hand.",
};
// Map regions to narrative readiness: regions stay dark until the story reaches these beats.
const REGION_STORY_GATES = {
  introNet: "island_intro",
  publicNet: "mesh_explore",
  corporateNet: "trust_pressure",
  secureCore: "rogue_finale",
  cinderDepth: "cinder_depths",
};

function narrativeStepIndex(stepId) {
  const idx = NARRATIVE_STEPS.findIndex((s) => s.id === stepId || s.name === stepId || s.title === stepId);
  return idx === -1 ? 0 : idx;
}

// Regions only answer once the narrative has reached their gate beat.
function narrativeAllowsRegion(regionId) {
  ensureStoryState();
  const gate = REGION_STORY_GATES[regionId];
  if (!gate) return true;
  const current = state.storyState ? state.storyState.current : null;
  const currentIdx = narrativeStepIndex(current);
  const gateIdx = narrativeStepIndex(gate);
  return currentIdx >= gateIdx;
}
// Region definitions attach existing locs to narrative zones.
// To classify a new or existing host, add its loc id to exactly one `nodes` list below.
// You can extend this list (e.g., add a DLC region) without touching core mechanics.
const REGION_DEFS = [
  {
    id: "introNet",
    name: "Intro Network",
    nodes: ["home.hub", "training.node", "island.grid", "island.echo", "trust.anchor"],
    unlock: { requires: [], flags: [], nodes: [] },
    entry: ["Switchboard reroutes your signal through the safer mesh and reminds you who is watching."],
  },
  {
    id: "publicNet",
    name: "Public Net",
    nodes: [
      "public.exchange",
      "weaver.den",
      "monument.beacon",
      "pier.gate",
      "ember.pier",
      "sable.gate",
      "relay.uplink",
      "mirror.gate",
    ],
    unlock: {
      requires: ["introNet"],
      flags: ["tutorial_training_done"],
      nodes: ["training.node"],
    },
    entry: [
      "Vendors and watchers share a spine here.",
      "Every route pretends to be casual until you breach the wrong vault.",
    ],
  },
  {
    id: "corporateNet",
    name: "Corporate Net",
    nodes: ["archives.arc", "lattice.cache", "corp.audit", "glitch.cache", "slipper.hole", "victory.hall", "echo.after"],
    unlock: {
      requires: ["publicNet"],
      flagsAny: ["sniffer_run", "lattice_sigil", "glitch_chant_known"],
      nodes: ["weaver.den"],
    },
    entry: [
      "The spine hums louder than the exchange.",
      "Security notices every echo; answer with purpose or be routed back to dust.",
    ],
  },
  {
    id: "secureCore",
    name: "Secure Core",
    nodes: ["core.relic", "rogue.core"],
    unlock: { requires: ["corporateNet"], flags: ["touched_relic", "glitch_phrase_ready"], nodes: [] },
    entry: ["A rogue process echoes here. It listens for chants and trust."],
  },
  {
    id: "cinderDepth",
    name: "Cinder Depth",
    nodes: ["deep.slate", "trench.node", "cinder.core"],
    unlock: {
      requires: ["corporateNet"],
      flagsAny: ["glitch_phrase_ready", "mantle_phrase", "chat_cinder_ready"],
      nodes: ["trench.node"],
    },
    entry: [
      "Heat rolls upward from the depth.",
      "The mantle waits for anyone willing to stitch chants to molten checksum.",
    ],
  },
];
const CHK_TEMPLATE_CODE = [
  "// @sec FULLSEC",
  "const primer = ctx.read('primer.dat') || '';",
  "const word = (primer.match(/^word=(.*)$/m) || [])[1] || 'WELCOME';",
  "const home = (primer.match(/^home=(.*)$/m) || [])[1] || 'HOME';",
  "const payload = (primer.match(/^payload=(.*)$/m) || [])[1] || '';",
  "if (!payload) { ctx.print('no payload'); return; }",
  "const handle = ctx.handle();",
  "const text = payload.trim() + '|HANDLE=' + handle;",
  "const sum = ctx.util.checksum(text);",
  "const key3 = ctx.util.hex3(sum);",
  "ctx.print(handle);",
  "ctx.print(String(word).trim());",
  "ctx.print(key3);",
  "ctx.print(handle + ' ' + String(word).trim() + ' ' + String(home).trim() + ' ' + key3);",
].join("\n");
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
    describe: "Improves download speed (~30% faster).",
  },
  "upg.backbone": {
    name: "backbone",
    apply: () => {},
    describe: "Major download speed upgrade (~50% faster).",
  },
  "upg.drive_ext": {
    name: "drive_ext",
    apply: () => {
      state.driveMax = Math.min(DRIVE_MAX_CAP_BYTES, (Number(state.driveMax) || 0) + 40_000);
    },
    describe: "Expands local drive capacity for downloaded files (scripts/items/text).",
  },
  "upg.drive_array": {
    name: "drive_array",
    apply: () => {
      state.driveMax = Math.min(DRIVE_MAX_CAP_BYTES, (Number(state.driveMax) || 0) + 120_000);
    },
    describe: "Large drive expansion for heavy ops.",
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

// Intro island teachable moment: a one-time, in-world nudge that heat is noise,
// trace is response, trust is memory. Fires only once per save when heat rises.
function maybeTeachSecurityMoment(delta) {
  // Only during the intro island region and only once.
  if (state.flags.has("security_taught") || SECURITY_TEACH_SHOWN) return;
  if (state.region && state.region.current && state.region.current !== "introNet") return;
  if (trustHeat() + delta <= 0 && state.trace <= 0) return;

  state.flags.add("security_taught");
  SECURITY_TEACH_SHOWN = true;
  chatPost({
    channel: "#kernel",
    from: "watcher",
    body: "noise rises; watchers stir. heat is noise, trace is response, trust remembers.",
  });
  // No punishment; natural decay will cool heat. This keeps the moment gentle.
}

function trustLevel() {
  if (!state.trust || typeof state.trust !== "object") return TRUST_MIN_LEVEL;
  return Math.max(TRUST_MIN_LEVEL, Math.min(TRUST_MAX_LEVEL, Number(state.trust.level) || TRUST_MIN_LEVEL));
}

function trustHeat() {
  if (!state.trust || typeof state.trust !== "object") return 0;
  return Math.max(0, Number(state.trust.heat) || 0);
}

function trustStatusLabel() {
  const level = trustLevel();
  const heat = trustHeat();
  const tiers = ["fragile", "cautious", "steady", "anchored"];
  const tier = tiers[level - 1] || "unknown";
  return `trust ${level}/${TRUST_MAX_LEVEL} (${tier}, heat ${heat}/${TRUST_HEAT_THRESHOLD})`;
}

function trustAdjustHeat(delta, reason) {
  if (!state.trust || typeof state.trust !== "object") state.trust = { level: 2, heat: 0, lastScanAt: 0 };
  const next = Math.max(0, trustHeat() + delta);
  state.trust.heat = next;
  maybeTeachSecurityMoment(delta);
  // Behavioral profiling: if the player keeps spiking heat, quietly shift watcher tone.
  if (delta > 0) behaviorHeatTone(reason);
  if (next > 0) state.storyState?.flags?.add("heat_seen");
  // Heat implies noise; track for adaptation.
  if (delta > 0) recordRogueBehavior("noise");
  if (delta > 0) recordBehavior("noise");
  const added = discover(["trust.anchor"]);
  if (added.length) {
    chatPost({
      channel: "#kernel",
      from: "switchboard",
      body: "Anchor online. `connect trust.anchor` to bleed heat.",
    });
  }
  const lowered = next >= TRUST_HEAT_THRESHOLD;
  if (lowered) {
    state.trust.heat = Math.max(0, next - TRUST_HEAT_THRESHOLD);
    if (state.trust.level > TRUST_MIN_LEVEL) {
      state.trust.level -= 1;
      // Persist consequence: later regions will react to lower trust via tone and corruption.
      chatPost({
        channel: "#kernel",
        from: "sys",
        body: `trust drop (${reason || "heat"}). level ${state.trust.level}/${TRUST_MAX_LEVEL}`,
        kind: "system",
      });
      watcherTrustMemory();
    } else {
      state.lockoutUntil = Date.now() + 6000;
      chatPost({
        channel: "#kernel",
        from: "sys",
        body: "heat spike -> short lockout. wait or cool at trust.anchor.",
        kind: "system",
      });
    }
  }
  markDirty();
  updateHud();
}

function trustCoolDown(amount, reason) {
  if (!state.trust || typeof state.trust !== "object") state.trust = { level: 2, heat: 0, lastScanAt: 0 };
  const next = Math.max(0, trustHeat() - amount);
  state.trust.heat = next;
  if (reason && reason !== "wait") chatSystem(`trust cool (${reason}) -> heat ${next}/${TRUST_HEAT_THRESHOLD}`);
  if (reason === "wait" || reason === "anchor read") {
    recordBehavior("patient");
    recordRogueBehavior("careful");
    watcherProfileTick();
  }
  markDirty();
  updateHud();
}

function trustGate(required) {
  return trustLevel() >= Math.max(TRUST_MIN_LEVEL, Math.min(TRUST_MAX_LEVEL, Number(required) || 0));
}

function trainingHandle() {
  return state.handle ? String(state.handle) : "ghost";
}

function handleTag() {
  return `HANDLE=${trainingHandle()}`;
}

function primerTextForHandle(payload) {
  return `${payload}|${handleTag()}`;
}

function expectedForChecksumPayload(payload) {
  return hex3(checksumUtf8Mod4096(primerTextForHandle(payload)));
}

function trainingKey1() {
  return trainingHandle();
}

function trainingKey2() {
  return TRAINING_WORD;
}

function trainingKey3() {
  return expectedForChecksumPayload(PRIMER_PAYLOAD);
}

function trainingPhrase() {
  return `${trainingKey1()} ${TRAINING_WORD} ${TRAINING_HOME} ${trainingKey3()}`;
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
const localFolderStatus = document.getElementById("local-folder-status");
const localFolderPick = document.getElementById("local-folder-pick");
const localFolderSync = document.getElementById("local-folder-sync");
const localFolderMirror = document.getElementById("local-folder-mirror");
const localFolderForget = document.getElementById("local-folder-forget");

let saveDirty = false;
let autosaveTimer = null;
let autosaveInterval = null;
let lastAutosaveAt = 0;
let siphonInterval = null;
let booting = false;
let bootTimers = [];
let localFolderHandle = null;
let localSyncPoll = null;
let localSyncPollActive = false;
let localScratchLastLocalEdit = 0;
let localScratchPending = null;
const localFileMeta = new Map();
const AUTOSAVE_MIN_INTERVAL_MS = 15_000;
const AUTOSAVE_FORCE_INTERVAL_MS = 60_000;
const NON_DIRTY_COMMANDS = new Set([
  "help",
  "scripts",
  "ls",
  "downloads",
  "drive",
  "folder",
  "uploads",
  "inventory",
  "channels",
  "contacts",
  "jobs",
  "diagnose",
  "trust",
  "regions",
  "status",
]);

// RegionManager is assigned later; declare upfront to avoid TDZ errors where it is referenced before definition.
let RegionManager;
let ESCALATION_SILENCE = 0;
let SECURITY_TEACH_SHOWN = false;

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
  storyProgressEvent("corruption", { level: n });
  if (n >= 2 && !state.flags.has("trace_corrupt_escalated")) {
    state.flags.add("trace_corrupt_escalated");
    chatPost({
      channel: "#kernel",
      from: "watcher",
      body: "signal warps under strain. some replies may distort.",
    });
  }
}

function markDirty() {
  saveDirty = true;
  if (typeof RegionManager !== "undefined") RegionManager.bootstrap({ silent: true });
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

function setBooting(on) {
  booting = !!on;
  try {
    document.body.classList.toggle("booting", booting);
  } catch {}
  if (input) input.disabled = booting;
  if (chatInput) chatInput.disabled = booting;
}

function clearBootTimers() {
  bootTimers.forEach((t) => {
    try {
      window.clearTimeout(t);
    } catch {}
  });
  bootTimers = [];
}

function scheduleBootLine(text, kind, delayMs) {
  const t = window.setTimeout(() => {
    writeLine(text, kind);
  }, delayMs);
  bootTimers.push(t);
}

function runBootSequence({ hasSave }) {
  setBooting(true);
  clearBootTimers();
  screen.innerHTML = "";

  // Rotating boot easter eggs (real pop-culture/game nods; short lines).
  const EASTER_EGG_LINES = [
    // cyberpunk / netrunning
    "wake up, samurai...",
    "night city ........ online",
    "arasaka ........... watching",
    "militech .......... probing",
    "netrunner ......... jacked in",
    "quickhack ......... queued",
    "daemon ............ resident",
    "daemon ............ sleeping",
    "ice ............... detected",
    "black ice ......... dormant",
    "braindance ........ buffered",
    "overclock ......... engaged",
    "chrome ............ humming",
    "edgerunner ........ steady",
    "zero cool ......... (myth)",
    "the gibson ........ humming",
    "console cowboy .... online",
    "neuromancer ....... page 1",
    "snow crash ........ incoming",
    "meatspace ......... ignored",

    // hackmud (light nods, no lore claims)
    "scripts.* ......... indexed",
    "@sec .............. parsed",
    "FULLSEC ........... greenlit",
    "MIDSEC ............ shaky",
    "LOWSEC ............ noisy",
    "NULLSEC ........... void",
    "trust ............. watching",
    "trace ............. watchful",
    "kernel ............ calm",
    "uplink ............ listening",
    "lattice ........... aligned",
    "sigil ............. recognized",
    "mark .............. accepted",
    "gate .............. humming",
    "perimeter ......... strict",
    "exchange .......... loud",
    "scratch ........... persistent",
    "chat .............. connected",

    // classic hacker / sci-fi staples
    "hello, friend",
    "follow the white rabbit",
    "there is no spoon",
    "wake up, neo",
    "i know kung fu",
    "matrix ............ green rain",
    "ghost in the shell",
    "blade runner ...... rain",
    "replicant ......... baseline",
    "system shock ...... warning",
    "tron .............. lightcycle",
    "skynet ............ (no)",
    "hal ............... calm voice",
    "stargate .......... dialing",
    "alien ............. signal",
    "the truth is out there",
    "wintermute ........ ping",
    "turing ............ test",
    "basilisk .......... (avoid)",

    // games / gaming culture
    "the cake is a lie",
    "aperture .......... (classified)",
    "portal ............ calibrated",
    "glados ............ awake",
    "would you kindly",
    "war never changes",
    "hey, you. you're finally awake.",
    "stay awhile and listen",
    "a man chooses",
    "no gods or kings. only man.",
    "finish him",
    "fatality .......... confirmed",
    "hadouken .......... queued",
    "all your base ...... belong to us",
    "rise and shine",
    "right man ......... wrong place",
    "snake? snake!?",
    "kept you waiting, huh?",
    "do a barrel roll",
    "the princess is in another castle",
    "it's dangerous to go alone",
    "you died",
    "praise the sun",
    "try finger but hole",
    "git gud ........... (rude)",
    "respawn ........... imminent",
    "checkpoint ........ saved",
    "new objective ...... unknown",
    "sidequest .......... hidden",
    "press start ....... (missing)",
    "insert coin ....... (no slot)",
    "continue? ......... y/n",

    // hacker movies / shows
    "would you like to play a game?",
    "war games ......... nostalgia",
    "hack the planet",
    "mess with the best",
    "acid burn ......... (offline)",
    "mr. robot ......... (static)",
    "fsociety .......... (quiet)",
    "watchdogs ......... online",
    "deus ex ........... augment",

    // terminals / unix-y
    "rm -rf ............ (tempting)",
    "sudo .............. refused",
    "grep .............. found",
    "awk ............... yes",
    "chmod ............. set",
    "ssh ............... connected",
    "telnet ............ (nostalgia)",
    "vim ............... trapped",
    "emacs ............. (too big)",
    "cat ............... purring",
    "ls ................ ok",
    "ping .............. reply",
    "localhost ......... home",
    "permission denied",
    "access granted",
    "access denied",
    "unauthorized ....... logged",
    "retry ............. suggested",
    "404 ............... not found",
    "1337 .............. (lol)",
    "0xDEAD ............ 0xBEEF",

    // more short, real-adjacent cyber references
    "handshake ......... accepted",
    "key exchange ...... negotiated",
    "proxy chain ....... 3 hops",
    "tunnel ............ established",
    "packet drift ...... within spec",
    "null route ........ stable",
    "buffer ............ flushed",
    "stack canary ...... intact",
    "syscall ........... permitted",
    "entropy pool ...... high",
    "signal ............ noise floor",
    "checksum .......... verified",
    "checksum .......... mismatch",
    "cipher ............ rotated",
    "cipher ............ decoded",
    "payload ........... formed",
    "payload ........... rejected",
    "latency ........... acceptable",
    "latency ........... spiking",
    "bandwidth ......... thin",
    "bandwidth ......... wide",
    "boot sector ....... readable",
    "disk .............. spinning",
    "tape .............. rewinding",
    "crt ............... warming",
    "scanlines ......... stable",
    "phosphor .......... glowing",
    "drive array ....... online",
    "modem ............. screaming",
    "backbone .......... lit",

    // extra nerdy nods (still short)
    "open the pod bay doors",
    "enhance ........... enhance",
    "in the grim darkness",
    "winter is coming",
    "so say we all",
    "live long and prosper",
    "the spice must flow",
    "this is fine",
    "i'm in",
  ];
  const easterEgg = EASTER_EGG_LINES[Math.floor(Math.random() * EASTER_EGG_LINES.length)];

  const logo = [
    "  _____   _____   _____  ______  _______  _____  _    _  ______  _       _      ",
    " |  __ \\ |  __ \\ |_   _||  ____||__   __|/ ____|| |  | ||  ____|| |     | |     ",
    " | |  | || |__) |  | |  | |__      | |  | (___  | |__| || |__   | |     | |     ",
    " | |  | ||  _  /   | |  |  __|     | |   \\___ \\ |  __  ||  __|  | |     | |     ",
    " | |__| || | \\ \\  _| |_ | |        | |   ____) || |  | || |____ | |____ | |____ ",
    " |_____/ |_|  \\_\\|_____||_|        |_|  |_____/ |_|  |_||______||______||______|",
    "                           DRIFTSHELL :: DRIFT LOCAL",
  ];

  // Print logo first, then boot lines under it.
  const baseLogoAt = 120;
  logo.forEach((line, idx) => scheduleBootLine(line, "boot bootlogo header", baseLogoAt + idx * 70));

  const afterLogoAt = baseLogoAt + logo.length * 70 + 220;
  scheduleBootLine(" ", "boot bootlogo dim", afterLogoAt - 120);

  const steps = [
    { t: 0, kind: "boot bootlog dim", text: "BOOTSTRAP v0.9 :: drift-compatible" },
    { t: 220, kind: "boot bootlog dim", text: "devsig ............ ErebusAres" },
    { t: 430, kind: "boot bootlog dim", text: "memchk ............ ok" },
    { t: 640, kind: "boot bootlog dim", text: "ioctl  ............ ok" },
    { t: 860, kind: "boot bootlog dim", text: "gpu   ............. ok" },
    { t: 1100, kind: "boot bootlog dim", text: "netlink DRIFT/LOCAL  ok" },
    { t: 1320, kind: "boot bootlog dim", text: "chatd ............. init" },
    { t: 1540, kind: "boot bootlog dim", text: hasSave ? "scratch ........... restoring session" : "scratch ........... ready" },
    // Easter egg (random)
    { t: 1760, kind: "boot bootlog dim", text: easterEgg },
    { t: 1980, kind: "boot bootlog dim", text: "mount /shell ....... ok" },
    { t: 2200, kind: "boot bootlog dim", text: "press any key to skip" },
  ];

  steps.forEach((s) => scheduleBootLine(s.text, s.kind, afterLogoAt + s.t));

  const doneAt = afterLogoAt + 2550;
  const finish = () => {
    clearBootTimers();
    setBooting(false);
    try {
      input.focus();
    } catch {}
  };

  const doneTimer = window.setTimeout(() => finish(), doneAt);
  bootTimers.push(doneTimer);

  // Allow skip with any key press.
  const onSkip = (ev) => {
    if (!booting) return;
    if (ev && (ev.ctrlKey || ev.metaKey || ev.altKey)) return;
    clearBootTimers();
    finish();
  };
  document.addEventListener("keydown", onSkip, { once: true });
  return doneAt;
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

function supportsLocalFolder() {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

async function localFolderPermissionGranted(writeAccess) {
  if (!localFolderHandle || !localFolderHandle.queryPermission) return false;
  const mode = writeAccess ? "readwrite" : "read";
  try {
    const perm = await localFolderHandle.queryPermission({ mode });
    return perm === "granted";
  } catch {
    return false;
  }
}

function localFolderGuard() {
  if (!supportsLocalFolder()) {
    writeLine("Local folder sync requires a Chromium-based browser (Chrome/Edge/Brave).", "warn");
    return false;
  }
  if (!window.isSecureContext) {
    writeLine("Local folder sync requires https or localhost.", "warn");
    return false;
  }
  return true;
}

function setLocalFolderStatus(text, kind) {
  if (!localFolderStatus) return;
  localFolderStatus.textContent = text;
  localFolderStatus.classList.remove("ok", "warn", "dim");
  localFolderStatus.classList.add(kind || "dim");
}

function setLocalFolderControls({ supported, hasHandle }) {
  if (localFolderPick) localFolderPick.disabled = !supported;
  if (localFolderSync) localFolderSync.disabled = !supported || !hasHandle;
  if (localFolderForget) localFolderForget.disabled = !supported || !hasHandle;
  if (localFolderMirror) {
    localFolderMirror.disabled = !supported || !hasHandle;
    localFolderMirror.checked = !!(state.localSync && state.localSync.mirror);
  }
}

async function refreshLocalFolderUi() {
  if (!supportsLocalFolder()) {
    setLocalFolderControls({ supported: false, hasHandle: false });
    setLocalFolderStatus("Local sync needs Chromium (Chrome/Edge/Brave).", "warn");
    return;
  }
  if (!window.isSecureContext) {
    setLocalFolderControls({ supported: false, hasHandle: false });
    setLocalFolderStatus("Local sync requires https or localhost.", "warn");
    return;
  }
  const hasHandle = !!localFolderHandle;
  setLocalFolderControls({ supported: true, hasHandle });
  if (!hasHandle) {
    setLocalFolderStatus("Local folder not set.", "dim");
    return;
  }
  try {
    const perm = await localFolderHandle.queryPermission({ mode: "readwrite" });
    if (perm === "granted") {
      setLocalFolderStatus("Local folder connected.", "ok");
    } else if (perm === "prompt") {
      setLocalFolderStatus("Local folder permission required.", "warn");
    } else {
      setLocalFolderStatus("Local folder permission denied.", "warn");
    }
  } catch {
    setLocalFolderStatus("Local folder status unknown.", "warn");
  }
  ensureLocalSyncPoll();
}

function openLocalFolderDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(LOCAL_FOLDER_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LOCAL_FOLDER_STORE)) {
        db.createObjectStore(LOCAL_FOLDER_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB error"));
  });
}

async function localFolderDbGet() {
  const db = await openLocalFolderDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_FOLDER_STORE, "readonly");
    const store = tx.objectStore(LOCAL_FOLDER_STORE);
    const req = store.get(LOCAL_FOLDER_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error("IndexedDB get failed"));
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  });
}

async function localFolderDbSet(handle) {
  const db = await openLocalFolderDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_FOLDER_STORE, "readwrite");
    const store = tx.objectStore(LOCAL_FOLDER_STORE);
    const req = store.put(handle, LOCAL_FOLDER_KEY);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error || new Error("IndexedDB set failed"));
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  });
}

async function localFolderDbClear() {
  const db = await openLocalFolderDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_FOLDER_STORE, "readwrite");
    const store = tx.objectStore(LOCAL_FOLDER_STORE);
    const req = store.delete(LOCAL_FOLDER_KEY);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error || new Error("IndexedDB clear failed"));
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  });
}

async function ensureLocalFolderPermission(writeAccess) {
  if (!localFolderHandle) return { ok: false, reason: "missing" };
  if (!localFolderHandle.queryPermission) return { ok: true };
  const mode = writeAccess ? "readwrite" : "read";
  try {
    let perm = await localFolderHandle.queryPermission({ mode });
    if (perm === "granted") return { ok: true };
    if (localFolderHandle.requestPermission) {
      perm = await localFolderHandle.requestPermission({ mode });
    }
    return { ok: perm === "granted", reason: perm };
  } catch (err) {
    return { ok: false, reason: err && err.message ? err.message : "permission error" };
  }
}

async function initLocalFolder() {
  await refreshLocalFolderUi();
  if (!supportsLocalFolder() || !window.isSecureContext) return;
  try {
    const handle = await localFolderDbGet();
    if (handle && handle.kind === "directory") {
      localFolderHandle = handle;
    }
  } catch {}
  await refreshLocalFolderUi();
  ensureLocalSyncPoll();
}

async function backfillLocalFolderFromDrive(options) {
  const opts = options || {};
  if (!shouldMirrorLocal()) return;
  if (!supportsLocalFolder() || !window.isSecureContext) return;
  if (!localFolderHandle) return;
  const canWrite = opts.prompt
    ? (await ensureLocalFolderPermission(true)).ok
    : await localFolderPermissionGranted(true);
  if (!canWrite) return;

  let added = 0;
  const entries = Object.values(state.drive || {});
  for (const entry of entries) {
    if (!entry || (entry.type !== "script" && entry.type !== "text")) continue;
    const name = localMirrorFileName(entry.loc, entry.name);
    let exists = false;
    try {
      await localFolderHandle.getFileHandle(name);
      exists = true;
    } catch {}
    if (exists) continue;
    const content = String(entry.content || "");
    try {
      await writeLocalMirrorFile(name, content);
      localFileMeta.set(name, { lastModified: Date.now(), size: content.length });
      added += 1;
    } catch {}
  }
  if (!opts.silent && added) writeLine(`Local sync: mirrored ${added} drive file(s).`, "dim");
}

async function pickLocalFolder() {
  if (!localFolderGuard()) return;
  try {
    const handle = await window.showDirectoryPicker();
    localFolderHandle = handle;
    await localFolderDbSet(handle);
    await ensureLocalFolderPermission(true);
    writeLine("Local folder set.", "ok");
    await refreshLocalFolderUi();
    ensureLocalSyncPoll();
  } catch (err) {
    if (err && err.name === "AbortError") return;
    writeLine(
      "Local folder pick failed: " + (err && err.message ? err.message : "error"),
      "error"
    );
  }
}

async function forgetLocalFolder() {
  localFolderHandle = null;
  try {
    await localFolderDbClear();
  } catch {}
  writeLine("Local folder cleared.", "dim");
  await refreshLocalFolderUi();
  ensureLocalSyncPoll();
}

async function reportLocalFolderStatus() {
  if (!localFolderGuard()) return;
  if (!localFolderHandle) {
    writeLine("Local folder not set. Run: folder pick", "warn");
    return;
  }
  const perm = await ensureLocalFolderPermission(false);
  if (!perm.ok) {
    writeLine("Local folder permission denied.", "warn");
    await refreshLocalFolderUi();
    return;
  }
  writeLine("Local folder connected.", "ok");
  writeLine(`Mirror downloads: ${state.localSync && state.localSync.mirror ? "on" : "off"}`, "dim");
}

function localScriptNameFromFile(fileName) {
  return String(fileName || "").replace(/\.s$/i, "").trim();
}

async function syncLocalFolder() {
  if (!localFolderGuard()) return;
  if (!localFolderHandle) {
    writeLine("Local folder not set. Run: folder pick", "warn");
    return;
  }
  if (!state.handle) {
    writeLine("Set a handle before syncing local scripts.", "warn");
    return;
  }
  const perm = await ensureLocalFolderPermission(false);
  if (!perm.ok) {
    writeLine("Local folder permission denied.", "warn");
    await refreshLocalFolderUi();
    return;
  }

  let seen = 0;
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let scratchUpdated = false;
  try {
    for await (const entry of localFolderHandle.values()) {
      if (!entry || entry.kind !== "file") continue;
      const name = String(entry.name || "");
      const lower = name.toLowerCase();
      if (lower === LOCAL_SCRATCH_FILE) {
        const changed = await refreshLocalScratchFromFolder(entry);
        if (changed) scratchUpdated = true;
        continue;
      }
      const file = await entry.getFile();
      updateLocalFileMeta(name, file);
      const mirror = parseMirrorDownloadName(name);
      if (mirror && state.drive && state.drive[driveId(mirror.loc, mirror.file)]) {
        const nextContent = await file.text();
        const driveIdKey = driveId(mirror.loc, mirror.file);
        const driveEntry = state.drive[driveIdKey];
        if (driveEntry.type !== "script" && driveEntry.type !== "text") continue;
        if (driveEntry.type === "script" && driveEntry.script && driveEntry.script.name && state.kit) {
          state.kit[driveEntry.script.name] = {
            owner: "kit",
            name: driveEntry.script.name,
            sec: driveEntry.script && driveEntry.script.sec ? driveEntry.script.sec : "FULLSEC",
            code: nextContent,
          };
        }
        updateDriveContent(driveIdKey, nextContent);
        updated += 1;
        continue;
      }
      if (!lower.endsWith(".s")) continue;
      const scriptName = localScriptNameFromFile(name);
      if (!scriptName) continue;
      const text = await file.text();
      seen += 1;

      const existing = state.userScripts && state.userScripts[scriptName];
      const existingCode = existing && typeof existing.code === "string" ? existing.code : null;
      const secMatch = text.match(/@sec\s+(FULLSEC|HIGHSEC|MIDSEC|LOWSEC|NULLSEC)/i);
      const sec = secMatch ? secMatch[1].toUpperCase() : "FULLSEC";
      state.userScripts[scriptName] = { owner: state.handle, name: scriptName, sec, code: text };

      if (!existing) added += 1;
      else if (existingCode !== text || existing.sec !== sec) updated += 1;
      else unchanged += 1;

      const driveName = `${state.handle}.${scriptName}.s`;
      const driveKey = driveId("local", driveName);
      const meta = { type: "script", script: { name: scriptName, sec, code: text } };
      if (driveHas(driveKey)) updateDriveContent(driveKey, text, meta);
      else storeDriveCopy("local", driveName, meta);
    }
  } catch (err) {
    writeLine("Local sync failed: " + (err && err.message ? err.message : "error"), "error");
    return;
  }

  if (!seen) {
    if (updated) {
      writeLine(`Local sync complete: ${updated} updated.`, "ok");
      return;
    }
    if (scratchUpdated) {
      writeLine("Local sync complete: scratch updated.", "ok");
    } else {
      writeLine("Local sync complete: no .s files found.", "dim");
    }
    await backfillLocalFolderFromDrive({ silent: true, prompt: true });
    return;
  }
  const suffix = scratchUpdated ? " (+scratch)" : "";
  writeLine(`Local sync complete: ${added} new, ${updated} updated, ${unchanged} unchanged.${suffix}`, "ok");
  await backfillLocalFolderFromDrive({ silent: true, prompt: true });
  markDirty();
  updateHud();
}

async function writeLocalMirrorFile(name, content) {
  const fileHandle = await localFolderHandle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

function shouldMirrorLocal() {
  return !!(state.localSync && state.localSync.mirror);
}

function localMirrorFileName(locName, fileName) {
  const loc = String(locName || "").trim();
  const file = String(fileName || "").trim();
  return loc && file ? `${loc}.${file}` : file || "download.txt";
}

function parseMirrorDownloadName(name) {
  const fileName = String(name || "").trim();
  if (!fileName) return null;
  const locs = Object.keys(LOCS || {}).sort((a, b) => b.length - a.length);
  const match = locs.find((loc) => fileName.startsWith(loc + "."));
  if (!match) return null;
  const rest = fileName.slice(match.length + 1);
  if (!rest) return null;
  return { loc: match, file: rest };
}

function removeDownloadedEntry(locName, fileName) {
  const id = driveId(locName, fileName);
  const entry = state.drive && state.drive[id] ? state.drive[id] : null;
  if (!entry) return false;
  if (entry.type !== "script" && entry.type !== "text") return false;
  delete state.drive[id];
  if (entry.type === "script" && entry.script && entry.script.name && state.kit) {
    delete state.kit[entry.script.name];
  }
  markDirty();
  return true;
}

async function mirrorDownloadToLocalFolder(locName, fileName, entry) {
  if (!shouldMirrorLocal()) return;
  if (!localFolderHandle) {
    writeLine("Local mirror enabled but no folder selected.", "warn");
    return;
  }
  const perm = await ensureLocalFolderPermission(true);
  if (!perm.ok) {
    writeLine("Local mirror blocked: permission denied.", "warn");
    await refreshLocalFolderUi();
    return;
  }

  let content = "";
  if (entry.type === "script") content = String((entry.script && entry.script.code) || "");
  else if (entry.type === "text") content = String(entry.content || "");
  else return;

  const targetName = localMirrorFileName(locName, fileName);
  try {
    await writeLocalMirrorFile(targetName, content);
    localFileMeta.set(targetName, { lastModified: Date.now(), size: content.length });
  } catch (err) {
    writeLine("Local mirror failed: " + (err && err.message ? err.message : "error"), "warn");
  }
}

async function mirrorUserScriptToLocalFolder(scriptName, code) {
  if (!shouldMirrorLocal()) return;
  if (!supportsLocalFolder() || !window.isSecureContext) return;
  if (!localFolderHandle) return;
  const perm = await ensureLocalFolderPermission(true);
  if (!perm.ok) {
    writeLine("Local sync blocked: permission denied.", "warn");
    await refreshLocalFolderUi();
    return;
  }
  const name = String(scriptName || "").trim();
  if (!name) return;
  try {
    await writeLocalMirrorFile(`${name}.s`, String(code || ""));
  } catch (err) {
    writeLine("Local script save failed: " + (err && err.message ? err.message : "error"), "warn");
  }
}

async function mirrorScratchToLocalFolder(text) {
  if (!shouldMirrorLocal()) return;
  if (!supportsLocalFolder() || !window.isSecureContext) return;
  if (!localFolderHandle) return;
  const perm = await ensureLocalFolderPermission(true);
  if (!perm.ok) return;
  try {
    await writeLocalMirrorFile(LOCAL_SCRATCH_FILE, String(text || ""));
    localFileMeta.set(LOCAL_SCRATCH_FILE, {
      lastModified: Date.now(),
      size: String(text || "").length,
    });
  } catch (err) {
    writeLine("Local scratch save failed: " + (err && err.message ? err.message : "error"), "warn");
  }
}

function updateLocalFileMeta(name, file) {
  if (!file) return;
  localFileMeta.set(name, { lastModified: file.lastModified || 0, size: file.size || 0 });
}

async function applyLocalScratchUpdate(text) {
  if (!scratchPad) return;
  scratchPad.value = text;
  saveScratchToStorage();
  localScratchPending = null;
}

async function refreshLocalScratchFromFolder(entry) {
  if (!entry) return false;
  const file = await entry.getFile();
  updateLocalFileMeta(LOCAL_SCRATCH_FILE, file);
  const text = await file.text();
  if (scratchPad && scratchPad.value === text) return false;
  if (Date.now() - localScratchLastLocalEdit < 1200) {
    localScratchPending = text;
    return false;
  }
  await applyLocalScratchUpdate(text);
  return true;
}

function ensureLocalSyncPoll() {
  const canPoll =
    shouldMirrorLocal() && supportsLocalFolder() && window.isSecureContext && !!localFolderHandle;
  if (canPoll && !localSyncPoll) {
    localSyncPoll = window.setInterval(() => {
      if (localSyncPollActive) return;
      localSyncPollActive = true;
      pollLocalFolderChanges()
        .catch(() => {})
        .finally(() => {
          localSyncPollActive = false;
        });
    }, 5000);
  }
  if (!canPoll && localSyncPoll) {
    window.clearInterval(localSyncPoll);
    localSyncPoll = null;
  }
}

async function pollLocalFolderChanges() {
  if (!shouldMirrorLocal()) return;
  if (!localFolderHandle) return;
  const perm = await ensureLocalFolderPermission(false);
  if (!perm.ok) return;

  let scriptUpdates = 0;
  let scratchUpdated = false;
  const seen = new Set();
  for await (const entry of localFolderHandle.values()) {
    if (!entry || entry.kind !== "file") continue;
    const name = String(entry.name || "");
    const lower = name.toLowerCase();
    const isScratch = lower === LOCAL_SCRATCH_FILE;
    seen.add(name);

    const file = await entry.getFile();
    const prior = localFileMeta.get(name);
    const sameMeta = prior && prior.lastModified === file.lastModified && prior.size === file.size;
    if (sameMeta) continue;

    if (isScratch) {
      const changed = await refreshLocalScratchFromFolder(entry);
      if (changed) scratchUpdated = true;
      continue;
    }

    const text = await file.text();
    updateLocalFileMeta(name, file);
    const mirror = parseMirrorDownloadName(name);
    if (mirror && state.drive && state.drive[driveId(mirror.loc, mirror.file)]) {
      const driveIdKey = driveId(mirror.loc, mirror.file);
      const driveEntry = state.drive[driveIdKey];
      if (driveEntry.type !== "script" && driveEntry.type !== "text") continue;
      const nextContent = String(text || "");
      if (driveEntry.type === "script" && driveEntry.script && driveEntry.script.name && state.kit) {
        state.kit[driveEntry.script.name] = {
          owner: "kit",
          name: driveEntry.script.name,
          sec: driveEntry.script && driveEntry.script.sec ? driveEntry.script.sec : "FULLSEC",
          code: nextContent,
        };
      }
      updateDriveContent(driveIdKey, nextContent);
      scriptUpdates += 1;
      continue;
    }
    const isScript = lower.endsWith(".s");
    if (!isScript) continue;
    const scriptName = localScriptNameFromFile(name);
    if (!scriptName) continue;
    if (!state.handle) continue;
    const secMatch = text.match(/@sec\s+(FULLSEC|HIGHSEC|MIDSEC|LOWSEC|NULLSEC)/i);
    const sec = secMatch ? secMatch[1].toUpperCase() : "FULLSEC";
    const existing = state.userScripts && state.userScripts[scriptName];
    const existingCode = existing && typeof existing.code === "string" ? existing.code : null;
    if (!existing || existingCode !== text || existing.sec !== sec) {
      state.userScripts[scriptName] = { owner: state.handle, name: scriptName, sec, code: text };
      const driveName = `${state.handle}.${scriptName}.s`;
      const driveKey = driveId("local", driveName);
      const meta = { type: "script", script: { name: scriptName, sec, code: text } };
      if (driveHas(driveKey)) updateDriveContent(driveKey, text, meta);
      else storeDriveCopy("local", driveName, meta);
      scriptUpdates += 1;
    }
  }

  if (localFileMeta.size) {
    Array.from(localFileMeta.keys()).forEach((key) => {
      if (seen.has(key)) return;
      const mirror = parseMirrorDownloadName(key);
      if (!mirror) return;
      const removed = removeDownloadedEntry(mirror.loc, mirror.file);
      if (removed) {
        localFileMeta.delete(key);
        scriptUpdates += 1;
      }
    });
  }

  if (localScratchPending && Date.now() - localScratchLastLocalEdit >= 1200) {
    await applyLocalScratchUpdate(localScratchPending);
    scratchUpdated = true;
  }

  if (scriptUpdates || scratchUpdated) {
    const bits = [];
    if (scriptUpdates) bits.push(`${scriptUpdates} script${scriptUpdates === 1 ? "" : "s"}`);
    if (scratchUpdated) bits.push("scratch");
    writeLine(`Local sync: updated ${bits.join(" + ")}.`, "ok");
    markDirty();
    updateHud();
  }
}

function writeLine(text, kind) {
  const line = document.createElement("div");
  line.className = `line${kind ? " " + kind : ""}`;
  renderTerminalRich(line, applyEscalationTextEffects(String(text)));
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

function writeLineWithChips(prefixText, commands, kind) {
  const line = document.createElement("div");
  line.className = `line${kind ? " " + kind : ""}`;

  if (prefixText) {
    renderTerminalRich(line, String(prefixText));
  }

  (commands || []).forEach((cmd) => {
    const c = String(cmd || "").trim();
    if (!c) return;
    line.appendChild(document.createTextNode(prefixText ? " " : ""));
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cmd-chip";
    btn.setAttribute("data-cmd", c);
    btn.textContent = c;
    line.appendChild(btn);
    prefixText = ""; // only apply once
  });

  screen.appendChild(line);
  screen.scrollTop = screen.scrollHeight;
}

function extractBacktickCommands(text) {
  const raw = String(text || "");
  const out = [];
  const re = /`([^`]+)`/g;
  let m;
  while ((m = re.exec(raw))) {
    const cmd = String(m[1] || "").trim();
    // Only treat it like a command if it begins with a letter or slash.
    if (!cmd) continue;
    if (!/^[A-Za-z/]/.test(cmd)) continue;
    out.push(cmd);
  }
  return Array.from(new Set(out));
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
    const nameSpan = document.createElement("span");
    nameSpan.className =
      "chat-name " + (m.kind === "system" ? "dim" : colorClass);
    nameSpan.textContent = m.kind === "system" ? "sys" : m.from;
    nameSpan.dataset.chatName = nameSpan.textContent;
    body.appendChild(nameSpan);

    if (channel.startsWith("@")) {
      const isOutgoing = m.from === state.handle;
      const target = isOutgoing ? channel : "@" + (state.handle || "you");
      body.appendChild(document.createTextNode(" >> "));
      const tag = document.createElement("span");
      tag.className = "chat-dm-tag tok magenta";
      tag.textContent = target;
      body.appendChild(tag);
      body.appendChild(document.createTextNode(" :: "));
    } else {
      body.appendChild(document.createTextNode(" :: "));
    }

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
  localScratchLastLocalEdit = Date.now();
  if (scratchSaveTimer) window.clearTimeout(scratchSaveTimer);
  scratchSaveTimer = window.setTimeout(() => {
    scratchSaveTimer = null;
    saveScratchToStorage();
    void mirrorScratchToLocalFolder(scratchPad.value);
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
  text = applyEscalationTextEffects(String(text || ""));
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
  const entry = {
    t: Date.now(),
    channel: channel || state.chat.channel,
    from: resolvedFrom,
    body: String(body || ""),
    kind: resolvedKind,
    color: resolvedKind === "system" ? null : userColorClass(resolvedFrom),
    uid: resolvedKind === "system" ? "----" : userId4(resolvedFrom),
  };
  state.chat.log.push(entry);
  renderChat();
  return entry;
}

function chatSystem(body) {
  return chatPost({ from: "sys", body, kind: "system" });
}

function chatSystemTransient(body, ttlMs = 1200) {
  const entry = chatSystem(body);
  if (!entry) return;
  window.setTimeout(() => {
    if (!state || !state.chat || !Array.isArray(state.chat.log)) return;
    state.chat.log = state.chat.log.filter((m) => m && m.t !== entry.t);
    renderChat();
  }, Math.max(0, Number(ttlMs) || 0));
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

function handleChatLine(raw) {
  const value = String(raw || "").trim();
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

  if (/^tell\s+/i.test(value)) {
    const parts = splitArgs(value);
    const npc = parts[1];
    const msg = parts.slice(2).join(" ");
    if (!npc) {
      chatSystem("Usage: tell <npc> <msg>");
      return;
    }
    tellNpc(npc, msg);
    return;
  }

  // Plain text behaves like `say ...`.
  chatPost({ body: value });
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
      "Welcome to my exchange. I sell junk, not morals.",
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
  if (id === "juniper") {
    const hasWork = !state.flags.has("q_juniper_mask_done");
    const intro = hasWork
      ? "Welcome to my exchange. I sell junk, not morals. Ask for `work` if you want a contract."
      : "Welcome to my exchange. I sell junk, not morals. No contracts right now—browse the store.";
    chatPost({ channel: "#kernel", from: npc.display, body: intro });
    return;
  }
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
          "Line 1: read the primer -> `const primer = ctx.read('primer.dat') || ''`.",
      });
      chatPost({
        channel: dmChannel(npcId),
        from: "switchboard",
        body:
          "Line 2: pull the word/home -> `word=` and `home=` from the primer.",
      });
      chatPost({
        channel: dmChannel(npcId),
        from: "switchboard",
        body:
          "Line 3: pull payload -> find `payload=` and build `payload|HANDLE=<you>`.",
      });
      chatPost({
        channel: dmChannel(npcId),
        from: "switchboard",
        body:
          "Line 4: checksum -> `ctx.util.checksum(text)` then `ctx.util.hex3(sum)`.",
      });
      chatPost({
        channel: dmChannel(npcId),
        from: "switchboard",
        body: "Line 5: print KEY1, KEY2, KEY3, then the full phrase.",
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
          "Uploads are how you push your work back into the node you're connected to.",
      });
      chatPost({
        channel: dmChannel(npcId),
        from: "switchboard",
        body:
          "Flow: `drive ls` to find a file; connect the target loc; then `upload <src> <file>`. Track with `uploads`.",
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
      if (state.flags.has("q_juniper_mask_done")) {
        chatPost({
          channel: dmChannel(npcId),
          from: "juniper",
          body: "No contracts right now. Check the store. Keep your trace low.",
        });
        return;
      }
      if (state.flags.has("q_juniper_mask")) {
        chatPost({
          channel: dmChannel(npcId),
          from: "juniper",
          body:
            "Same contract. Pull `mask.dat` (download spoof.s; call kit.spoof). Then `turnin mask` at the exchange.",
        });
        return;
      }
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
        body: "Clean enough. +50GC. Tip: breach `archives.arc` once you've got the ember phrase.",
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
    if (msg.includes("scripts")) {
      chatPost({
        channel: dmChannel(npcId),
        from: "juniper",
        body: "Scripts are just habits you can repeat. `edit <name>` to write one, `call <you>.<name>` to run it.",
      });
      chatPost({
        channel: dmChannel(npcId),
        from: "juniper",
        body: "If you're new: `edit chk` and build it slow. If you're not: `edit chk --example`.",
      });
      return;
    }
    if (msg.includes("trace")) {
      chatPost({
        channel: dmChannel(npcId),
        from: "juniper",
        body: "TRACE climbs when you fail locks or push too hard. Let it cool, or `wait` between runs.",
      });
      chatPost({
        channel: dmChannel(npcId),
        from: "juniper",
        body: "Upgrades help: `upg.trace_spool` raises the limit; `upg.coolant` reduces current TRACE.",
      });
      return;
    }
    chatPost({
      channel: dmChannel(npcId),
      from: "juniper",
      body: state.flags.has("q_juniper_mask_done")
        ? "Ask about `locks`, `scripts`, or `trace`."
        : "Say `work` for a contract, or ask about `locks`, `scripts`, or `trace`.",
    });
    if (state.flags.has("q_juniper_mask_done")) {
      chatPost({
        channel: dmChannel(npcId),
        from: "juniper",
        body: "You already cashed the only job I had. Try the archive if you're hungry.",
      });
    }
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

function printOperatorBrief() {
  writeLine("OPERATOR BRIEF", "header");
  writeBlock(
    [
      "You're in a local drift simulation: a terminal, some nodes, and a security layer.",
      "Your job is to read, build tools, and breach gates without guessing.",
      "",
      "Core loop:",
      "  1) scan          (find signals / locations)",
      "  2) cat <file>    (read clues)",
      "  3) edit <name>   (write a helper script)",
      "  4) call <script> (run your tool)",
      "  5) breach <loc>  (solve lock prompts with what you earned)",
      "",
      "Scripts are JS-like. You'll see `ctx` + `args` and simple helpers like `ctx.util.checksum(...)`.",
      "",
      "Need help?",
      "  help             (alphabetical index)",
      "  help call        (examples)",
      "  help call ?      (args format)",
      "",
      "You can reopen this anytime with: tutorial intro",
    ].join("\n"),
    "dim"
  );
}

const HELP_DEFS = [
  {
    name: "breach",
    summary: "Start a lock-stack breach on a loc.",
    usage: ["breach <loc>"],
    examples: ["breach sable.gate", "unlock badge.sig", "wait"],
    notes: ["If you fail too often, TRACE kicks you back."],
  },
  {
    name: "call",
    aliases: ["run"],
    summary: "Run a script with args.",
    usage: ["call <script> [args]"],
    examples: ["call scripts.trust.accts.balance", "call kit.tracer", "call chk primer.dat"],
    argsDetails: [
      "Positional: `call some.script a b c` -> `args._ = [\"a\",\"b\",\"c\"]`",
      "Named: `call some.script key=value` -> `args.key = \"value\"`",
      "Quotes: `msg=\"hello world\"` (values are strings)",
    ],
  },
  {
    name: "cat",
    summary: "Read a file or view script source.",
    usage: ["cat <file|script|drive:loc/file>"],
    examples: ["cat primer.dat", "cat drive:sable.gate/cipher.txt", "cat kit.tracer", "cat <your_handle>.chk"],
  },
  {
    name: "channels",
    summary: "List chat channels you know.",
    usage: ["channels"],
    examples: ["channels", "join #ops", "switch #kernel"],
  },
  {
    name: "clear",
    summary: "Clear the terminal screen.",
    usage: ["clear"],
  },
  {
    name: "connect",
    summary: "Connect to a discovered loc.",
    usage: ["connect <loc> [--breach]"],
    examples: ["connect public.exchange", "connect sable.gate --breach"],
    notes: ["No-lock locs open automatically once requirements are met."],
  },
  {
    name: "contacts",
    summary: "List NPC contacts.",
    usage: ["contacts"],
    examples: ["contacts", "tell juniper hi"],
  },
  {
    name: "dc",
    aliases: ["disconnect"],
    summary: "Drop the link and route back to home.hub.",
    usage: ["dc", "disconnect"],
    notes: ["Cancels downloads; clears active breach pressure."],
  },
  {
    name: "decode",
    summary: "Decode rot13 or base64 (uses cached cipher if omitted).",
    usage: ["decode rot13|b64 [text]"],
    examples: ["cat cipher.txt", "decode rot13", "decode b64 U0lHSUw6IExBVFRJQ0U="],
  },
  {
    name: "del",
    summary: "Delete drive files or your local scripts.",
    usage: [
      "del drive:<loc>/<file> | del <loc>:<file> | del <loc>/<file> | del local/<file> | del <your_handle>.<script> --confirm",
    ],
    examples: [
      "del relay.uplink:patch.s",
      "del relay.uplink/patch.s",
      "del public.exchange/*.log",
      "del local/*.s",
      "del <your_handle>.chk --confirm",
    ],
  },
  {
    name: "diagnose",
    summary: "Show story progression status.",
    usage: ["diagnose"],
  },
  {
    name: "regions",
    summary: "List network regions, unlock cues, and member nodes.",
    usage: ["regions"],
    notes: ["Regions gate visibility, not mechanics; fulfill narrative cues to open them."],
  },
  {
    name: "download",
    summary: "Queue file downloads from the current loc.",
    usage: ["download <file|glob>"],
    examples: ["download tracer.s", "download *.s", "downloads"],
    argsDetails: [
      "`*` matches any run of characters; `?` matches one character.",
      "Globs only apply to `download` (not `cat`, not `breach`).",
    ],
    notes: ["Downloads take time; upgrades like upg.modem/backbone make them faster."],
  },
  {
    name: "downloads",
    summary: "Show download queue status.",
    usage: ["downloads"],
  },
  {
    name: "drive",
    summary: "Show your local drive contents and usage.",
    usage: ["drive", "drive ls", "drive flat"],
    examples: ["drive", "drive ls", "cat drive:sable.gate/cipher.txt"],
    notes: ["Drive is stored in browser localStorage; capacity is limited."],
  },
  {
    name: "folder",
    summary: "Manage local folder sync for scripts.",
    usage: ["folder pick|status|sync|mirror on|off|forget"],
    examples: ["folder pick", "folder sync", "folder mirror on"],
    notes: ["Chromium-only: requires https or localhost."],
  },
  {
    name: "edit",
    summary: "Edit a script or a drive text file.",
    usage: ["edit <scriptName> [--example|--from <ref>]", "edit drive:<loc>/<file>"],
    examples: ["edit chk --example", "edit chk", "edit drive:local/notes.txt"],
    notes: ["Editor cmds: :p, :d N, :r N <text>, :i N <text>, :a N <text>, :clear, :wq, :q"],
  },
  {
    name: "export",
    summary: "Export your save as JSON.",
    usage: ["export"],
  },
  {
    name: "history",
    summary: "Show recent locs/files and where they came from.",
    usage: ["history", "history clear"],
  },
  {
    name: "import",
    summary: "Import a save JSON (file picker or pasted JSON).",
    usage: ["import", "import <json>"],
  },
  {
    name: "install",
    summary: "Install an upgrade you bought/downloaded.",
    usage: ["install <upgradeId>"],
    examples: ["install upg.modem"],
  },
  {
    name: "inventory",
    summary: "List inventory items and installed upgrades.",
    usage: ["inventory"],
  },
  {
    name: "jobs",
    summary: "List active jobs/contracts.",
    usage: ["jobs"],
  },
  {
    name: "join",
    summary: "Join a chat channel (clears channel buffer).",
    usage: ["join #channel"],
    examples: ["join #kernel", "switch #ops"],
  },
  {
    name: "chat",
    summary: "Chat commands and behavior.",
    usage: ["say <text>", "join #channel", "tell <npc> <msg>", "chat box: /join #channel"],
    examples: ["say hello", "join #kernel", "tell juniper work", "chat box: /help"],
    notes: ["Only one channel is shown at a time; switching clears the buffer (DMs are preserved)."],
  },
  {
    name: "load",
    summary: "Load your saved game.",
    usage: ["load"],
  },
  {
    name: "ls",
    summary: "List files at the current loc (including uploads).",
    usage: ["ls"],
  },
  {
    name: "marks",
    summary: "Show marks/progress milestones.",
    usage: ["marks"],
  },
  {
    name: "probe",
    summary: "Probe a loc for basic info (trust).",
    usage: ["probe <loc>"],
  },
  {
    name: "reset",
    summary: "Delete your saved game from localStorage.",
    usage: ["reset --confirm"],
  },
  {
    name: "restart",
    summary: "Restart from scratch (deletes save).",
    usage: ["restart --confirm"],
  },
  {
    name: "save",
    summary: "Save now (autosave also runs).",
    usage: ["save"],
  },
  {
    name: "say",
    summary: "Post a message to the current chat channel.",
    usage: ["say <text>"],
  },
  {
    name: "scan",
    summary: "Scan for signals and list discovered locs (trust).",
    usage: ["scan"],
  },
  {
    name: "scripts",
    summary: "List available scripts (trust/kit/local).",
    usage: ["scripts"],
    examples: ["scripts", "call scripts.trust.get_level scripts.trust.scan"],
  },
  {
    name: "siphon",
    summary: "Risky passive GC income (requires upg.siphon).",
    usage: ["siphon", "siphon on|off", "siphon set low|med|high"],
  },
  {
    name: "store",
    summary: "Show the store (only at public.exchange).",
    usage: ["store"],
    examples: ["connect public.exchange", "store", "buy upg.modem", "install upg.modem"],
  },
  {
    name: "switch",
    summary: "Switch to a chat channel (acts like join).",
    usage: ["switch #channel"],
  },
  {
    name: "tell",
    summary: "DM an NPC (replies show inline).",
    usage: ["tell <npc> <msg>"],
    examples: ["tell switchboard hint", "tell juniper work"],
  },
  {
    name: "turnin",
    summary: "Turn in a job item when a contract asks for it.",
    usage: ["turnin <mask|token>"],
  },
  {
    name: "tutorial",
    summary: "Show tutorial guidance (and controls).",
    usage: ["tutorial", "tutorial intro", "tutorial on|off|reset"],
  },
  {
    name: "unlock",
    summary: "Answer the current breach lock prompt.",
    usage: ["unlock <answer>"],
  },
  {
    name: "upload",
    summary: "Upload a drive file or script into the current loc.",
    usage: ["upload <drive:loc/file|script> <destFile>"],
    examples: ["upload <your_handle>.patch patch.s", "upload drive:sable.gate/cipher.txt note.txt"],
    notes: ["Uploads only target your current connected loc."],
  },
  {
    name: "uploads",
    summary: "List uploaded files by loc.",
    usage: ["uploads"],
  },
  {
    name: "wait",
    summary: "Cool TRACE (spamming is punished).",
    usage: ["wait"],
  },
];

function helpResolve(topic) {
  const key = String(topic || "").trim().toLowerCase();
  if (!key) return null;
  const direct = HELP_DEFS.find((d) => d.name.toLowerCase() === key);
  if (direct) return direct;
  const alias = HELP_DEFS.find((d) => (d.aliases || []).some((a) => String(a).toLowerCase() === key));
  return alias || null;
}

function helpPrintIndex() {
  writeLine("HELP", "header");
  const defs = HELP_DEFS.slice().sort((a, b) => a.name.localeCompare(b.name));
  const pad = defs.reduce((m, d) => Math.max(m, String(d.name).length), 0);
  defs.forEach((d) => {
    const name = String(d.name).padEnd(pad, " ");
    writeLine(`${name}  ${d.summary}`, "dim");
  });
  writeLine("Type: `help <command>` for details.", "dim");
}

function helpPrintTopic(topic, wantsArgs) {
  const def = helpResolve(topic);
  if (!def) {
    writeLine("Unknown help topic.", "warn");
    writeLine("Tip: `help` to list commands.", "dim");
    return;
  }
  writeLine(`HELP ${def.name.toUpperCase()}`, "header");
  writeLine(def.summary, "dim");

  const aliases = (def.aliases || []).map(String).filter(Boolean);
  if (aliases.length) writeLine(`Aliases: ${aliases.join(", ")}`, "dim");

  const usage = (def.usage || []).map(String).filter(Boolean);
  if (usage.length) {
    writeLine("Usage:", "header");
    usage.forEach((u) => writeLine("  " + u, "dim"));
  }

  const examples = (def.examples || []).map(String).filter(Boolean);
  if (examples.length) {
    writeLine("Examples:", "header");
    examples.forEach((ex) => writeLine("  " + ex, "dim"));
  }

  if (wantsArgs && Array.isArray(def.argsDetails) && def.argsDetails.length) {
    writeLine("Args:", "header");
    def.argsDetails.forEach((ln) => writeLine("  " + ln, "dim"));
  } else if (Array.isArray(def.argsDetails) && def.argsDetails.length) {
    writeLine("Tip: `help " + def.name + " ?` for args details.", "dim");
  }

  const notes = (def.notes || []).map(String).filter(Boolean);
  if (notes.length) {
    writeLine("Notes:", "header");
    notes.forEach((n) => writeLine("  " + n, "dim"));
  }
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
  discovered: new Set(["home.hub", "training.node", "public.exchange", "sable.gate", "island.grid", "trust.anchor"]),
  unlocked: new Set(["home.hub", "public.exchange", "island.grid", "trust.anchor"]),
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
  recent: { locs: [], files: [] },
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
  localSync: {
    mirror: false,
  },
  npcs: {
    known: new Set(["switchboard"]),
  },
  downloads: {
    active: null,
    queue: [],
  },
  trust: { level: 2, heat: 0, lastScanAt: 0 },
  region: { current: null, unlocked: new Set(), visited: new Set(), pending: new Set() },
  currentRegion: null,
  narrativeHint: null,
  glitchChant: null,
  storyState: {
    current: "island_intro",
    completed: new Set(),
    beats: new Set(),
    flags: new Set(),
    failed: new Set(),
  },
  rogueProfile: { noise: 0, careful: 0, brute: 0, failures: 0, outcomes: new Set() },
  behaviorProfile: { noise: 0, careful: 0, aggressive: 0, patient: 0 },
  watcherProfile: null,
};

// RegionManager tracks named network zones (regions), which nodes they contain,
// and the player's narrative progression between them. It does not change core mechanics;
// it layers story/state on top of existing loc discovery/locks and provides hooks for future puzzles.
RegionManager = (() => {
  const regionById = new Map(REGION_DEFS.map((def) => [def.id, def]));
  const nodeIndex = new Map();
  REGION_DEFS.forEach((def) => def.nodes.forEach((node) => nodeIndex.set(node, def.id)));

  function ensureState() {
    if (!state.region || typeof state.region !== "object") {
      state.region = { current: null, unlocked: new Set(), visited: new Set(), pending: new Set() };
    }
    if (!(state.region.unlocked instanceof Set)) state.region.unlocked = new Set(state.region.unlocked || []);
    if (!(state.region.visited instanceof Set)) state.region.visited = new Set(state.region.visited || []);
    if (!(state.region.pending instanceof Set)) state.region.pending = new Set(state.region.pending || []);
  }

  function getDef(regionId) {
    return regionById.get(regionId) || null;
  }

  function regionForNode(node) {
    return nodeIndex.get(node) || null;
  }

  function unlockRequirementsMet(def) {
    const unlock = def.unlock || {};
    const requires = Array.isArray(unlock.requires) ? unlock.requires : [];
    const nodes = Array.isArray(unlock.nodes) ? unlock.nodes : [];
    const flags = Array.isArray(unlock.flags) ? unlock.flags : [];
    const flagsAny = Array.isArray(unlock.flagsAny) ? unlock.flagsAny : [];
    const regionsOk = requires.every((id) => state.region.unlocked.has(id));
    const nodesOk = !nodes.length || nodes.some((node) => state.unlocked.has(node) || state.discovered.has(node));
    const flagsOk = flags.every((flag) => state.flags.has(flag));
    const flagsAnyOk = !flagsAny.length || flagsAny.some((flag) => state.flags.has(flag));
    const storyOk = narrativeAllowsRegion(def.id);
    return regionsOk && nodesOk && flagsOk && flagsAnyOk && storyOk;
  }

  // Ensure older saves auto-unlock regions whose nodes are already known/unlocked.
  function legacyUnlock(def) {
    return (
      state.flags.has("region_legacy_backfill") &&
      def.nodes.some((node) => state.unlocked.has(node) || state.discovered.has(node))
    );
  }

  function unlockRegion(regionId, { silent } = {}) {
    ensureState();
    if (state.region.unlocked.has(regionId)) return false;
    const def = getDef(regionId);
    if (!def) return false;
    if (!unlockRequirementsMet(def) && !legacyUnlock(def)) return false;
    state.region.unlocked.add(regionId);
    def.nodes.forEach((node) => state.region.pending.delete(node));
    // Auto-discover any nodes that were held back while the region was locked.
    def.nodes.forEach((node) => {
      if (!state.discovered.has(node)) state.discovered.add(node);
    });
    markDirty();
    if (!silent) {
      const whisper = `route shift: ${def.name} begins to answer (${def.nodes.length} hosts listening)`;
      chatPost({
        channel: "#kernel",
        from: "switchboard",
        body: whisper,
      });
    }
    return true;
  }

  function syncUnlocks({ silent } = {}) {
    ensureState();
    REGION_DEFS.forEach((def) => {
      if (def.unlock && def.unlock.requires && def.unlock.requires.length === 0 && def.unlock.flags?.length === 0) {
        unlockRegion(def.id, { silent: true });
      }
      unlockRegion(def.id, { silent });
    });
  }

  function bootstrap({ silent } = {}) {
    ensureState();
    syncUnlocks({ silent });
    if (!state.region.current && state.region.unlocked.size) {
      state.region.current = Array.from(state.region.unlocked)[0];
    }
  }

  function noteDiscovery(node) {
    ensureState();
    const regionId = regionForNode(node);
    if (!regionId) return;
    if (!state.region.unlocked.has(regionId)) {
      state.region.pending.add(node);
      return;
    }
  }

  function isNodeVisible(node) {
    const regionId = regionForNode(node);
    if (!regionId) return true;
    ensureState();
    return state.region.unlocked.has(regionId);
  }

  function canAccessNode(node) {
    const regionId = regionForNode(node);
    if (!regionId) return { ok: true };
    ensureState();
    if (state.region.unlocked.has(regionId)) return { ok: true };
    const def = getDef(regionId);
    const unlock = def && def.unlock ? def.unlock : {};
    const needs = [];
    const requires = Array.isArray(unlock.requires) ? unlock.requires : [];
    const nodes = Array.isArray(unlock.nodes) ? unlock.nodes : [];
    const flags = Array.isArray(unlock.flags) ? unlock.flags : [];
    const flagsAny = Array.isArray(unlock.flagsAny) ? unlock.flagsAny : [];
    if (requires.length) needs.push("regions: " + requires.join(", "));
    if (flags.length) needs.push("signals: " + flags.join(", "));
    if (flagsAny.length) needs.push("any signal: " + flagsAny.join(", "));
    if (nodes.length) needs.push("story nodes: " + nodes.join(", "));
    return {
      ok: false,
      regionId,
      hint: needs.length ? needs.join(" | ") : "route sealed",
      name: def ? def.name : regionId,
    };
  }

  function emitRegionEntry(regionId) {
    ensureState();
    const def = getDef(regionId);
    if (!def || state.region.visited.has(regionId)) return;
    state.region.visited.add(regionId);
    const lines = Array.isArray(def.entry) ? def.entry : [String(def.entry || def.name)];
    lines.forEach((line) =>
      chatPost({
        channel: "#kernel",
        from: "sys",
        body: `[region:${def.id}] ${line}`,
      })
    );
    onRegionEnter(def);
    markDirty();
  }

  function enterRegionByNode(node) {
    ensureState();
    const regionId = regionForNode(node);
    if (!regionId) return;
    if (!state.region.unlocked.has(regionId)) {
      // Enter attempts can still unlock the region if conditions were just met.
      if (!unlockRegion(regionId, { silent: false })) return;
    }
    state.region.current = regionId;
    state.currentRegion = regionId;
    emitRegionEntry(regionId);
  }

  function describeRegions() {
    ensureState();
    writeLine("REGIONS", "header");
    REGION_DEFS.forEach((def) => {
      const open = state.region.unlocked.has(def.id);
      const visit = state.region.visited.has(def.id) ? "visited" : "unvisited";
      const label = open ? "[listening]" : "[silent]";
      writeLine(`${label} ${def.name} (${visit})`, open ? "ok" : "dim");
      writeLine("  nodes: " + def.nodes.join(", "), "dim");
      if (!state.region.unlocked.has(def.id)) {
        const hint = "routing noise masks this span; follow prior signals";
        writeLine("  hint: " + hint, "dim");
      }
    });
  }

  return {
    ensureState,
    syncUnlocks,
    bootstrap,
    regionForNode,
    isRegionUnlocked: (regionId) => state.region && state.region.unlocked instanceof Set && state.region.unlocked.has(regionId),
    isNodeVisible,
    canAccessNode,
    enterRegionByNode,
    noteDiscovery,
    describeRegions,
  };
})();

// Stub hook for future puzzle injections when a region is first entered.
function onRegionEnter(region) {
  // Example extension:
  // if (region.id === "corporateNet") chatPost({ channel: "#kernel", from: "sys", body: "Audit eyes open." });
  // Keep side effects minimal to avoid altering base mechanics.
  return region;
}

// Initialize region progression at boot so regions with no requirements open immediately.
RegionManager.bootstrap({ silent: true });

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
    links: ["training.node", "public.exchange", "sable.gate", "island.grid", "trust.anchor"],
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
          "",
          "New operators: read `script.intro` for a plain-language scripting primer.",
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
          "word=" + TRAINING_WORD,
          "home=" + TRAINING_HOME,
          "payload=" + PRIMER_PAYLOAD,
          "",
          "Key 1: <your_handle>",
          "Key 2: word (from this file)",
          "Key 3: checksum(payload|HANDLE=<your_handle>) -> hex3",
          "Final: <handle> <word> <home> <key3>",
        ].join("\n"),
      },
      "script.intro": {
        type: "text",
        content: [
          "SCRIPT.INTRO",
          "A no-code intro to scripts (tiny JavaScript helpers).",
          "",
          "Why scripts?",
          "- They repeat your steps exactly.",
          "- They cut typos out of lock answers.",
          "- They let you scale from one task to many.",
          "",
          "You will build one script in 3 small steps.",
          "Each step prints a key. Keep prior lines as you go.",
          "The final line prints the full phrase.",
          "",
          "How to start:",
          "- If you're new to coding: type `edit chk` and follow the steps below.",
          "- If you already code: type `edit chk --example` to skip ahead.",
          "",
          "Security tags (optional):",
          "  // @sec FULLSEC  (FULLSEC > HIGHSEC > MIDSEC > LOWSEC > NULLSEC)",
          "Higher sec can call lower sec; lower sec cannot call higher.",
          "",
          "* Step 1: print your handle (KEY1).",
          "  const handle = ctx.handle();",
          "  ctx.print(handle);",
          "Why: your handle makes every answer unique to you.",
          "",
          "* Step 2: read the primer and print the word (KEY2).",
          "  const primer = ctx.read('primer.dat') || '';",
          "  const word = (primer.match(/^word=(.*)$/m) || [])[1] || 'WELCOME';",
          "  ctx.print(String(word).trim());",
          "Why: reading files is how you get lock hints.",
          "",
          "* Step 3: compute the checksum (KEY3).",
          "  const payload = (primer.match(/^payload=(.*)$/m) || [])[1] || '';",
          "  const text = payload.trim() + '|HANDLE=' + handle;",
          "  const sum = ctx.util.checksum(text);",
          "  const key3 = ctx.util.hex3(sum);",
          "  ctx.print(key3);",
          "Why: the lock wants a computed answer, not a guess.",
          "",
          "* Final phrase (print it to unlock the last lock):",
          "  const home = (primer.match(/^home=(.*)$/m) || [])[1] || 'HOME';",
          "  ctx.print(handle + ' ' + word.trim() + ' ' + home.trim() + ' ' + key3);",
          "",
          "Run after each step: `call <you>.chk`",
          "Fast path: `edit chk --example`, then `:wq`.",
        ].join("\n"),
      },
      "chk.example": {
        type: "text",
        content: [
          "CHK.EXAMPLE",
          "Paste this into `edit chk` and save with `:wq`.",
          "",
          "const primer = ctx.read('primer.dat') || '';",
          "const word = (primer.match(/^word=(.*)$/m) || [])[1] || 'WELCOME';",
          "const home = (primer.match(/^home=(.*)$/m) || [])[1] || 'HOME';",
          "const payload = (primer.match(/^payload=(.*)$/m) || [])[1] || '';",
          "if (!payload) { ctx.print('no payload'); return; }",
          "const handle = ctx.handle();",
          "const text = payload.trim() + '|HANDLE=' + handle;",
          "const sum = ctx.util.checksum(text);",
          "const key3 = ctx.util.hex3(sum);",
          "ctx.print(handle);",
          "ctx.print(String(word).trim());",
          "ctx.print(key3);",
          "ctx.print(handle + ' ' + String(word).trim() + ' ' + String(home).trim() + ' ' + key3);",
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
  "island.grid": {
    title: "ISLAND.GRID",
    desc: [
      "A sealed training lattice with curated signals.",
      "Switchboard routes pings here before you meet the wider Drift.",
    ],
    requirements: {},
    locks: [],
    links: ["home.hub", "training.node", "island.echo"],
    files: {
      "grid.map": {
        type: "text",
        content: [
          "ISLAND GRID",
          "This pocket net is a soft launch. Scan, cat, and build your first helper script before the bigger mesh answers.",
          "",
          "Route:",
          "  1) scan                 (discover) ",
          "  2) cat primer.dat       (read clues)",
          "  3) edit chk --example   (save script)",
          "  4) call <you>.chk       (print keys)",
          "  5) breach training.node (solve locks)",
          "",
          "Optional: island.echo unlocks after you clear training.node.",
        ].join("\n"),
      },
      "grid.jobs": {
        type: "text",
        content: [
          "GRID JOB BOARD",
          "Switchboard: \"Prove you can read without guessing.\"",
          "Archivist:  \"Checksum is a mood. Learn it.\"",
          "Weaver:     \"Our marks need people who finish things.\"",
        ].join("\n"),
      },
    },
  },
  "island.echo": {
    title: "ISLAND.ECHO",
    desc: [
      "A narrow repeater that only boots after you clear the lab locks.",
      "The net thanks you in static, then teaches you how to listen.",
    ],
    requirements: { flags: ["tutorial_training_done"] },
    locks: [],
    links: ["island.grid", "home.hub"],
    files: {
      "echo.log": {
        type: "text",
        content: [
          "ISLAND ECHO",
          "The Drift whispers back when you answer honestly.",
          "",
          "Notes:",
          "- Trust is heat. Breach carefully to keep routes open.",
          "- Wait cools heat. trust.anchor cools faster.",
          "- Glitched fragments will start appearing once you leave the island.",
        ].join("\n"),
      },
      "fragment.alpha": {
        type: "text",
        content: [
          "FRAGMENT.ALPHA",
          "Signal clue: FRACTURE",
          "The Drift cracked here first. Replace the missing glyphs when you decode other fragments.",
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
        prompt: "LOCK: provide handle (KEY1)",
        answer: () => trainingKey1(),
        hint: "Key 1 is your handle. Script: ctx.print(ctx.handle()).",
      },
      {
        prompt: "LOCK: provide word (KEY2)",
        answer: () => trainingKey2(),
        hint: "Key 2 is the word in primer.dat (word=...).",
      },
      {
        prompt: "LOCK: provide checksum (KEY3, hex3)",
        answer: () => trainingKey3(),
        hint: "Key 3 is hex3(checksum(payload|HANDLE=<your_handle>)).",
      },
      {
        prompt: "LOCK: provide full phrase (KEY1 KEY2 HOME KEY3)",
        answer: () => trainingPhrase(),
        hint: "Combine keys: <handle> <word> <home> <key3>.",
      },
    ],
    links: ["home.hub", "island.grid"],
    files: {
      "lab.log": {
        type: "text",
        content: [
          "LAB LOG",
          "If you cleared this, you're ready to leave the lab.",
          "Next: connect public.exchange, pull tools, breach gates.",
          "",
          "You just solved three keys, then the full phrase:",
          "  <handle> WELCOME HOME <hex3>",
          "Keep that habit: small keys combine into a single answer.",
          "",
          "Tip: write helper scripts.",
          "",
          "Example outline (NOT literal code):",
          "  - read primer.dat",
          "  - print handle (KEY1)",
          "  - print word (KEY2)",
          "  - checksum -> print KEY3",
          "  - print final phrase",
          "",
          "Fast path: `edit chk --example` then `:wq`.",
          "Or: `cat chk.example` and paste ONLY the code into `edit chk`.",
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
             "if (ctx.flagged('trace_open')) { ctx.print('Tracer already mapped the edge.'); return; }",
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
      "upg.coolant": {
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
  "trust.anchor": {
    title: "TRUST.ANCHOR",
    desc: [
      "A quiet maintenance anchor Switchboard wired into the simulation.",
      "Heat bleeds off the longer you stay, and logs update while you wait.",
    ],
    requirements: {},
    locks: [],
    links: ["home.hub", "public.exchange"],
    files: {
      "anchor.log": {
        type: "text",
        content: [
          "TRUST ANCHOR",
          "Rapid scans and failed locks raise heat. Too much heat drops trust levels and triggers lockouts.",
          "",
          "Cool paths:",
          "- wait          (slow cool: trace + trust)",
          "- visit here    (reading this cools heat)",
          "- install coolant upgrades for trace",
          "",
          "Trust gates some locs. Keep it steady if you want deeper routes.",
        ].join("\n"),
      },
      "anchor.brief": {
        type: "text",
        content: [
          "NARRATIVE STEP :: trust_pressure",
          "A reminder: every security layer is a story about paranoia.",
          "Balance heat with patience; anchor before you breach again.",
        ].join("\n"),
      },
    },
  },
  "deep.slate": {
    title: "DEEP.SLATE",
    desc: [
      "A slate of old relays stacked under the archive.",
      "Signals smear here; patience and trust keep them readable.",
    ],
    requirements: { flags: ["trace_open", "lattice_sigil"], trust: 2 },
    locks: [
      {
        prompt: "LOCK: recite the lattice sigil",
        answer: "SIGIL: LATTICE",
        hint: "Decode key.b64 in the archive.",
      },
    ],
    links: ["lattice.cache", "trench.node"],
    files: {
      "slate.log": {
        type: "text",
        content: [
          "DEEP SLATE",
          "The archive warned you about depth. This slate is the descent.",
          "",
          "Need:",
          "- Trust level 2+ (cool heat first)",
          "- Lattice sigil (still applies down here)",
          "- Patience: read everything, compute everything",
          "",
          "Run phase.s to pull a trench key. Expect checksum locks ahead.",
        ].join("\n"),
      },
      "slate.b64": { type: "text", cipher: true, content: "TUFORE0MRQ==" },
      "phase.s": {
        type: "script",
        script: {
          name: "phase",
          sec: "MIDSEC",
          code: [
            "// @sec MIDSEC",
            "if (ctx.hasItem('trench.key')) { ctx.print('Trench key already generated.'); return; }",
            "const payload = ctx.read('trench.dat') || '';",
            "const handle = ctx.handle();",
            "if (!payload) { ctx.print('No payload (need trench.dat).'); return; }",
            "const text = payload.trim() + '|HANDLE=' + handle;",
            "const sum = ctx.util.checksum(text);",
            "ctx.addItem('trench.key');",
            "ctx.flag('deep_signal');",
            "ctx.print('Trench key minted.');",
            "ctx.print('phase checksum: ' + ctx.util.hex3(sum));",
          ].join("\n"),
        },
        content: [
          "/* phase.s */",
          "function main(ctx,args){",
          "  // Mint a trench.key and preview the checksum path forward.",
          "}",
        ].join("\n"),
      },
      "trench.dat": {
        type: "text",
        content: [
          "TRENCH.DAT",
          "payload=" + CINDER_PAYLOAD,
          "text = payload + '|HANDLE=<your_handle>'",
          "expected = hex3(checksum(text))",
        ].join("\n"),
      },
    },
  },
  "trench.node": {
    title: "TRENCH.NODE",
    desc: [
      "A cooled trench lined with audit mirrors.",
      "The locks here demand sigils, phrases, and clean math.",
    ],
    requirements: { items: ["trench.key"], trust: 2 },
    locks: [
      {
        prompt: "LOCK: weave phrase required",
        answer: "THREAD THE DRIFT",
        hint: "Run sniffer.s; keep the phrase handy.",
      },
      {
        prompt: "LOCK: checksum payload (hex3)",
        answer: () => expectedForChecksumPayload(CINDER_PAYLOAD),
        hint: "Use trench.dat or run phase.s for the checksum math.",
      },
    ],
    links: ["deep.slate", "cinder.core"],
    files: {
      "trench.log": {
        type: "text",
        content: [
          "TRENCH LOG",
          "The slate opens the trench. The trench opens the core.",
          "",
          "Locks:",
          "- Weave phrase (from sniffer.s)",
          "- Checksum from trench.dat (hex3)",
          "",
          "Reward: a cinder mote, needed for the depth token.",
        ].join("\n"),
      },
      "mantle.rot13": { type: "text", cipher: true, content: "ZNAGYR" },
      "cinder.mote": {
        type: "item",
        item: "cinder.mote",
        content: ["CINDER.MOTE", "A fragment of cooled ember light."].join("\n"),
      },
      "mix.s": {
        type: "script",
        script: {
          name: "mix",
          sec: "HIGHSEC",
          code: [
            "// @sec HIGHSEC",
            "const need = ['cinder.mote','relic.key','relay.shard'].filter((x) => !ctx.hasItem(x));",
            "if (need.length) { ctx.print('Missing: ' + need.join(', ')); return; }",
            "if (ctx.hasItem('cinder.token')) { ctx.print('Cinder token already forged.'); return; }",
            "ctx.addItem('cinder.token');",
            "ctx.print('Forged: cinder.token');",
          ].join("\n"),
        },
        content: [
          "/* mix.s */",
          "function main(ctx,args){",
          "  // Combine trench rewards + relic gear into a depth token.",
          "}",
        ].join("\n"),
      },
    },
  },
  "cinder.core": {
    title: "CINDER.CORE",
    desc: [
      "A cooled remnant of the rogue process, nested below the relic.",
      "This core accepts chants, sigils, and proof you kept trust steady.",
    ],
    requirements: { items: ["cinder.token"], flags: ["glitch_phrase_ready"], trust: 3 },
    locks: [
      {
        prompt: "CINDER: checksum(payload|HANDLE=<you>) (hex3)",
        answer: () => expectedForChecksumPayload(CINDER_PAYLOAD),
        hint: "Compute from trench.dat or phase.s output.",
      },
      {
        prompt: "CINDER: repaired chant",
        answer: "MIRROR THE EMBER STILL THREAD",
        hint: "Run stitch.s after fixing fragments.",
      },
      {
        prompt: "CINDER: mantle word",
        answer: "MANTLE",
        hint: "Decode mantle.rot13 or slate.b64.",
      },
    ],
    links: ["trench.node", "core.relic"],
    files: {
      "cinder.log": {
        type: "text",
        content: [
          "CINDER CORE",
          "The trench minted a mote; the relic gave you leverage. Put them together.",
          "",
          "This is optional endgame. Rewards are bragging rights + heat control.",
        ].join("\n"),
      },
      "upg.coolant": {
        type: "upgrade",
        item: "upg.coolant",
        content: [
          "UPGRADE: COOLANT+",
          "A tuned coolant line. Install to reduce trace by 2 and cool heat a bit.",
        ].join("\n"),
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
    links: ["archives.arc", "core.relic", "glitch.cache", "deep.slate"],
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
    links: ["lattice.cache", "rogue.core", "glitch.cache", "cinder.core"],
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
      "upg.coolant": {
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
      "upg.trace_spool": {
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
        // Intentionally corrupted: the block character represents a "missing" letter in the signal.
        content: `gur qevsg qbrfa'g gel gb oernx lbh. vg g${GLITCH_GLYPH}ebjf lbh.`,
      },
    },
  },
  "glitch.cache": {
    title: "GLITCH.CACHE",
    desc: [
      "A cache of corrupted text frames stitched together by the Weavers.",
      "Every file has holes. Your job is to repair the chant.",
    ],
    requirements: { flags: ["slipper_signal"], items: ["weaver.mark"], trust: 2 },
    locks: [
      {
        prompt: "LOCK: present weaver.mark",
        answer: "weaver.mark",
        hint: "Download weaver.mark from weaver.den.",
      },
    ],
    links: ["slipper.hole", "core.relic"],
    files: {
      "glitch.map": {
        type: "text",
        content: [
          "GLITCH MAP",
          "Fragments to gather:",
          "- fragment.alpha (island.echo)",
          "- fragment.beta   (cache)",
          "- fragment.gamma  (cache)",
          "- fragment.delta  (cache)",
          "",
          "Each fragment hides a word. Replace missing glyphs (█) with the obvious letter after decoding.",
          "The final chant opens the rogue core.",
        ].join("\n"),
      },
      "fragment.beta": {
        type: "text",
        cipher: true,
        content: `ZVE${GLITCH_GLYPH}BE`,
      },
      "fragment.gamma": {
        type: "text",
        cipher: true,
        content: `RZO${GLITCH_GLYPH}E`,
      },
      "fragment.delta": {
        type: "text",
        cipher: true,
        content: `FGV${GLITCH_GLYPH}Y`,
      },
      "chant.txt": {
        type: "text",
        content: [
          "GLITCH CHANT (BROKEN)",
          "??? THE EMBER STILL THREAD",
          "",
          "Fill the missing word by repairing the fragments.",
        ].join("\n"),
      },
      "stitch.s": {
        type: "script",
        script: {
          name: "stitch",
          sec: "MIDSEC",
          code: [
            "// @sec MIDSEC",
            "const frags = ['fragment.alpha','fragment.beta','fragment.gamma','fragment.delta'];",
            "const words = frags.map((f) => (ctx.read(f) || '').toUpperCase());",
            "const repaired = words.map((w) => w.replace(/█/g, '?').replace(/\\s+/g, '').replace(/[^A-Z?]/g,''));",
            "const chant = `${repaired[1] || '???'} THE ${repaired[2] || 'EMBER'} ${repaired[3] || 'STILL'} THREAD`;",
            "ctx.print('Fragments: ' + repaired.join(' / '));",
            "ctx.print('Chant: ' + chant.trim());",
            "if (!chant.includes('?')) {",
            "  ctx.flag('glitch_phrase_ready');",
            "  ctx.print('Chant locked. Rogue core will listen.');",
            "} else {",
            "  ctx.print('Fill missing glyphs in your fragment files to finalize the chant.', 'warn');",
            "}",
          ].join("\n"),
        },
        content: [
          "/* stitch.s */",
          "function main(ctx,args){",
          "  // Read fragment.* files from your drive and reconstruct the chant.",
          "}",
        ].join("\n"),
      },
    },
  },
  "rogue.core": {
    title: "ROGUE.CORE",
    desc: [
      "A rogue AI kernel adapted from the relic. It mirrors your handle back at you.",
      "Locks adapt to your trust level and your ability to repair glitches.",
    ],
    requirements: { flags: ["touched_relic", "glitch_phrase_ready", "forked"], items: ["relay.shard", "relic.key"], trust: 3 },
    locks: [
      {
        prompt: "ROGUE: checksum(payload|HANDLE=<you>) (hex3)",
        answer: () => expectedForChecksumPayload(ROGUE_PAYLOAD),
        hint: "Read rogue.seed. Compute checksum like the primer.",
      },
      {
        prompt: "ROGUE: repaired chant",
        answer: "MIRROR THE EMBER STILL THREAD",
        hint: "Collect and repair fragments in glitch.cache.",
      },
      {
        prompt: "ROGUE: confirm trust tier (LEVEL3)",
        answer: "LEVEL3",
        hint: "Keep trust steady. Wait or anchor if heat spikes.",
      },
    ],
    links: ["core.relic"],
    files: {
      "rogue.seed": {
        type: "text",
        content: [
          "ROGUE SEED",
          "payload=" + ROGUE_PAYLOAD,
          "Expected: checksum(payload|HANDLE=<you>) -> hex3",
          "The rogue mirrors you. Keep trust at level 3+ or it ignores you.",
        ].join("\n"),
      },
      "rogue.log": {
        type: "text",
        content: [
          "ROGUE CORE",
          "Phase 1: checksums keep it honest.",
          "Phase 2: chants remind it of the Drift.",
          "Phase 3: trust proves you belong here.",
          "",
          "Fail any phase and trace spikes hard.",
        ].join("\n"),
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
    RegionManager.noteDiscovery(loc);
    const regionId = RegionManager.regionForNode(loc);
    const regionLocked = regionId && !RegionManager.isRegionUnlocked(regionId);
    if (!state.discovered.has(loc) && !regionLocked) {
      state.discovered.add(loc);
      newly.push(loc);
    }
  });
  RegionManager.bootstrap({ silent: true });
  if (state.region && state.region.current && !state.currentRegion) {
    state.currentRegion = state.region.current;
  }
  return newly;
}

function requirementsMet(locName) {
  const loc = getLoc(locName);
  if (!loc) return false;
  const req = loc.requirements || {};
  const flags = Array.isArray(req.flags) ? req.flags : [];
  const items = Array.isArray(req.items) ? req.items : [];
  const okFlags = flags.every((f) => state.flags.has(String(f)));
  const okItems = items.every((i) => state.inventory.has(String(i)));
  const needTrust = Number(req.trust) || 0;
  const okTrust = !needTrust || trustGate(needTrust);
  return okFlags && okItems && okTrust;
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
      if (!RegionManager.isNodeVisible(locName)) return;
      const node = getLoc(locName);
      const unlocked = state.unlocked.has(locName) ? "listening" : "silent";
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
  trackRecentLoc(state.loc);
}

function listFiles() {
  const loc = getLoc(state.loc);
  const base = Object.keys(loc.files || {});
  const uploaded =
    state.uploads && state.uploads[state.loc] && state.uploads[state.loc].files
      ? Object.keys(state.uploads[state.loc].files)
      : [];

  const names = Array.from(new Set([...base, ...uploaded])).sort((a, b) => a.localeCompare(b));
  if (!names.length) {
    writeLine("No files.", "dim");
    return;
  }
  names.forEach((name) => {
    const entry = (loc.files || {})[name];
    const up = state.uploads && state.uploads[state.loc] && state.uploads[state.loc].files
      ? state.uploads[state.loc].files[name]
      : null;

    if (entry && up) {
      const tag = up && up.kind ? String(up.kind) : "file";
      const edited = up && up.edited ? " edited" : "";
      writeLine(`${name} (${entry.type} + uploaded:${tag}${edited})`, "dim");
      return;
    }
    if (entry) {
      writeLine(`${name} (${entry.type})`, "dim");
      return;
    }
    if (up) {
      const tag = up && up.kind ? String(up.kind) : "file";
      const edited = up && up.edited ? " edited" : "";
      writeLine(`${name} (uploaded:${tag}${edited})`, "dim");
      return;
    }
    writeLine(`${name} (file)`, "dim");
  });
}

const STORE_ITEMS = [
  {
    id: "upg.drive_ext",
    price: 80,
    when: () => true,
    desc: "Drive expansion (more space for downloaded files).",
  },
  {
    id: "upg.drive_array",
    price: 380,
    when: () => state.unlocked.has("archives.arc"),
    desc: "Large drive expansion (for heavy ops).",
  },
  {
    id: "upg.modem",
    price: 140,
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

const RECENT_MAX = 40;
function ensureRecentState() {
  if (!state.recent || typeof state.recent !== "object") state.recent = { locs: [], files: [] };
  if (!Array.isArray(state.recent.locs)) state.recent.locs = [];
  if (!Array.isArray(state.recent.files)) state.recent.files = [];
}

function pushRecent(list, value) {
  const v = String(value || "").trim();
  if (!v) return;
  const lower = v.toLowerCase();
  const idx = list.findIndex((e) => e && String(e.v || "").toLowerCase() === lower);
  if (idx !== -1) list.splice(idx, 1);
  list.unshift({ t: Date.now(), v });
  if (list.length > RECENT_MAX) list.length = RECENT_MAX;
}

function trackRecentLoc(locName) {
  ensureRecentState();
  pushRecent(state.recent.locs, String(locName || "").trim());
}

function trackRecentFile(fileRef) {
  ensureRecentState();
  pushRecent(state.recent.files, String(fileRef || "").trim());
}

function driveBytesForContent(content) {
  return new TextEncoder().encode(String(content || "")).length;
}

function driveId(locName, fileName) {
  return `${locName}/${fileName}`;
}

function driveRef(id) {
  return `drive:${id}`;
}

function formatBytesShort(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

function driveTreeLine(prefix, name, suffix) {
  const left = `${prefix}${name}`;
  if (!suffix) return left;
  return `${left}  ${suffix}`;
}

function fileBaseName(path) {
  const raw = String(path || "");
  const idx = raw.lastIndexOf("/");
  return idx === -1 ? raw : raw.slice(idx + 1);
}

function getDriveEntry(ref) {
  const key = String(ref || "")
    .trim()
    .replace(/^drive:/i, "");
  if (!key) return null;
  const drive = state.drive || {};
  if (drive[key]) return { id: key, ...drive[key] };
  // Case-insensitive fallback.
  const lower = key.toLowerCase();
  const found = Object.keys(drive).find((k) => k.toLowerCase() === lower);
  if (!found) return null;
  return { id: found, ...drive[found] };
}

function listDriveFilesFlat() {
  writeLine("DRIVE // FLAT", "header");
  const keys = Object.keys(state.drive || {}).sort();
  if (!keys.length) {
    writeLine("(empty)", "dim");
    writeLine("Tip: `download cipher.txt` then `cat drive:sable.gate/cipher.txt`", "dim");
    return;
  }
  writeLine(`capacity: ${driveBytesUsed()}/${state.driveMax} bytes`, "dim");
  keys.slice(0, 80).forEach((k) => {
    const e = state.drive[k];
    const bytes = driveBytesForContent((e && e.content) || "");
    const type = e && e.type ? String(e.type) : "file";
    writeLine(`${driveRef(k)}  (${type}, ${formatBytesShort(bytes)})`, "dim");
  });
  if (keys.length > 80) writeLine("...", "dim");
}

function driveTree(options) {
  const opts = options || {};
  const expanded = !!opts.expanded;
  const showRefs = !!opts.showRefs;
  const perTypeLimit = expanded ? 50 : 14;

  const keys = Object.keys(state.drive || {});
  const used = driveBytesUsed();
  const max = Number(state.driveMax) || 0;
  const pct = max > 0 ? Math.min(999, Math.floor((used / max) * 100)) : 0;

  writeLine(expanded ? "DRIVE // LS" : "DRIVE", "header");
  writeLine(`usage: ${used}/${max} bytes (${pct}%)`, "dim");
  writeLine("drive:/  (local)", "dim");

  if (!keys.length) {
    writeLine("|-- (empty)", "dim");
    writeLine("Tip: `download cipher.txt` then `cat drive:sable.gate/cipher.txt`", "dim");
    return;
  }

  const byType = new Map(); // type -> [{ id, file, bytes }]
  keys.forEach((id) => {
    const file = fileBaseName(id) || "unknown";
    const e = state.drive[id];
    const type = e && e.type ? String(e.type) : "file";
    const bytes = driveBytesForContent((e && e.content) || "");
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push({ id, file, bytes });
  });

  const typeOrder = ["script", "text", "item", "upgrade", "file"];

  const types = Array.from(byType.keys()).sort((a, b) => {
    const ia = typeOrder.indexOf(a);
    const ib = typeOrder.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    return a.localeCompare(b);
  });

  types.forEach((t, idx) => {
    const lastType = idx === types.length - 1;
    const typePrefix = lastType ? "`-- " : "|-- ";
    const label =
      t === "script"
        ? "Scripts"
        : t === "text"
          ? "Text"
          : t === "item"
            ? "Items"
            : t === "upgrade"
              ? "Upgrades"
              : "Files";

    const list = byType.get(t).slice();
    const count = list.length;
    const totalBytes = list.reduce((acc, x) => acc + x.bytes, 0);
    writeLine(driveTreeLine(typePrefix, `${label}/`, `(${count}, ${formatBytesShort(totalBytes)})`), "dim");

    const nameCounts = new Map();
    list.forEach((x) => nameCounts.set(x.file.toLowerCase(), (nameCounts.get(x.file.toLowerCase()) || 0) + 1));

    list.sort((a, b) => a.file.localeCompare(b.file));
    const show = list.slice(0, perTypeLimit);
    const branch = lastType ? "    " : "|   ";
    show.forEach((x, i) => {
      const lastFile = i === show.length - 1 && count <= show.length;
      const filePrefix = branch + (lastFile ? "`-- " : "|-- ");
      const dup = (nameCounts.get(x.file.toLowerCase()) || 0) > 1;
      const suffix = dup ? `${formatBytesShort(x.bytes)} (dup)` : formatBytesShort(x.bytes);
      const name = showRefs ? driveRef(x.id) : x.file;
      writeLine(driveTreeLine(filePrefix, name, `(${suffix})`), "dim");
    });
    if (count > show.length) {
      writeLine(branch + "`-- " + `... (+${count - show.length} more)`, "dim");
    }
  });

  if (!expanded) {
    writeLine("Tip: `drive ls` to expand + show `drive:...` refs for `cat`/`del`.", "dim");
  }
  writeLine("Tip: `history` shows where files came from.", "dim");
}

function driveCommand(args) {
  const sub = String((args && args[0]) || "")
    .trim()
    .toLowerCase();
  if (sub === "ls") {
    driveTree({ expanded: true, showRefs: true });
    return;
  }
  if (sub === "flat") {
    listDriveFilesFlat();
    return;
  }
  driveTree({ expanded: false, showRefs: false });
}

function listHistory(args) {
  ensureRecentState();
  const sub = String((args && args[0]) || "")
    .trim()
    .toLowerCase();

  if (sub === "clear" || sub === "reset") {
    state.recent = { locs: [], files: [] };
    writeLine("history cleared", "ok");
    markDirty();
    return;
  }

  writeLine("HISTORY", "header");

  const locs = state.recent.locs || [];
  const files = state.recent.files || [];

  writeLine("locs:", "dim");
  if (!locs.length) writeLine("(none)", "dim");
  locs.slice(0, 20).forEach((e) => {
    const v = e && e.v ? String(e.v) : "";
    if (!v) return;
    const node = getLoc(v);
    const title = node && node.title ? String(node.title) : "UNKNOWN";
    writeLine(`${v} :: ${title}`, "dim");
  });

  writeLine("files:", "dim");
  if (!files.length) writeLine("(none)", "dim");
  files.slice(0, 25).forEach((e) => {
    const v = e && e.v ? String(e.v) : "";
    if (!v) return;

    if (/^drive:/i.test(v)) {
      const drive = getDriveEntry(v);
      if (!drive) {
        writeLine(`${v}  (missing)`, "dim");
        return;
      }
      const bytes = driveBytesForContent((drive && drive.content) || "");
      const type = drive && drive.type ? String(drive.type) : "file";
      const origin = String(drive.loc || "").trim();
      const originTitle = (getLoc(origin) && getLoc(origin).title) ? String(getLoc(origin).title) : "UNKNOWN";
      writeLine(
        `${driveRef(drive.id)}  (${type}, ${formatBytesShort(bytes)})  <= ${origin} :: ${originTitle}`,
        "dim"
      );
      return;
    }

    // Loc file refs we track as "loc/file"
    if (v.includes("/") && !v.includes("://")) {
      const parts = v.split("/");
      const loc = parts[0];
      const file = parts.slice(1).join("/");
      const node = getLoc(loc);
      const title = node && node.title ? String(node.title) : "UNKNOWN";
      writeLine(`${loc}/${file}  <= ${loc} :: ${title}`, "dim");
      return;
    }

    writeLine(v, "dim");
  });

  writeLine("Tip: `history clear` to wipe recent lists.", "dim");
}

function driveHas(id) {
  return !!(state.drive && state.drive[id]);
}

function updateDriveContent(id, nextContent, meta) {
  const key = String(id || "").trim();
  if (!key) return { ok: false, reason: "invalid" };
  const prior = state.drive && state.drive[key] ? state.drive[key] : null;
  const prevBytes = prior ? driveBytesForContent(String(prior.content || "")) : 0;
  const nextText = String(nextContent || "");
  const nextBytes = driveBytesForContent(nextText);
  const used = driveBytesUsed();
  const max = Number(state.driveMax) || 0;
  const nextUsed = Math.max(0, used - prevBytes + nextBytes);
  if (nextUsed > max) return { ok: false, reason: "full", bytes: nextBytes, used: nextUsed, max };

  const parts = key.split("/");
  const loc = parts[0] || "local";
  const name = parts.slice(1).join("/") || key;
  const type = prior && prior.type ? prior.type : "text";

  state.drive[key] = {
    loc,
    name,
    type,
    content: nextText,
    cipher: prior ? !!prior.cipher : false,
    downloadedAt: prior && prior.downloadedAt ? prior.downloadedAt : Date.now(),
    editedAt: Date.now(),
    editedBy: state.handle || "ghost",
    ...(meta && typeof meta === "object" ? meta : {}),
  };
  validateGlitchChant();
  return { ok: true, id: key, bytes: nextBytes, used: nextUsed, max };
}

function storeDriveCopy(locName, fileName, entry) {
  const id = driveId(locName, fileName);
  if (driveHas(id)) return { ok: true, id, existed: true };

  let content = "";
  let type = entry && entry.type ? entry.type : "text";
  if (type === "script") content = String((entry.script && entry.script.code) || entry.content || "");
  else content = String(entry.content || "");

  const bytes = driveBytesForContent(content);
  if (driveBytesUsed() + bytes > state.driveMax) {
    return { ok: false, reason: "full", bytes };
  }

  state.drive[id] = {
    loc: locName,
    name: fileName,
    type,
    content,
    cipher: !!entry.cipher,
    downloadedAt: Date.now(),
  };
  return { ok: true, id, existed: false, bytes };
}

let locFileIndexCache = null;
function getLocFileIndex() {
  if (locFileIndexCache) return locFileIndexCache;
  const scripts = new Map(); // scriptName -> { loc, file, entry }
  const items = new Map(); // itemId -> { loc, file, entry }
  const upgrades = new Map(); // upgradeId -> { loc, file, entry }

  Object.keys(LOCS).forEach((locName) => {
    const loc = LOCS[locName];
    const files = (loc && loc.files) || {};
    Object.keys(files).forEach((fileName) => {
      const entry = files[fileName];
      if (!entry) return;
      if (entry.type === "script" && entry.script && entry.script.name) {
        const n = String(entry.script.name);
        if (!scripts.has(n)) scripts.set(n, { loc: locName, file: fileName, entry });
      }
      if (entry.type === "item" && entry.item) {
        const id = String(entry.item);
        if (!items.has(id)) items.set(id, { loc: locName, file: fileName, entry });
      }
      if (entry.type === "upgrade" && entry.item) {
        const id = String(entry.item);
        if (!upgrades.has(id)) upgrades.set(id, { loc: locName, file: fileName, entry });
      }
    });
  });

  locFileIndexCache = { scripts, items, upgrades };
  return locFileIndexCache;
}

function ensureDriveBackfill({ silent } = {}) {
  if (!state.handle) return;
  if (!state.drive || typeof state.drive !== "object") state.drive = {};

  const { scripts, items, upgrades } = getLocFileIndex();
  let added = 0;
  let skippedFull = 0;

  function tryStore(locName, fileName, entry) {
    const res = storeDriveCopy(locName, fileName, entry);
    if (res.ok) {
      if (!res.existed) added += 1;
      return true;
    }
    if (res.reason === "full") skippedFull += 1;
    return false;
  }

  // Backfill downloaded kit scripts (historical saves may have kit but no drive entry).
  Object.keys(state.kit || {}).forEach((scriptName) => {
    const src = scripts.get(String(scriptName));
    if (src) tryStore(src.loc, src.file, src.entry);
    else {
      const synthetic = {
        type: "script",
        script: { name: scriptName, sec: state.kit[scriptName].sec, code: state.kit[scriptName].code },
        content: state.kit[scriptName].content || "",
      };
      tryStore("kit.cache", `${scriptName}.s`, synthetic);
    }
  });

  // Backfill acquired items/upgrades that came from downloads.
  Array.from(state.inventory || []).forEach((id) => {
    const key = String(id);
    const srcItem = items.get(key);
    const srcUpg = upgrades.get(key);
    if (srcItem) tryStore(srcItem.loc, srcItem.file, srcItem.entry);
    if (srcUpg) tryStore(srcUpg.loc, srcUpg.file, srcUpg.entry);
  });

  // Mirror local user scripts into drive so their size matters.
  Object.keys(state.userScripts || {}).forEach((name) => {
    const s = state.userScripts[name];
    const entry = {
      type: "script",
      script: { name: String(name), sec: String((s && s.sec) || "FULLSEC"), code: String((s && s.code) || "") },
      content: "",
    };
    tryStore("local", `${state.handle}.${name}.s`, entry);
  });

  if (!silent && (added || skippedFull) && !state.flags.has("drive_backfill_v1")) {
    state.flags.add("drive_backfill_v1");
    if (added) writeLine(`sys::drive synced (+${added})`, "dim");
    if (skippedFull) {
      writeLine("sys::drive full (some files not mirrored)", "warn");
      writeLine("Tip: `store` -> buy/install `upg.drive_ext`, or delete with `del drive:...`", "dim");
    }
  }

  if (added) markDirty();
}

async function delCommand(args) {
  const a = args || [];
  const target = String(a[0] || "").trim();
  if (!target) {
    writeLine(
      "Usage: del drive:<loc>/<file> | del <loc>:<file> | del <loc>/<file> | del <your_handle>.<script> [--confirm]",
      "warn"
    );
    return;
  }

  // Local sync folder deletes (local/file or local:filename).
  if (/^local[:/]/i.test(target)) {
    if (!localFolderGuard()) return;
    if (!localFolderHandle) {
      writeLine("Local folder not set. Run: folder pick", "warn");
      return;
    }
    const perm = await ensureLocalFolderPermission(true);
    if (!perm.ok) {
      writeLine("Local folder permission denied.", "warn");
      return;
    }
    const raw = target.replace(/^local[:/]/i, "");
    const isGlob = raw.includes("*") || raw.includes("?");
    const re = isGlob ? globToRegex(raw) : null;
    const removed = [];
    const matches = [];
    for await (const entry of localFolderHandle.values()) {
      if (!entry || entry.kind !== "file") continue;
      const name = String(entry.name || "");
      if (isGlob) {
        if (re.test(name)) matches.push(name);
        continue;
      }
      if (name === raw) matches.push(name);
      else if (name.toLowerCase().endsWith("." + raw.toLowerCase())) matches.push(name);
    }
    const targets = isGlob ? matches : matches.length === 1 ? matches : matches.filter((n) => n === raw);
    for (const name of targets) {
      try {
        await localFolderHandle.removeEntry(name);
        removed.push(name);
        const mirror = parseMirrorDownloadName(name);
        if (mirror) {
          removeDownloadedEntry(mirror.loc, mirror.file);
        }
        localFileMeta.delete(name);
      } catch {}
    }
    if (removed.length) {
      writeLine(`deleted ${removed.length} local file(s)`, "ok");
      return;
    }
    writeLine("Local file not found.", "warn");
    return;
  }

  // Uploaded files (loc:file or loc/file).
  if (target.includes(":") || target.includes("/")) {
    const normalized = target.replace(/^uploads?:/i, "");
    let locName = null;
    let fileName = null;
    if (normalized.includes(":")) {
      const parts = normalized.split(":", 2);
      locName = parts[0];
      fileName = parts[1];
    } else if (normalized.includes("/")) {
      const parts = normalized.split("/");
      locName = parts[0];
      fileName = parts.slice(1).join("/");
    }
    if (locName && fileName && state.uploads && state.uploads[locName] && state.uploads[locName].files) {
      const bucket = state.uploads[locName].files;
      if (bucket[fileName]) {
        delete bucket[fileName];
        writeLine(`deleted upload ${locName}/${fileName}`, "ok");
        markDirty();
        return;
      }
    }
  }

  // Drive wildcards:
  // - del drive:public.exchange/*.log
  // - del public.exchange/*.log
  const isGlob = target.includes("*") || target.includes("?");
  const looksLikeDriveId = target.includes("/") && !target.includes(":");
  if ((/^drive:/i.test(target) || looksLikeDriveId) && isGlob) {
    const pat = target.replace(/^drive:/i, "");
    const re = globToRegex(pat);
    const keys = Object.keys(state.drive || {});
    const matches = keys.filter((k) => re.test(k));
    if (!matches.length) {
      writeLine("No drive matches.", "warn");
      writeLine("Tip: `drive` to list stored files.", "dim");
      return;
    }
    matches.forEach((k) => delete state.drive[k]);
    writeLine(`deleted ${matches.length} drive file(s)`, "ok");
    markDirty();
    return;
  }

  // Drive single file (accepts both `drive:loc/file` and `loc/file`).
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
    writeLine("Tip: for drive deletions, run `drive` then copy the exact `drive:...` id.", "dim");
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

  // Convenience: allow `local/<name>.s` to refer to `drive:local/<handle>.<name>.s`.
  if (/^local\//i.test(s) && state.handle) {
    const rest = s.replace(/^local\//i, "").trim();
    const handle = String(state.handle).trim();
    if (rest) {
      const file = rest.toLowerCase().startsWith(handle.toLowerCase() + ".") ? rest : `${handle}.${rest}`;
      const resolved = getDriveEntry(`drive:local/${file}`);
      if (resolved) {
        return {
          kind: "text",
          name: resolved.name,
          content: String(resolved.content || ""),
          edited: false,
          detail: driveRef(resolved.id),
        };
      }
    }
  }

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
    writeLine("Usage: upload <drive:loc/file|script> [file]", "warn");
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
    // Backwards compatibility: if user passes a loc-qualified destination, parse it,
    // but uploads still only succeed when the destination loc is your current loc.
    const normalizedTarget = target.replace(/^drive:/i, "");

    if (normalizedTarget.includes(":")) {
      const parts = normalizedTarget.split(":", 2);
      destLoc = parts[0] || destLoc;
      destFile = parts[1] || null;
    } else if (normalizedTarget.includes("/")) {
      const parts = normalizedTarget.split("/");
      const maybeLoc = parts[0];
      const rest = parts.slice(1).join("/");
      if (maybeLoc && getLoc(maybeLoc) && rest) {
        destLoc = maybeLoc;
        destFile = rest;
      } else {
        destFile = normalizedTarget;
      }
    } else if (getLoc(normalizedTarget)) {
      destLoc = normalizedTarget;
    } else {
      destFile = normalizedTarget;
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

  // Uploads only target your current connected loc.
  // This keeps location scoping consistent: you can't change a remote system while disconnected from it.
  if (destLoc !== state.loc) {
    writeLine(`You must be connected to ${destLoc} to upload there.`, "warn");
    writeLine(`Tip: connect ${destLoc}`, "dim");
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
  // If uploading into the current location, make it immediately visible in `ls` and readable via `cat`.
  if (destLoc === state.loc) trackRecentFile(`${destLoc}/${destFile}`);
  storyChatTick();
}

function scheduleDownload(locName, fileName) {
  const loc = getLoc(locName);
  const entry = loc && loc.files && loc.files[fileName];
  if (!entry || !isDownloadableEntry(entry)) return false;

  const id = driveId(locName, fileName);

  // If the drive copy already exists, this download is redundant.
  if (state.drive[id]) return false;

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

  // Downloads should be noticeable by default; upgrades should feel meaningful.
  // Keep times game-y but not annoying.
  const base = 2400;
  const scaled = Math.floor(size * 8);
  const jitter = Math.floor(Math.random() * 700);
  let durationMs = Math.max(2000, Math.min(18_000, base + scaled + jitter));
  if (entry.type === "upgrade") durationMs = Math.floor(durationMs * 1.6);
  else if (entry.type === "item") durationMs = Math.floor(durationMs * 1.2);
  else if (entry.type === "text") durationMs = Math.floor(durationMs * 0.9);

  let mult = 1.0;
  if (state.upgrades.has("upg.modem")) mult *= 0.7;
  if (state.upgrades.has("upg.backbone")) mult *= 0.5;
  durationMs = Math.max(900, Math.floor(durationMs * mult));

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

  // Store a local drive copy for everything downloadable.
  const stored = storeDriveCopy(active.loc, active.file, entry);
  if (!stored.ok) {
    writeLine("download failed: drive full", "error");
    writeLine("Tip: buy `upg.drive_ext` at the exchange (store), or delete with `del drive:...`.", "dim");
    startNextDownloadIfIdle();
    return;
  }
  trackRecentFile(driveRef(driveId(active.loc, active.file)));

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
    writeLine(`download complete: ${active.file} -> ${driveRef(driveId(active.loc, active.file))}`, "ok");
  }
  markDirty();
  void mirrorDownloadToLocalFolder(active.loc, active.file, entry);

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
    const now = Date.now();
    const elapsed = now - state.downloads.active.startedAt;
    const pct = Math.max(
      0,
      Math.min(100, Math.floor((elapsed / state.downloads.active.durationMs) * 100))
    );
    const barWidth = 18;
    const filled = Math.round((pct / 100) * barWidth);
    const bar = `[${"#".repeat(filled)}${".".repeat(barWidth - filled)}]`;
    writeLine(`active: ${state.downloads.active.file} ${bar} ${pct}%`, "dim");
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
    handleLoreSignals("drive", fileBaseName(drive.id), drive);
    trackRecentFile(driveRef(drive.id));
    return;
  }
  const found = getLocFileEntry(state.loc, name);
  if (!found) {
    // Uploaded overlay files in the current loc.
    const bucket = state.uploads && state.uploads[state.loc] && state.uploads[state.loc].files;
    if (bucket && typeof bucket === "object") {
      const key = String(name || "").trim();
      const exact = key && bucket[key] ? bucket[key] : null;
      const lower = key.toLowerCase();
      const ciName = !exact ? Object.keys(bucket).find((k) => k.toLowerCase() === lower) : null;
      const up = exact || (ciName ? bucket[ciName] : null);
      if (up) {
        writeLine(`${ciName || key} [uploaded]`, "header");
        writeBlock(String(up.content || ""), "dim");
        trackRecentFile(`${state.loc}/${ciName || key}`);
        return;
      }
    }

    const script = resolveScript(name);
    if (!script) {
      writeLine("File not found.", "error");
      return;
    }
    writeLine(`${script.owner}.${script.name} [${script.sec}]`, "header");
    trackRecentFile(`${script.owner}.${script.name}`);
    if (script.owner === "scripts.trust") {
      writeLine("BUILTIN :: source not exposed", "dim");
      writeLine(`Run: call ${script.owner}.${script.name}`, "dim");
      return;
    }
    const code = String(script.code || "");
    if (!code.trim()) {
      writeLine("(script empty)", "warn");
      writeLine("Tip: `edit " + script.name + "` then paste code, then `:wq`", "dim");
      return;
    }
    writeBlock(code, "dim");
    return;
  }
  const entry = found.entry;

  // If an uploaded overlay exists for this file name, prefer it (it represents the current remote state).
  const bucket = state.uploads && state.uploads[state.loc] && state.uploads[state.loc].files;
  if (bucket && typeof bucket === "object") {
    const key = String(found.name || "").trim();
    const up = key && bucket[key] ? bucket[key] : null;
    if (up) {
      writeLine(`${key} [uploaded]`, "header");
      writeBlock(String(up.content || ""), "dim");
      trackRecentFile(`${state.loc}/${key}`);
      return;
    }
  }

  writeBlock(entry.content, "dim");
  if (String(name || "").toLowerCase() === "primer.dat") state.flags.add("read_primer");
  if (String(name || "").toLowerCase() === "script.intro") state.flags.add("read_script_intro");
  handleLoreSignals(state.loc, found.name, entry);
  if (entry.cipher) {
    state.lastCipher = entry.content;
  }
  trackRecentFile(`${state.loc}/${found.name}`);
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
    trustCoolDown(TRUST_COOLDOWN_ON_WAIT, "wait");
    recordBehavior("patient");
    recordRogueBehavior("careful");
    watcherProfileTick();
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
      void mirrorScratchToLocalFolder(scratchPad.value);
      // "System Clear" wipes scratch + chat (player request).
      state.chat.log = [];
      state.chat.channel = "#kernel";
      state.chat.channels = new Set(["#kernel"]);
      renderChat();
      writeLine("sys::scratch cleared", "dim");
      writeLine("sys::chat cleared", "dim");
      markDirty();
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
  if (chatLog && chatInput) {
    chatLog.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const nameEl = target.closest(".chat-name");
      if (!nameEl) return;
      const name = String(nameEl.dataset.chatName || "").trim();
      if (!name || name === "sys") return;
      if (state.handle && name === state.handle) return;
      chatInput.value = `/tell ${name} `;
      chatInput.focus();
    });
  }

  if (localFolderPick) {
    localFolderPick.addEventListener("click", () => {
      pickLocalFolder();
    });
  }
  if (localFolderSync) {
    localFolderSync.addEventListener("click", () => {
      syncLocalFolder();
    });
  }
  if (localFolderForget) {
    localFolderForget.addEventListener("click", () => {
      forgetLocalFolder();
    });
  }
  if (localFolderMirror) {
    localFolderMirror.addEventListener("change", () => {
      if (!state.localSync) state.localSync = { mirror: false };
      state.localSync.mirror = !!localFolderMirror.checked;
      writeLine(`Local mirror ${state.localSync.mirror ? "enabled" : "disabled"}.`, "dim");
      markDirty();
      refreshLocalFolderUi();
      ensureLocalSyncPoll();
    });
  }
}

function resetToFreshState(keepChat) {
  const priorChat = keepChat ? state.chat : null;
  state.handle = null;
  state.loc = "home.hub";
  state.gc = 120;
  state.discovered = new Set(["home.hub", "training.node", "public.exchange", "sable.gate", "island.grid", "trust.anchor"]);
  state.unlocked = new Set(["home.hub", "public.exchange", "island.grid", "trust.anchor"]);
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
  state.localSync = { mirror: false };
  state.lockoutUntil = 0;
  state.wait = { lastAt: 0, streak: 0 };
  state.lastCipher = null;
  state.breach = null;
  state.editor = null;
  state.history = [];
  state.historyIndex = 0;
  state.recent = { locs: [], files: [] };
  state.confirm = null;
  state.tutorial = { enabled: true, stepIndex: 0, completed: new Set() };
  state.npcs = { known: new Set(["switchboard"]) };
  state.downloads = { active: null, queue: [] };
  state.trust = { level: 2, heat: 0, lastScanAt: 0 };
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
    id: "t_script_intro",
    title: "Learn The Script Basics",
    hint: "Run `cat script.intro` at home.hub.",
    check: () => state.flags.has("read_script_intro"),
    onStart: () =>
      chatPost({
        channel: "#kernel",
        from: "switchboard",
        body: "No code? No problem. Read `script.intro` for the why + how.",
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
    hint:
      "Run `breach training.node`, then `unlock <handle>`, `unlock WELCOME`, `unlock <hex3>`, `unlock <handle> WELCOME HOME <hex3>`, then `connect training.node`.",
    check: () => state.unlocked.has("training.node") && state.loc === "training.node",
    onStart: () =>
      chatPost({
        channel: "#kernel",
        from: "switchboard",
        body: "Use the three keys + final phrase from primer.dat/script.intro to open `training.node`.",
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
      writeLine("sys::trust lattice.cache waiting :: token + mark verified", "trust"),
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
      const cmds = extractBacktickCommands(step.hint);
      if (cmds.length) writeLineWithChips("  try:", cmds, "dim");
    }
  });
}

function tutorialNextHint() {
  tutorialAdvance();
}

function printTrustStatus(options) {
  const opts = options || {};
  if (opts.concise) {
    // Narrative summary: remind players of the relationship without stats.
    writeLine("trust holds memory; heat is noise; trace is the hand that moves.", "trust");
    if (trustHeat() > 0) writeLine("noise is fading; anchor if you want it gone faster.", "dim");
    if (state.trace > 0) writeLine("watchers are awake; move softly.", "warn");
    return;
  }
  writeLine("TRUST STATE", "header");
  writeLine(trustStatusLabel(), "dim");
  if (state.trace > 0) writeLine(`trace ${state.trace}/${state.traceMax} (heat raises faster under pressure)`, "warn");
  writeLine("Heat rises when you spam scan, fail locks, or breach without plan. Wait or anchor to cool.", "dim");
  writeLine("Narrative path:", "header");
  NARRATIVE_STEPS.forEach((step) => {
    const reached = step.nodes.some((n) => state.unlocked.has(n) || state.discovered.has(n));
    const tag = reached ? "[*]" : "[ ]";
    writeLine(`${tag} ${step.title} :: ${step.summary}`, reached ? "ok" : "dim");
  });
  writeLine("Tip: connect trust.anchor to dump heat. Jobs and coolant also help.", "dim");
}

function tutorialSetEnabled(enabled) {
  state.tutorial.enabled = Boolean(enabled);
  if (state.tutorial.enabled) tutorialAdvance();
  updateHud();
}

function submitTerminalCommand(raw) {
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
      err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
    writeLine(`Command error: ${msg}`, "error");
  }
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

// Notify when a narrative step is reached for the first time.
function triggerNarrativeStepForLoc(locName) {
  const step = NARRATIVE_STEPS.find((s) => (s.nodes || []).includes(locName));
  if (!step) return;
  const key = `narrative_step_${step.id || step.name || step.title}`;
  if (state.flags.has(key)) return;
  state.flags.add(key);
  const summary = step.summary || "Signal shifts.";
  const cue = NARRATIVE_CUES[step.id] || NARRATIVE_CUES[step.name] || summary;
  chatPost({
    channel: "#kernel",
    from: "sys",
    body: `[path] ${step.title || step.name || "route"} :: ${cue}`,
  });
  state.narrativeHint = `${step.title || step.name}: ${cue}`;
  updateHud();
  // Story progression can also be driven by reaching key locs.
  if (state.storyState && state.storyState.current === step.id) {
    storyAdvanceToNext(`loc:${locName}`);
  }
}

// Occasionally alter tone based on dominant behavior (in-world, no explicit callouts).
function behaviorToneNudge() {
  const dom = dominantBehavior();
  if (!dom) return;
  const key = `behavior_tone_${dom}`;
  if (state.flags.has(key)) return;
  if (Math.random() < 0.5) return; // keep it occasional
  state.flags.add(key);
  if (dom === "noise") chatPost({ channel: "#kernel", from: "watcher", body: "your signal leaves a wake. some nodes may start whispering back." });
  if (dom === "careful") chatPost({ channel: "#kernel", from: "switchboard", body: "quiet hands get noticed differently. some doors stay polite longer." });
  if (dom === "aggressive") chatPost({ channel: "#kernel", from: "archivist", body: "blunt entries leave marks. archives will remember the scars." });
  if (dom === "patient") chatPost({ channel: "#kernel", from: "watcher", body: "stillness is a kind of noise too. the net adjusts." });
}

// Narrative tie-in when trace rises: remind that watchers move because of patterns.
function watcherTraceReact(reason) {
  const dom = dominantBehavior();
  const bias = behaviorBias();
  // Profiling: watcher tone softens or sharpens based on cadence + recent pressure.
  const note =
    dom === "noise"
      ? "same wake again; watchers move."
      : dom === "aggressive"
        ? bias.momentum > 1 ? "force repeats; watchers cut paths shorter." : "force echoes. watchers route toward you."
        : dom === "patient"
          ? bias.tranquil && trustHeat() < 3 ? "silence broke; eyes pivot, but they linger." : "silence broke; eyes pivot."
          : bias.tranquil && (state.trace || 0) === 0
            ? "cadence noted; routes stay loose for a beat."
            : "cadence noted; trace routes tighten.";
  chatPost({
    channel: "#kernel",
    from: "watcher",
    body: reason ? `${note} (${reason})` : note,
  });
}

// Lightweight snapshot of behavior for subtle profiling (invisible to players).
function behaviorBias() {
  const bp = state.behaviorProfile || {};
  const rush = (bp.noise || 0) + (bp.aggressive || 0);
  const calm = (bp.patient || 0) + (bp.careful || 0);
  return {
    rush,
    calm,
    momentum: rush - calm,
    tranquil: calm > rush,
    dom: dominantBehavior(),
  };
}

// Profiling: when heat rises repeatedly, watchers change their phrasing to match cadence.
function behaviorHeatTone(reason) {
  const bias = behaviorBias();
  const dom = bias.dom;
  const heat = trustHeat();
  // Avoid spam: only nudge after a few spikes and once per leaning.
  if (heat < 2) return;
  const key = `behavior_heat_tone_${dom || "neutral"}`;
  if (state.flags.has(key)) return;
  if (dom === "noise" || dom === "aggressive") {
    if (heat >= Math.floor(TRUST_HEAT_THRESHOLD / 2)) {
      state.flags.add(key);
      chatPost({ channel: "#kernel", from: "watcher", body: "heat shapes your wake. some routes start locking early." });
    }
  } else if (dom === "patient" || dom === "careful") {
    state.flags.add(key);
    chatPost({ channel: "#kernel", from: "watcher", body: "pace noted. some systems give you a longer look before shutting." });
  }
}

// Profiling: adjust trace rise subtly based on cadence. No new meters; just pacing.
function profiledTraceRise(base, reason) {
  const bias = behaviorBias();
  const heat = trustHeat();
  const currentTrace = state.trace || 0;
  let delta = Math.max(0, base);
  if (bias.momentum > 1 || bias.dom === "aggressive") {
    if (heat >= Math.floor(TRUST_HEAT_THRESHOLD / 2) || currentTrace >= state.traceMax - 1) {
      delta += 1; // Noisy players trigger earlier watcher pressure.
    }
  } else if ((bias.tranquil || bias.dom === "careful") && currentTrace === 0 && heat < TRUST_HEAT_THRESHOLD / 2) {
    delta = Math.max(0, delta - 1); // Patient runs get a first-mistake grace.
  }
  state.trace = Math.min(state.traceMax, currentTrace + delta);
  return delta;
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
  Object.values(GLITCH_FRAGMENTS).forEach((frag) => {
    if (upper.includes(frag.clue)) state.flags.add(`fragment_${frag.id}`);
  });
  if (upper.includes("ROGUE") || upper.includes("ADAPT")) state.flags.add("rogue_hint");
  if (upper.includes("MANTLE")) state.flags.add("mantle_phrase");
  validateGlitchChant();
  storyChatTick();
}

function recordFragment(id) {
  const key = `fragment_${id}`;
  state.flags.add(key);
  if (state.storyState && state.storyState.beats) {
    state.storyState.beats.add(key);
  }
  storyProgressEvent("fragment", { id });
  validateGlitchChant();
}

// Track tendencies for the rogue core adaptation.
function recordRogueBehavior(kind) {
  if (!state.rogueProfile || typeof state.rogueProfile !== "object") {
    state.rogueProfile = { noise: 0, careful: 0, brute: 0, failures: 0, outcomes: new Set() };
  }
  const rp = state.rogueProfile;
  if (!(rp.outcomes instanceof Set)) rp.outcomes = new Set(rp.outcomes || []);
  if (kind === "noise") rp.noise += 1;
  if (kind === "careful") rp.careful += 1;
  if (kind === "brute") rp.brute += 1;
  if (kind === "fail") rp.failures += 1;
}

// General behavior tracking for future adaptive responses (kept invisible to the player).
function recordBehavior(kind) {
  if (!state.behaviorProfile || typeof state.behaviorProfile !== "object") {
    state.behaviorProfile = { noise: 0, careful: 0, aggressive: 0, patient: 0 };
  }
  const bp = state.behaviorProfile;
  if (kind === "noise") bp.noise += 1;
  if (kind === "careful") bp.careful += 1;
  if (kind === "aggressive") bp.aggressive += 1;
  if (kind === "patient") bp.patient += 1;
}

function dominantBehavior() {
  const bp = state.behaviorProfile || {};
  const entries = [
    ["noise", bp.noise || 0],
    ["careful", bp.careful || 0],
    ["aggressive", bp.aggressive || 0],
    ["patient", bp.patient || 0],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][1] > 0 ? entries[0][0] : null;
}

// Quiet watcher profiling based on dominant behavior; stored but never shown.
function watcherProfileTick() {
  const dom = dominantBehavior();
  if (!dom) return;
  const key = `watcher_profile_${dom}`;
  if (state.watcherProfile === dom) return;
  state.watcherProfile = dom;
  // Only whisper once per profile shift to keep it sparse.
  if (!state.flags.has(key)) {
    state.flags.add(key);
    const lines = {
      noise: "your cadence is familiar. watchers lean in.",
      careful: "still hands; the net pauses, listening longer.",
      aggressive: "marks linger where you force doors. archivists take note.",
      patient: "long silences thread your path. some eyes stop asking if you belong.",
    };
    if (lines[dom]) chatPost({ channel: "#kernel", from: "watcher", body: lines[dom] });
  }
}

function ensureStoryState() {
  if (!state.storyState || typeof state.storyState !== "object") {
    state.storyState = { current: "island_intro", completed: new Set(), beats: new Set(), flags: new Set(), failed: new Set() };
  }
  const s = state.storyState;
  if (!(s.completed instanceof Set)) s.completed = new Set(s.completed || []);
  if (!(s.beats instanceof Set)) s.beats = new Set(s.beats || []);
  if (!(s.flags instanceof Set)) s.flags = new Set(s.flags || []);
  if (!(s.failed instanceof Set)) s.failed = new Set(s.failed || []);
  if (!s.current) s.current = "island_intro";
  return s;
}

function storyCurrentStep() {
  ensureStoryState();
  return NARRATIVE_STEPS.find((s) => s.id === state.storyState.current) || NARRATIVE_STEPS[0];
}

function storyAdvanceToNext(reason) {
  ensureStoryState();
  const current = storyCurrentStep();
  if (current && current.id) state.storyState.completed.add(current.id);
  const nextIdx = narrativeStepIndex(current ? current.id : null) + 1;
  const next = NARRATIVE_STEPS[nextIdx] || current;
  state.storyState.current = next.id || current.id;
  const cue = NARRATIVE_CUES[next.id] || NARRATIVE_CUES[next.name] || next.summary || "signal moves";
  chatPost({
    channel: "#kernel",
    from: "sys",
    body: `[path] ${next.title || next.name || "route"} :: ${cue}`,
  });
  state.narrativeHint = `${next.title || next.name}: ${cue}`;
  if (reason) state.storyState.flags.add(`advance:${reason}`);
  markDirty();
}

// Lightweight dispatcher: move the story when meaningful actions land.
function storyProgressEvent(kind, payload) {
  ensureStoryState();
  const current = storyCurrentStep();
  const nodes = (current && current.nodes) || [];

  if (kind === "breach" && payload && nodes.includes(payload.loc)) {
    storyAdvanceToNext(`breach:${payload.loc}`);
    return;
  }

  if (kind === "chant_ready") {
    state.storyState.flags.add("chant_ready");
    if (current && current.id === "glitch_arc") storyAdvanceToNext("chant");
    return;
  }

  if (kind === "trust_anchor_heat") {
    state.storyState.flags.add("anchor_coolant");
    if (current && current.id === "trust_pressure") storyAdvanceToNext("anchor");
    return;
  }

  if (kind === "corruption" && payload && payload.level >= 2) {
    state.storyState.flags.add("corruption_seen");
    if (current && current.id === "glitch_arc") storyAdvanceToNext("corruption");
    return;
  }

  if (kind === "fragment" && current && current.id === "glitch_arc") {
    if (state.storyState.beats.size >= 2) {
      storyAdvanceToNext("fragments");
    }
    return;
  }

  if (kind === "core_ready" && current && current.id === "rogue_finale") {
    storyAdvanceToNext("rogue_ready");
  }
}

function fragmentTextToWord(text) {
  return String(text || "")
    .replace(new RegExp(GLITCH_GLYPH, "g"), "")
    .replace(/[^A-Z]/gi, "")
    .toUpperCase();
}

// As corruption rises or trust dips, fragments momentarily reveal more.
function softenFragmentCorruption(text) {
  const clarity = corruptionLevel() + (trustLevel() <= 2 ? 1 : 0);
  if (clarity <= 0) return text;
  const ratio = Math.min(0.6, clarity * 0.15);
  return String(text || "").replace(new RegExp(GLITCH_GLYPH, "g"), (m) => (Math.random() < ratio ? "" : m));
}

function glitchFragmentsFromDrive() {
  const out = [];
  Object.keys(state.drive || {}).forEach((id) => {
    const entry = state.drive[id];
    if (!entry) return;
    const name = entry.name || id;
    const m = String(name || "").match(/fragment\.(alpha|beta|gamma|delta)/i);
    if (m && m[1]) {
      out.push({ id: m[1].toLowerCase(), text: softenFragmentCorruption(entry.content), source: id });
    }
  });
  return out;
}

// Validate glitch phrase assembly: all fragments must be cleaned (no GLITCH_GLYPH)
// and contribute to the chant. Only then should glitch_phrase_ready be set.
function validateGlitchChant() {
  const entries = glitchFragmentsFromDrive();
  const cleaned = new Map();
  entries.forEach((entry) => {
    if (!String(entry.text || "").includes(GLITCH_GLYPH)) {
      cleaned.set(entry.id, fragmentTextToWord(entry.text));
    }
  });
  const haveAll = GLITCH_FRAGMENT_IDS.every((id) => cleaned.has(id));
  const chantWords = {
    beta: cleaned.get("beta") || "?",
    gamma: cleaned.get("gamma") || "?",
    delta: cleaned.get("delta") || "?",
  };
  const chant = `${chantWords.beta} THE ${chantWords.gamma} ${chantWords.delta} THREAD`.trim();

  // Player must reconstruct intentionally (scratchpad or drive) — no auto-complete.
  const attempt = findChantAttempt();
  const exact = attempt && attempt === chant;
  const near =
    attempt &&
    !exact &&
    chantWords.beta !== "?" &&
    chantWords.gamma !== "?" &&
    chantWords.delta !== "?" &&
    ["THE", "THREAD"].every((w) => attempt.includes(w));

  if (haveAll && exact) {
    if (!state.flags.has("glitch_phrase_ready")) {
      chatPost({
        channel: "#kernel",
        from: "weaver",
        body: `Chant stitched: ${chant}`,
      });
    }
    state.flags.add("glitch_phrase_ready");
    state.flags.add("glitch_phrase_clean");
    state.flags.add("glitch_chant_value");
    state.glitchChant = chant;
    storyProgressEvent("chant_ready");
    recordRogueBehavior("careful");
  } else {
    // Near-miss: subtle corruption and slight heat bump (trace when very close), no explicit “wrong”.
    if (attempt && haveAll) {
      writeLine("chant scatters in the buffer", "warn");
      trustAdjustHeat(1, "chant_miss");
      if (near) state.trace = Math.min(state.traceMax, (state.trace || 0) + 1);
      if (near) watcherTraceReact("chant noise");
      recordRogueBehavior("brute");
    }
    state.flags.delete("glitch_phrase_ready");
    state.flags.delete("glitch_phrase_clean");
    state.flags.delete("glitch_chant_value");
    state.glitchChant = null;
  }
}

function handleLoreSignals(locName, fileName, entry) {
  const text = String((entry && entry.content) || "");
  const upper = text.toUpperCase();
  if (fileName.toLowerCase().includes("fragment")) {
    const id = fileName.match(/fragment\.(alpha|beta|gamma|delta)/i);
    if (id && id[1]) {
      recordFragment(id[1].toLowerCase());
      const softer = softenFragmentCorruption(text);
      if (softer !== text) {
        writeLine("static thins: " + softer, "dim");
      }
    }
  }
  Object.values(GLITCH_FRAGMENTS).forEach((frag) => {
    if (upper.includes(frag.clue)) recordFragment(frag.id);
  });
  if (text.includes(GLITCH_GLYPH)) state.flags.add("corruption");
  if (locName === "trust.anchor") trustCoolDown(2, "anchor read");
  if (locName === "glitch.cache" && upper.includes("CHANT")) state.flags.add("glitch_chant_known");
  if (locName === "glitch.cache") setCorruptionLevel(Math.max(corruptionLevel(), 1));
  if (upper.includes("NARRATIVE STEP")) state.flags.add("narrative_brief_seen");
  if (upper.includes("ROGUE") || upper.includes("ADAPTIVE")) state.flags.add("rogue_hint");
  if (upper.includes("MANTLE")) state.flags.add("mantle_phrase");
  if (locName === "rogue.core" && fileName.toLowerCase() === "rogue.seed") state.flags.add("rogue_seed_read");
  validateGlitchChant();
}

const trustScripts = {
  "scripts.trust.scan": {
    owner: "scripts.trust",
    name: "scan",
    sec: "FULLSEC",
    run: (ctx) => {
      ctx.print("Scanning...");
      const now = Date.now();
      const last = Number(state.trust && state.trust.lastScanAt) || 0;
      if (now - last < 4000) {
        ctx.print("Noise complains about rapid scans (trust heat +1).");
        trustAdjustHeat(1, "rapid scan");
      }
      if (state.trust) state.trust.lastScanAt = now;
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
  let printed = 0;
  const origPrint = ctx.print;
  ctx.print = (msg) => {
    printed += 1;
    origPrint(msg);
  };
  try {
    const fn = new Function("ctx", "args", `"use strict";\n${script.code}`);
    fn(ctx, args);
    state.flags.add("ran_user_script");
    if (printed === 0) writeLine("Script complete (no output).", "dim");
  } catch (err) {
    writeLine(`Script error: ${err.message}`, "error");
    try {
      const stack = String((err && err.stack) || "");
      const m = stack.match(/<anonymous>:(\d+):(\d+)/);
      if (m) {
        const lineNo = Number(m[1]);
        const colNo = Number(m[2]);
        const scriptLine = Math.max(1, lineNo - 1); // account for `"use strict";` line
        const lines = String(script.code || "").split("\n");
        const lineText = lines[scriptLine - 1] || "";
        writeLine(`at ${script.owner}.${script.name}:${scriptLine}:${colNo}`, "dim");
        if (lineText) writeLine(lineText, "dim");
      }
    } catch {}
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

  const trustStatus = state.handle ? ` | ${trustStatusLabel()}` : "";
  statusLine.textContent = state.handle
    ? `${state.handle}@${state.loc}${trustStatus}${dlStatus}`
    : "enter handle or type load";
  prompt.textContent = state.editor ? "edit>" : ">>";

  if (hint) {
    const current = tutorialCurrent();
    if (current && state.tutorial.enabled) {
      hint.textContent = `Objective: ${current.title} — ${current.hint}`;
    } else {
      hint.textContent =
        state.narrativeHint ||
        "Type `help` for commands. Use `scripts` to list available scripts.";
    }
  }
}

function storyChatTick() {
  if (!state.handle) return;
  RegionManager.bootstrap({ silent: true });
  triggerNarrativeStepForLoc(state.loc);
  behaviorToneNudge();
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
    if (!state.flags.has("tutorial_training_done")) {
      state.flags.add("tutorial_training_done");
      const added = discover(["island.echo"]);
      if (added.length) chatPost({ channel: "#kernel", from: "switchboard", body: "Island echo opened. `connect island.echo` for extra guidance." });
    }
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
  if (state.unlocked.has("lattice.cache") && trustLevel() >= 2 && !state.flags.has("chat_deep_slate")) {
    state.flags.add("chat_deep_slate");
    const added = discover(["deep.slate"]);
    if (added.length) {
      chatPost({
        channel: "#kernel",
        from: "archivist",
        body: "Depth slate exposed: `deep.slate` (needs trust 2 + lattice sigil).",
      });
    }
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
  if (trustLevel() <= 1 && !state.flags.has("chat_trust_low")) {
    state.flags.add("chat_trust_low");
    const added = discover(["trust.anchor"]);
    if (added.length) chatPost({ channel: "#kernel", from: "switchboard", body: "Heat spike. Anchor open: `connect trust.anchor` to cool." });
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
  if (state.flags.has("slipper_signal") && state.inventory.has("weaver.mark") && !state.flags.has("chat_glitch_cache")) {
    state.flags.add("chat_glitch_cache");
    const added = discover(["glitch.cache"]);
    if (added.length) {
      chatPost({
        channel: "#kernel",
        from: "weaver",
        body: "You hold thread and mask. A corrupted cache opened: `glitch.cache`. Bring patience.",
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
  if (state.flags.has("glitch_phrase_ready") && state.flags.has("touched_relic") && !state.flags.has("chat_rogue_ready")) {
    state.flags.add("chat_rogue_ready");
    const added = discover(["rogue.core"]);
    if (added.length) {
      chatPost({
        channel: "#kernel",
        from: "archivist",
        body: "You rebuilt the chant. The rogue core is exposed: `breach rogue.core` when trust is steady.",
      });
    }
  }
  if (state.flags.has("glitch_phrase_ready") && state.inventory.has("cinder.token") && !state.flags.has("chat_cinder_ready")) {
    state.flags.add("chat_cinder_ready");
    const added = discover(["cinder.core"]);
    if (added.length) {
      chatPost({
        channel: "#kernel",
        from: "archivist",
        body: "Depth token forged. Optional finale: `cinder.core` (chant + checksum + mantle).",
      });
    }
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
  const trustNeed = Number(req.trust) || 0;
  const missingTrust = trustNeed && !trustGate(trustNeed) ? trustNeed : null;
  return { ok: !missingItems.length && !missingFlags.length && !missingTrust, missingItems, missingFlags, missingTrust };
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
  if (locName === "rogue.core") {
    if (!state.flags.has("glitch_phrase_ready")) {
      writeLine("rogue.core ignores you; chant incomplete.", "warn");
      return;
    }
    if (!trustGate(3)) {
      writeLine("rogue.core watches your trust level and discards your ping.", "warn");
      return;
    }
    if (!state.flags.has("rogue_seed_read")) {
      writeLine("rogue.core pulses back a checksum request. Read rogue.seed first.", "warn");
      return;
    }
    rogueCoreAdaptiveIntro();
    chatPost({
      channel: "#kernel",
      from: "archivist",
      body: "Rogue ritual: trust steady, chant whole, checksum ready. Do not rush the lock stack.",
    });
    rogueCoreProfiledPressure();
  }
  RegionManager.bootstrap({ silent: true });
  state.currentRegion = state.region.current;
  const regionGate = RegionManager.canAccessNode(locName);
  if (!regionGate.ok) {
    writeLine(`signal refused :: ${regionGate.name} stays dark (${regionGate.hint || "route cooling"})`, "warn");
    chatPost({
      channel: "#kernel",
      from: "switchboard",
      body: `Route sealed: ${regionGate.name}. Clear prior signals before it will answer.`,
    });
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
  trustAdjustHeat(1, "breach start");
  writeLine(`BREACHING ${locName}`, "header");
  writeLine(`sys::breach.start ${locName}`, "trust");
  if (!loc.locks.length) {
    writeLine("No locks detected. Access open.", "ok");
    state.unlocked.add(locName);
    setMark("mark.breach");
    storyProgressEvent("breach", { loc: locName });
    state.breach = null;
    return;
  }

  // Boss-like pressure: the warden pulses trace while you're inside the core lock stack.
  if (locName === "core.relic") {
    setCorruptionLevel(Math.max(corruptionLevel(), 2));
    const bias = behaviorBias();
    const basePulseMs = 7000;
    // Profiling: noisier cadences feel more pressure; patient runs get a longer beat.
    const pulseMs = Math.max(5200, basePulseMs + (bias.momentum > 1 ? -1200 : bias.tranquil ? 900 : 0));
    state.breach.pressure = window.setInterval(() => {
      if (!state.breach || state.breach.loc !== "core.relic") return;
      writeLine("WARDEN PULSE :: trace rising", "warn");
      failBreach();
    }, pulseMs);
  }

  writeLine(loc.locks[0].prompt, "warn");
}

function failBreach() {
  const traceDelta = profiledTraceRise(1, "lock fail");
  trustAdjustHeat(1, "failed lock");
  recordRogueBehavior("fail");
  recordRogueBehavior("brute");
  recordBehavior("aggressive");
  watcherTraceReact("lock fail");
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
  const traceMsg =
    traceDelta > 0 ? `TRACE +${traceDelta} (${state.trace}/${state.traceMax})` : `TRACE steady (${state.trace}/${state.traceMax})`;
  writeLine(traceMsg, traceDelta > 0 ? "warn" : "dim");
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
    if (state.trace === 0 && trustHeat() === 0) recordRogueBehavior("careful");
    state.breach.index += 1;
    if (state.breach.index >= loc.locks.length) {
      const unlockedLoc = state.breach.loc;
      writeLine("STACK CLEARED. ACCESS OPEN.", "ok");
      state.unlocked.add(unlockedLoc);
      setMark("mark.breach");
      storyProgressEvent("breach", { loc: unlockedLoc });
      if (pressure) window.clearInterval(pressure);
      writeLine(`sys::breach.success ${unlockedLoc}`, "trust");
      state.breach = null;
      connectLoc(unlockedLoc);
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
  const autoBreach = arguments.length > 1 && arguments[1] && arguments[1].autoBreach;
  if (!state.discovered.has(locName)) {
    writeLine("Unknown loc. Run scripts.trust.scan or discover it.", "warn");
    return;
  }
  const loc = getLoc(locName);
  if (!loc) {
    writeLine("Loc not found.", "error");
    return;
  }
  RegionManager.bootstrap({ silent: true });
  state.currentRegion = state.region.current;
  const regionGate = RegionManager.canAccessNode(locName);
  if (!regionGate.ok) {
    writeLine(`signal refused :: ${regionGate.name} stays dark (${regionGate.hint || "route cooling"})`, "warn");
    chatPost({
      channel: "#kernel",
      from: "switchboard",
      body: `Route sealed: ${regionGate.name}. Clear prior signals before it will answer.`,
    });
    return;
  }
  if (!requirementsMet(locName)) {
    writeLine("Requirements not met for this loc.", "warn");
    const req = loc.requirements || {};
    const flags = Array.isArray(req.flags) ? req.flags : [];
    const items = Array.isArray(req.items) ? req.items : [];
    const trustReq = req.trust || null;
    if (flags.length) writeLine("Need flags: " + flags.join(", "), "dim");
    if (items.length) writeLine("Need items: " + items.join(", "), "dim");
    if (trustReq) writeLine("Need trust level: " + trustReq, "dim");
    return;
  }

  // No-lock locations should not require a breach. Treat them as open once requirements are met.
  if (!state.unlocked.has(locName) && Array.isArray(loc.locks) && loc.locks.length === 0) {
    state.unlocked.add(locName);
  }

  if (!state.unlocked.has(locName)) {
    if (autoBreach) {
      startBreach(locName);
      return;
    }
    writeLine("Access denied. Use breach to solve the lock stack.", "warn");
    writeLine(`Tip: breach ${locName}  (or: connect ${locName} --breach)`, "dim");
    return;
  }

  state.loc = locName;
  showLoc();
  RegionManager.enterRegionByNode(locName);
  triggerNarrativeStepForLoc(locName);
  if (locName === "trust.anchor" && trustHeat() >= TRUST_HEAT_THRESHOLD - 1) {
    storyProgressEvent("trust_anchor_heat");
  }
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

function getLocFileEntry(locName, fileName) {
  const loc = getLoc(locName);
  const key = String(fileName || "").trim();
  if (!loc || !loc.files || !key) return null;

  // Exact match first.
  if (loc.files[key]) return { name: key, entry: loc.files[key] };

  // Case-insensitive fallback (helps with user scripts that reference older casing).
  const lower = key.toLowerCase();
  const found = Object.keys(loc.files).find((k) => k.toLowerCase() === lower);
  if (!found) return null;
  return { name: found, entry: loc.files[found] };
}

function getLocFileText(locName, fileName) {
  const found = getLocFileEntry(locName, fileName);
  if (!found) return null;
  const entry = found.entry;
  if (typeof entry.content === "string") return entry.content;
  return String(entry.content || "");
}

function readAnyText(ref) {
  const drive = getDriveEntry(ref);
  if (drive) return String(drive.content || "");
  const found = getLocFileEntry(state.loc, ref);
  if (!found) return null;
  const entry = found.entry;
  if (typeof entry.content === "string") return entry.content;
  return String(entry.content || "");
}

function extractScriptFromTemplateText(text) {
  const raw = String(text || "").replace(/\uFEFF/g, "");
  const lines = raw.split("\n");
  const start = lines.findIndex((l) =>
    /^\s*(\/\/\s*@sec\b|const\b|let\b|var\b|function\b|if\b|for\b|while\b|ctx\.|\/\*|return\b)/i.test(
      l
    )
  );
  if (start === -1) return raw;
  let out = lines.slice(start).join("\n");
  if (!/@sec\s+(FULLSEC|HIGHSEC|MIDSEC|LOWSEC|NULLSEC)/i.test(out)) {
    out = "// @sec FULLSEC\n" + out;
  }
  return out;
}

function setEditor(name, options) {
  const opts = options || {};
  const prefill = typeof opts.prefill === "string" ? opts.prefill : null;
  const mode = opts.mode === "drive" ? "drive" : "script";
  const driveIdRef = mode === "drive" ? String(opts.driveId || "").trim() : null;
  state.editor = { name, mode, driveId: driveIdRef, lines: prefill ? String(prefill).split("\n") : [] };
  writeLine("EDITOR MODE :: type :wq to save, :q to abort", "warn");
  if (mode === "drive") {
    writeLine(`Editing drive:${driveIdRef || name}`, "dim");
    writeLine("Editor cmds: :p (print), :d N (delete), :r N <text> (replace)", "dim");
    writeLine("            :i N <text> (insert), :a N <text> (append), :clear", "dim");
    return;
  }
  writeLine(`Editing ${state.handle}.${name}`, "dim");
  writeLine("Tip: add `// @sec FULLSEC|HIGHSEC|MIDSEC|LOWSEC|NULLSEC`", "dim");
  writeLine("Editor cmds: :p (print), :d N (delete), :r N <text> (replace)", "dim");
  if (prefill) writeLine("Loaded content. Edit, then `:wq`.", "dim");
}

function finishEditor(save) {
  const editor = state.editor;
  state.editor = null;
  if (!save) {
    writeLine("Editor aborted.", "warn");
    return;
  }
  const normalizedLines = (editor.lines || []).map((line) => {
    const raw = String(line || "")
      .replace(/\uFEFF/g, "")
      .replace(/\r/g, "");
    // If the user types "@sec FULLSEC" without the comment prefix, auto-fix it.
    const m = raw.match(/^\s*@sec\s+(FULLSEC|HIGHSEC|MIDSEC|LOWSEC|NULLSEC)\s*$/i);
    if (m) return `// @sec ${m[1].toUpperCase()}`;
    return raw;
  });
  const outText = normalizedLines.join("\n");

  if (editor.mode === "drive") {
    const id = String(editor.driveId || "").trim();
    if (!id) {
      writeLine("Editor error: missing drive target.", "error");
      return;
    }
    const res = updateDriveContent(id, outText, { type: "text" });
    if (!res.ok) {
      if (res.reason === "full") {
        writeLine("Drive full (edit not saved).", "error");
        writeLine("Tip: delete files with `del loc/file` or buy `upg.drive_ext`.", "dim");
        return;
      }
      writeLine("Drive edit failed.", "error");
      return;
    }
    writeLine(`Saved ${driveRef(id)} (${formatBytesShort(res.bytes)})`, "ok");
    trackRecentFile(driveRef(id));
    markDirty();
    return;
  }

  const code = outText;
  if (!code.trim()) {
    writeLine("Nothing to save (script empty).", "warn");
    writeLine("Tip: `edit " + editor.name + "` then paste code; multi-line paste is supported.", "dim");
    return;
  }
  const match = code.match(/@sec\s+(FULLSEC|HIGHSEC|MIDSEC|LOWSEC|NULLSEC)/i);
  const sec = match ? match[1].toUpperCase() : "FULLSEC";
  state.userScripts[editor.name] = { owner: state.handle, name: editor.name, sec, code };
  writeLine(`Saved ${state.handle}.${editor.name} [${sec}]`, "ok");
  // Mirror local script into drive so size matters.
  const mirrored = storeDriveCopy("local", `${state.handle}.${editor.name}.s`, {
    type: "script",
    script: { name: editor.name, sec, code },
  });
  void mirrorUserScriptToLocalFolder(editor.name, code);
  if (!mirrored.ok) {
    writeLine("sys::drive full (script not mirrored)", "warn");
    writeLine("Tip: buy/install `upg.drive_ext` or delete with `del drive:...`", "dim");
  }
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
    recent: state.recent,
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
    localSync: state.localSync,
    trust: state.trust,
    region: {
      current: state.region && state.region.current ? state.region.current : null,
      unlocked: Array.from((state.region && state.region.unlocked) || []),
      visited: Array.from((state.region && state.region.visited) || []),
      pending: Array.from((state.region && state.region.pending) || []),
    },
    currentRegion: state.currentRegion || (state.region && state.region.current) || null,
    storyState: {
      current: state.storyState && state.storyState.current ? state.storyState.current : "island_intro",
      completed: Array.from((state.storyState && state.storyState.completed) || []),
      beats: Array.from((state.storyState && state.storyState.beats) || []),
      flags: Array.from((state.storyState && state.storyState.flags) || []),
      failed: Array.from((state.storyState && state.storyState.failed) || []),
    },
    rogueProfile: {
      noise: state.rogueProfile ? state.rogueProfile.noise || 0 : 0,
      careful: state.rogueProfile ? state.rogueProfile.careful || 0 : 0,
      brute: state.rogueProfile ? state.rogueProfile.brute || 0 : 0,
      failures: state.rogueProfile ? state.rogueProfile.failures || 0 : 0,
      outcomes: Array.from((state.rogueProfile && state.rogueProfile.outcomes) || []),
    },
    behaviorProfile: {
      noise: state.behaviorProfile ? state.behaviorProfile.noise || 0 : 0,
      careful: state.behaviorProfile ? state.behaviorProfile.careful || 0 : 0,
      aggressive: state.behaviorProfile ? state.behaviorProfile.aggressive || 0 : 0,
      patient: state.behaviorProfile ? state.behaviorProfile.patient || 0 : 0,
    },
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
  const hasRegionData = !!(data.region && typeof data.region === "object");
  state.handle = data.handle;
  state.loc = data.loc || "home.hub";
  state.gc = data.gc ?? 0;
  state.discovered = new Set(data.discovered || []);
  state.unlocked = new Set(data.unlocked || []);
  state.inventory = new Set(data.inventory || []);
  state.drive = data.drive && typeof data.drive === "object" ? data.drive : {};
  state.recent =
    data.recent && typeof data.recent === "object"
      ? {
          locs: Array.isArray(data.recent.locs) ? data.recent.locs.filter((e) => e && typeof e.v === "string") : [],
          files: Array.isArray(data.recent.files) ? data.recent.files.filter((e) => e && typeof e.v === "string") : [],
        }
      : { locs: [], files: [] };
  state.kit = data.kit || {};
  state.userScripts = data.userScripts || {};
  state.uploads = data.uploads && typeof data.uploads === "object" ? data.uploads : {};
  state.flags = new Set(data.flags || []);
  if (!hasRegionData) state.flags.add("region_legacy_backfill");
  state.marks = new Set(data.marks || []);
  state.upgrades = new Set(data.upgrades || []);
  state.driveMax = Math.min(
    DRIVE_MAX_CAP_BYTES,
    Number(data.driveMax) > 0 ? Number(data.driveMax) : state.driveMax || 12_000
  );
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
  state.localSync =
    data.localSync && typeof data.localSync === "object"
      ? { mirror: !!data.localSync.mirror }
      : state.localSync || { mirror: false };
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
  state.trust =
    data.trust && typeof data.trust === "object"
      ? {
          level: Math.max(TRUST_MIN_LEVEL, Math.min(TRUST_MAX_LEVEL, Number(data.trust.level) || 2)),
          heat: Math.max(0, Number(data.trust.heat) || 0),
          lastScanAt: Number(data.trust.lastScanAt) || 0,
        }
      : { level: 2, heat: 0, lastScanAt: 0 };
  state.region =
    data.region && typeof data.region === "object"
      ? {
          current: data.region.current || null,
          unlocked: new Set(data.region.unlocked || []),
          visited: new Set(data.region.visited || []),
          pending: new Set(data.region.pending || []),
        }
      : state.region || { current: null, unlocked: new Set(), visited: new Set(), pending: new Set() };
  state.currentRegion = data.currentRegion || (state.region && state.region.current) || null;
  state.storyState =
    data.storyState && typeof data.storyState === "object"
      ? {
          current: data.storyState.current || "island_intro",
          completed: new Set(data.storyState.completed || []),
          beats: new Set(data.storyState.beats || []),
          flags: new Set(data.storyState.flags || []),
          failed: new Set(data.storyState.failed || []),
        }
      : state.storyState || { current: "island_intro", completed: new Set(), beats: new Set(), flags: new Set(), failed: new Set() };
  state.rogueProfile =
    data.rogueProfile && typeof data.rogueProfile === "object"
      ? {
          noise: Number(data.rogueProfile.noise) || 0,
          careful: Number(data.rogueProfile.careful) || 0,
          brute: Number(data.rogueProfile.brute) || 0,
          failures: Number(data.rogueProfile.failures) || 0,
          outcomes: new Set(data.rogueProfile.outcomes || []),
        }
      : state.rogueProfile || { noise: 0, careful: 0, brute: 0, failures: 0, outcomes: new Set() };
  state.behaviorProfile =
    data.behaviorProfile && typeof data.behaviorProfile === "object"
      ? {
          noise: Number(data.behaviorProfile.noise) || 0,
          careful: Number(data.behaviorProfile.careful) || 0,
          aggressive: Number(data.behaviorProfile.aggressive) || 0,
          patient: Number(data.behaviorProfile.patient) || 0,
        }
      : state.behaviorProfile || { noise: 0, careful: 0, aggressive: 0, patient: 0 };
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
  // Ensure new narrative nodes stay visible on older saves.
  state.discovered.add("island.grid");
  state.unlocked.add("island.grid");
  state.discovered.add("trust.anchor");
  state.unlocked.add("trust.anchor");
  RegionManager.bootstrap({ silent: true });
  validateGlitchChant();
  ensureStoryState();
  if (!state.rogueProfile || typeof state.rogueProfile !== "object") {
    state.rogueProfile = { noise: 0, careful: 0, brute: 0, failures: 0, outcomes: new Set() };
  }
  // scratchpad is user-authored; don't clear on load
  if (!opts.silent) writeLine("State loaded.", "ok");
  ensureDriveBackfill({ silent: true });
  applyCorruptionClasses();
  showLoc();
  RegionManager.enterRegionByNode(state.loc);
  storyChatTick();
  tutorialAdvance();
  ensureSiphonLoop();
  void refreshLocalFolderUi();
  void backfillLocalFolderFromDrive({ silent: true, prompt: false });
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

  if (state.discovered.has("deep.slate") && !state.flags.has("q_cinder_done")) {
    const ready = state.inventory.has("cinder.token");
    jobs.push({
      id: "cinder",
      npc: "archivist",
      title: "Cinder Recovery",
      status: ready ? "[READY]" : "[ACTIVE]",
      detail:
        "Descend: `connect deep.slate` -> run phase.s -> `breach trench.node` -> forge `cinder.token` with mix.s, then clear `cinder.core`.",
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
  RegionManager.bootstrap({ silent: true });
  const lockedRegions = REGION_DEFS.filter((def) => !state.region.unlocked.has(def.id));
  if (lockedRegions.length) {
    writeLine("Regions:", "header");
    lockedRegions.forEach((def) => {
      const gate = RegionManager.canAccessNode(def.nodes[0] || "") || {};
      writeLine(`${def.name} [LOCKED]`, "warn");
      if (gate.hint) writeLine("  gate: " + gate.hint, "dim");
    });
  } else {
    writeLine("All regions open.", "dim");
  }
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
      if (req.missingTrust) need.push("trust lvl: " + req.missingTrust);
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

  // Allow slash-prefixed chat commands from the terminal (e.g. /tell, /join, /help).
  if (trimmed.startsWith("/")) {
    handleChatLine(trimmed);
    return;
  }

  if (state.editor) {
    const t = trimmed;
    if (t.startsWith(":")) {
      const cmdLine = t.slice(1).trim();
      const parts = cmdLine.length ? splitArgs(cmdLine) : [];
      const ecmd = (parts[0] || "").toLowerCase();
      const arg1 = parts[1];
      const rest = parts.slice(2).join(" ");

      const printBuf = () => {
        const lines = state.editor.lines || [];
        writeLine("EDITOR BUFFER", "header");
        if (!lines.length) {
          writeLine("(empty)", "dim");
          return;
        }
        const show = lines.slice(0, 60);
        show.forEach((line, idx) => {
          const n = String(idx + 1).padStart(3, "0");
          writeLine(`${n}  ${line}`, "dim");
        });
        if (lines.length > show.length) writeLine("...", "dim");
      };

      const parseLineNo = (token) => {
        const n = Number(token);
        if (!Number.isFinite(n)) return null;
        const i = Math.floor(n) - 1;
        if (i < 0) return null;
        return i;
      };

      if (ecmd === "q") {
        finishEditor(false);
        updateHud();
        return;
      }
      if (ecmd === "wq") {
        finishEditor(true);
        updateHud();
        return;
      }
      if (ecmd === "" || ecmd === "help") {
        writeLine("EDITOR CMDS", "header");
        writeLine(":p               (print buffer w/ line numbers)", "dim");
        writeLine(":d N             (delete line N)", "dim");
        writeLine(":r N <text>      (replace line N)", "dim");
        writeLine(":i N <text>      (insert before line N)", "dim");
        writeLine(":a N <text>      (append after line N)", "dim");
        writeLine(":clear           (clear buffer)", "dim");
        writeLine(":wq / :q         (save / abort)", "dim");
        return;
      }
      if (ecmd === "p" || ecmd === "ls" || ecmd === "print") {
        printBuf();
        return;
      }
      if (ecmd === "clear") {
        state.editor.lines = [];
        writeLine("Editor buffer cleared.", "warn");
        return;
      }
      if (ecmd === "d") {
        const i = parseLineNo(arg1);
        if (i === null) {
          writeLine("Usage: :d N", "warn");
          return;
        }
        if (i >= state.editor.lines.length) {
          writeLine("Line out of range.", "warn");
          return;
        }
        state.editor.lines.splice(i, 1);
        writeLine(`Deleted line ${i + 1}.`, "ok");
        return;
      }
      if (ecmd === "r") {
        const i = parseLineNo(arg1);
        if (i === null) {
          writeLine("Usage: :r N <text>", "warn");
          return;
        }
        if (i >= state.editor.lines.length) {
          writeLine("Line out of range.", "warn");
          return;
        }
        state.editor.lines[i] = parts.slice(2).join(" ");
        writeLine(`Replaced line ${i + 1}.`, "ok");
        return;
      }
      if (ecmd === "i") {
        const i = parseLineNo(arg1);
        if (i === null) {
          writeLine("Usage: :i N <text>", "warn");
          return;
        }
        const textToInsert = parts.slice(2).join(" ");
        state.editor.lines.splice(Math.min(i, state.editor.lines.length), 0, textToInsert);
        writeLine(`Inserted before line ${i + 1}.`, "ok");
        return;
      }
      if (ecmd === "a") {
        const i = parseLineNo(arg1);
        if (i === null) {
          writeLine("Usage: :a N <text>", "warn");
          return;
        }
        const textToInsert = parts.slice(2).join(" ");
        const at = Math.min(i + 1, state.editor.lines.length);
        state.editor.lines.splice(at, 0, textToInsert);
        writeLine(`Appended after line ${i + 1}.`, "ok");
        return;
      }

      writeLine("Unknown editor cmd. Type :help", "warn");
      return;
    }

    // Default: append raw line as-is.
    state.editor.lines.push(raw);
    return;
  }

  if (!state.handle) {
    if (trimmed.toLowerCase() === "load") {
      loadState();
      updateHud();
      return;
    }
    const handle = trimmed;
    if (!handle) {
      writeLine("Handle cannot be blank.", "warn");
      writeLine("Example: ares_01", "dim");
      return;
    }
    if (handle.length < 4) {
      writeLine("Handle too short (min 4).", "warn");
      writeLine("Example: ares_01", "dim");
      return;
    }
    if (!/^[A-Za-z0-9_]+$/.test(handle)) {
      writeLine("Handle must be letters/numbers/underscore only.", "warn");
      writeLine("Example: ares_01", "dim");
      return;
    }
    state.handle = handle;
    writeLine(`HANDLE SET: ${state.handle}`, "ok");
    chatPost({ channel: state.chat.channel, from: "sys", body: `*** ${state.handle} connected`, kind: "system" });
    loadScratchFromStorage();
    RegionManager.bootstrap({ silent: true });
    showLoc();
    RegionManager.enterRegionByNode(state.loc);
    storyChatTick();
    tutorialPrint();
    updateHud();
    ensureAutosaveLoop();
    ensureSiphonLoop();
    ensureDriveBackfill({ silent: true });
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
        const topic = args[0];
        const wantsArgs = args[1] === "?";
        helpPrintTopic(topic, wantsArgs);
      } else {
        helpPrintIndex();
      }
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
        if (/^drive:/i.test(name)) {
          const id = String(name).replace(/^drive:/i, "").trim();
          if (!id || !id.includes("/")) {
            writeLine("Usage: edit drive:<loc>/<file>", "warn");
            break;
          }
          const existing = getDriveEntry(name);
          const prefill = existing ? String(existing.content || "") : "";
          setEditor(id, { mode: "drive", driveId: existing ? existing.id : id, prefill });
          break;
        }

        let from = null;
        let example = false;
        for (let i = 1; i < args.length; i++) {
          const a = String(args[i] || "");
          if (a === "--example") example = true;
          if (a === "--from" && args[i + 1]) {
            from = String(args[i + 1]);
            i += 1;
          }
          if (a.startsWith("--from=")) from = a.slice("--from=".length);
        }

        const existingScript =
          state.userScripts && state.userScripts[name] && typeof state.userScripts[name].code === "string"
            ? String(state.userScripts[name].code)
            : null;

        const template = example
          ? CHK_TEMPLATE_CODE
          : from
            ? readAnyText(from) || getLocFileText("home.hub", from)
            : existingScript;
        if (!example && from && !template) {
          writeLine("Template not found.", "warn");
          writeLine("Tip: at home.hub: `cat chk.example`", "dim");
          setEditor(name);
          break;
        }
        const prefill = template ? extractScriptFromTemplateText(template) : null;
        setEditor(name, prefill ? { prefill } : undefined);
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
      connectLoc(args[0], { autoBreach: flags.has("--breach") });
      storyChatTick();
      tutorialNextHint();
      break;
    case "disconnect":
    case "dc": {
      // Fast drop back to home.hub. Useful to dodge timed pulses (e.g. core.relic pressure).
      if (state.breach && state.breach.pressure) {
        try {
          window.clearInterval(state.breach.pressure);
        } catch {}
      }
      state.breach = null;

      // Dropping the link cancels downloads (no fines; just lost progress).
      try {
        if (state.downloads && state.downloads.active) {
          if (state.downloads.active.tick) window.clearInterval(state.downloads.active.tick);
          if (state.downloads.active.timer) window.clearTimeout(state.downloads.active.timer);
        }
      } catch {}
      const hadDownloads =
        !!(state.downloads && (state.downloads.active || (state.downloads.queue && state.downloads.queue.length)));
      state.downloads = { active: null, queue: [] };

      if (state.loc !== "home.hub") {
        state.loc = "home.hub";
        writeLine("CONNECTION DROPPED. ROUTING HOME.", "warn");
        showLoc();
      } else {
        writeLine("Already at home.hub.", "dim");
      }
      if (hadDownloads) writeLine("downloads canceled", "dim");
      updateHud();
      markDirty();
      break;
    }
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
      driveCommand(args);
      break;
    case "folder": {
      const sub = String(args[0] || "").toLowerCase();
      if (!sub || sub === "status") {
        reportLocalFolderStatus();
        break;
      }
      if (sub === "pick") {
        pickLocalFolder();
        break;
      }
      if (sub === "sync") {
        syncLocalFolder();
        break;
      }
      if (sub === "forget") {
        forgetLocalFolder();
        break;
      }
      if (sub === "mirror") {
        const flag = String(args[1] || "").toLowerCase();
        if (!flag) {
          writeLine(`Mirror downloads: ${state.localSync && state.localSync.mirror ? "on" : "off"}`, "dim");
          break;
        }
      if (!["on", "off"].includes(flag)) {
        writeLine("Usage: folder mirror on|off", "warn");
        break;
      }
      if (!state.localSync) state.localSync = { mirror: false };
      state.localSync.mirror = flag === "on";
      writeLine(`Local mirror ${state.localSync.mirror ? "enabled" : "disabled"}.`, "ok");
      markDirty();
      refreshLocalFolderUi();
      ensureLocalSyncPoll();
      break;
    }
      writeLine("Usage: folder pick|status|sync|mirror on|off|forget", "warn");
      break;
    }
    case "history":
      listHistory(args);
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
    case "regions":
      RegionManager.describeRegions();
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
      if (args[0] === "intro" || args[0] === "brief") {
        printOperatorBrief();
      } else if (args[0] === "off") tutorialSetEnabled(false);
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
    case "trust":
      printTrustStatus();
      break;
    case "status":
      printTrustStatus({ concise: true });
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
      localStorage.removeItem(BRIEF_SEEN_KEY);
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
      if (state.handle) writeLine(`sys::disconnect ${state.handle}`, "dim");
      localStorage.removeItem(SAVE_KEY);
      localStorage.removeItem(BRIEF_SEEN_KEY);
      screen.innerHTML = "";
      resetToFreshState(false);
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
  // Any non-Tab interaction cancels completion cycling.
  if (event.key !== "Tab") clearTabState();

  if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();

    const raw = input.value;
    // Always clear immediately so the box empties even if command handling errors.
    input.value = "";
    submitTerminalCommand(raw);
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
    completeInput({ direction: event.shiftKey ? -1 : 1 });
  }
});

// In editor mode, allow multi-line paste: split clipboard text into lines.
input.addEventListener("paste", (event) => {
  if (!state.editor) return;
  const text = event.clipboardData ? event.clipboardData.getData("text") : "";
  if (!text) return;
  event.preventDefault();
  event.stopPropagation();

  const lines = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  lines.forEach((line) => state.editor.lines.push(line));
  input.value = "";
  writeLine(`pasted ${lines.length} line(s) into editor`, "dim");
});

// Don't steal focus when users are selecting/copying text from the terminal/chat.
let selectingText = false;
function hasTextSelection() {
  try {
    const sel = window.getSelection && window.getSelection();
    return !!(sel && String(sel.toString() || "").length);
  } catch {
    return false;
  }
}

document.addEventListener("mousedown", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (
    target.closest("#screen") ||
    target.closest("#chat") ||
    target.closest("#scratch") ||
    target.closest("#right")
  ) {
    selectingText = true;
  }
});
document.addEventListener("mouseup", () => {
  // Clear on next tick so click handlers can observe selection state.
  window.setTimeout(() => {
    selectingText = false;
  }, 0);
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  // If the user is selecting text (or has a selection), don't fight them.
  if (selectingText || hasTextSelection()) return;

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
});
setTimeout(() => input.focus(), 0);

const SAFE_SHIFT_RUN_CMDS = new Set([
  "help",
  "tutorial",
  "scan",
  "probe",
  "connect",
  "dc",
  "disconnect",
  "ls",
  "cat",
  "downloads",
  "drive",
  "history",
  "scripts",
  "contacts",
  "channels",
  "join",
  "switch",
  "tell",
  "say",
]);

function cmdHead(cmd) {
  return String(cmd || "")
    .trim()
    .split(/\s+/, 1)[0]
    .toLowerCase();
}

function insertIntoCmdInput(command) {
  input.value = String(command || "");
  try {
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  } catch {}
}

// Command chips in tutorial output.
screen.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const btn = target.closest("button.cmd-chip");
  if (!btn) return;
  const cmd = btn.getAttribute("data-cmd") || "";
  if (!cmd.trim()) return;

  if (event.shiftKey) {
    const head = cmdHead(cmd);
    if (!SAFE_SHIFT_RUN_CMDS.has(head)) {
      writeLine("Tip: chip inserted (Shift-run disabled for this command).", "dim");
      insertIntoCmdInput(cmd);
      return;
    }
    submitTerminalCommand(cmd);
    return;
  }

  insertIntoCmdInput(cmd);
});

if (chatInput) {
  chatInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();

    const raw = chatInput.value;
    // Always clear the box on Enter (even if the command is invalid).
    chatInput.value = "";
    handleChatLine(raw);
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
    "disconnect",
    "dc",
    "breach",
    "unlock",
    "ls",
    "cat",
    "download",
    "downloads",
    "drive",
    "folder",
    "history",
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

let tabState = null;
function clearTabState() {
  tabState = null;
}

function completeInput({ direction = 1 } = {}) {
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
  } else if (cmd === "drive") {
    candidates = ["ls", "flat"];
  } else if (cmd === "folder") {
    candidates = ["pick", "status", "sync", "mirror", "forget"];
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

  // Avoid dumping huge option lists when tabbing with no prefix.
  if (!token) {
    clearTabState();
    return;
  }

  const contextKey = [
    before.slice(0, tokenStart).toLowerCase(),
    after.toLowerCase(),
    String(cmd || "").toLowerCase(),
  ].join("\u0000");

  // If we're already cycling in this context, rotate regardless of the current token
  // (because the token will be replaced by a full candidate on the first Tab press).
  if (
    tabState &&
    tabState.contextKey === contextKey &&
    tabState.tokenStart === tokenStart &&
    Array.isArray(tabState.candidates) &&
    tabState.candidates.length > 1 &&
    tabState.candidates.some((c) => String(c).toLowerCase() === token.toLowerCase())
  ) {
    const len = tabState.candidates.length;
    const delta = direction < 0 ? -1 : 1;
    tabState.index = (tabState.index + delta + len) % len;
    const pick = tabState.candidates[tabState.index];
    input.value = before.slice(0, tokenStart) + pick + after;
    const newCursor = tokenStart + pick.length;
    input.setSelectionRange(newCursor, newCursor);
    return;
  }

  const filtered = candidates.filter((c) => c.toLowerCase().startsWith(token.toLowerCase()));
  if (!filtered.length) {
    clearTabState();
    return;
  }
  if (filtered.length === 1) {
    const next = filtered[0];
    input.value = before.slice(0, tokenStart) + next + after;
    const newCursor = tokenStart + next.length;
    input.setSelectionRange(newCursor, newCursor);
    clearTabState();
    return;
  }

  // Multiple matches: cycle through candidates by priority/order.
  // First Tab completes to the first candidate, next Tabs rotate (Shift+Tab reverses).
  const normalized = filtered.map((c) => String(c));
  const canReuse =
    tabState &&
    tabState.contextKey === contextKey &&
    tabState.tokenStart === tokenStart &&
    Array.isArray(tabState.candidates) &&
    tabState.candidates.length === normalized.length &&
    tabState.candidates.every((c, i) => c === normalized[i]);

  if (!canReuse) {
    tabState = {
      contextKey,
      tokenStart,
      candidates: normalized,
      index: 0,
    };
  } else {
    const len = tabState.candidates.length;
    const delta = direction < 0 ? -1 : 1;
    tabState.index = (tabState.index + delta + len) % len;
  }

  const pick = tabState.candidates[tabState.index];
  input.value = before.slice(0, tokenStart) + pick + after;
  const newCursor = tokenStart + pick.length;
  input.setSelectionRange(newCursor, newCursor);
}

function boot() {
  hookUi();
  void initLocalFolder();
  ensureAutosaveLoop();
  renderChat();

  const hasSave = !!(localStorage.getItem(SAVE_KEY) || localStorage.getItem(LEGACY_SAVE_KEY));
  const bootMs = runBootSequence({ hasSave });

  // Chat boot message (always), then restore indicator if applicable.
  chatSystemTransient("chat initializing...", 900);

  window.setTimeout(() => {
    if (!loadState({ silent: true })) {
      // First-run brief (once per fresh save).
      if (!localStorage.getItem(BRIEF_SEEN_KEY)) {
        printOperatorBrief();
        localStorage.setItem(BRIEF_SEEN_KEY, "1");
      }
      writeLine("Enter a handle to begin.", "dim");
      writeLine("Min 4 chars, letters/numbers/underscore. Example: ares_01", "dim");
      writeLine("Tip: type `help` for examples, or `tutorial` to reprint steps.", "dim");
      loadScratchFromStorage();
      tutorialAdvance();
      chatSystem("new session ready");
    } else {
      writeLine("Auto-loaded save.", "ok");
      writeLine("Tip: type `restart --confirm` to start over.", "dim");
      tutorialAdvance();
      chatSystemTransient("restoring session...", 1200);
    }
    ensureDriveBackfill({ silent: true });
    ensureSiphonLoop();
    updateHud();
  }, Math.max(0, (bootMs || 2200) + 150));
}

boot();
function applyEscalationTextEffects(text) {
  // Single entry point for corruption. Only use GLITCH_GLYPH, keep lines readable,
  // and only when regions/content expect it. This avoids global noise and keeps
  // glyph use thematic.
  const raw = String(text || "");
  if (!corruptionAllowed(raw)) return raw;

  const trace = state.trace || 0;
  const corruption = corruptionLevel();
  const region = state.region && state.region.current;
  const severeRegion = region === "secureCore" || region === "cinderDepth";

  // Intensity capped to ~25% of characters so lines stay readable.
  const ratio = Math.min(0.25, corruption * 0.06 + trace * 0.04 + (severeRegion ? 0.05 : 0));
  if (ratio <= 0) return raw;

  // Deterministic mask per-line: avoids jittery randomness and keeps corruption stable.
  const chars = raw.split("");
  let hash = 0;
  for (let i = 0; i < chars.length; i++) hash = (hash + chars[i].charCodeAt(0) * (i + 1)) % 9973;
  const max = Math.max(1, Math.floor(chars.length * ratio));
  const step = Math.max(3, Math.floor(chars.length / max));
  let replaced = 0;
  for (let i = 0; i < chars.length && replaced < max; i++) {
    const c = chars[i];
    if (!/[A-Za-z0-9]/.test(c)) continue;
    if ((i + hash) % step === 0) {
      chars[i] = GLITCH_GLYPH;
      replaced += 1;
    }
  }
  return chars.join("");
}

function corruptionAllowed(text) {
  // Whitelist: never corrupt core clarity output.
  const cleanSnippets = [
    "Usage:",
    "Command error",
    "already",
    "not found",
    "missing",
    "trust state",
    "help",
    "LOCATIONS",
    "TRUST STATE",
  ];
  const lower = String(text || "").toLowerCase();
  if (cleanSnippets.some((s) => lower.includes(s.toLowerCase()))) return false;

  // Region gating: only glitch in severe regions or corrupted/glitch content.
  const loc = state.loc || "";
  const region = state.region && state.region.current;
  const allowedRegions = new Set(["secureCore", "cinderDepth"]);
  const severeRegion = allowedRegions.has(region);
  const corruptedLocs = new Set(["rogue.core", "core.relic", "glitch.cache", "slipper.hole", "deep.slate", "trench.node", "cinder.core"]);

  const hasGlyph = String(text || "").includes(GLITCH_GLYPH);
  const looksGlitch = /fragment\.|glitch|rogue|corrupt/i.test(text || "");

  // Only allow corruption when the content is explicitly corrupted OR the region is marked severe.
  if (corruptedLocs.has(loc)) return true;
  if (looksGlitch || hasGlyph) return true; // e.g., glitch fragments/logs anywhere.
  if (severeRegion && (loc === "core.relic" || loc === "rogue.core")) return true;
  if (severeRegion) return true;
  return false; // Early regions stay clean.
}

// Look for user reconstruction attempts of the glitch chant via scratchpad or drive text.
function findChantAttempt() {
  const attempts = [];
  try {
    if (scratchPad && scratchPad.value) {
      scratchPad.value
        .split("\n")
        .map((l) => l.trim().toUpperCase())
        .filter((l) => l.includes("THREAD"))
        .forEach((l) => attempts.push(l));
    }
  } catch {}

  Object.keys(state.drive || {}).forEach((id) => {
    const entry = state.drive[id];
    if (!entry || typeof entry.content !== "string") return;
    const lines = String(entry.content || "")
      .split("\n")
      .map((l) => l.trim().toUpperCase())
      .filter((l) => l.includes("THREAD"));
    attempts.push(...lines);
  });

  // Return the first candidate; existence alone triggers near-miss behavior to keep mystery intact.
  return attempts.find((a) => a) || null;
}

// Adaptive intro for rogue.core: tone depends on prior play (noise vs careful vs brute).
function rogueCoreAdaptiveIntro() {
  if (state.flags.has("rogue_intro_done")) return;
  state.flags.add("rogue_intro_done");
  const rp = state.rogueProfile || { noise: 0, careful: 0, brute: 0 };
  const noisy = rp.noise > rp.careful;
  const brute = rp.brute > rp.careful;
  chatPost({
    channel: "#kernel",
    from: "archivist",
    body: noisy
      ? "Rogue sniffed your noise. It adapts to repetition. Move with intent."
      : "Rogue listens. Trust steady, chant whole, checksum ready. Do not rush.",
  });
  if (brute) chatPost({ channel: "#kernel", from: "rogue", body: "...pattern detected. adjusting..." });
}

// Profiling: rogue core leans into the player's observed cadence without new meters.
function rogueCoreProfiledPressure() {
  const rp = state.rogueProfile || { noise: 0, careful: 0, brute: 0 };
  const noiseTilt = (rp.noise || 0) + (rp.brute || 0);
  const calmTilt = rp.careful || 0;
  if (noiseTilt > calmTilt + 1 && state.trace < state.traceMax) {
    state.trace = Math.min(state.traceMax, (state.trace || 0) + 1);
    chatPost({ channel: "#kernel", from: "rogue", body: "trace warmed; your echo is predictable." });
  } else if (calmTilt >= noiseTilt && state.trace > 0) {
    state.trace = Math.max(0, (state.trace || 0) - 1);
    chatPost({ channel: "#kernel", from: "rogue", body: "waiting alters the pattern. pressure eases... slightly." });
  }
}
