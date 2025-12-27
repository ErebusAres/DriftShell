#!/usr/bin/env python3
import base64
import json
import os
import shlex
import sys
import textwrap
import codecs

WIDTH = 78
SAVE_PATH = os.path.join(os.path.dirname(__file__), "save.json")


def block(text):
    return textwrap.dedent(text).strip("\n")


def render(text):
    lines = []
    for para in text.split("\n"):
        if para.strip() == "":
            lines.append("")
        else:
            lines.append(textwrap.fill(para.strip(), width=WIDTH))
    return "\n".join(lines)


def show(text=""):
    if text is None:
        return
    if text == "":
        print()
        return
    print(render(text))


ITEMS = {
    "badge.sig": "Perimeter badge signature",
    "mask.dat": "Spoofed access mask",
    "weaver.mark": "Weaver guild mark",
    "token.key": "Spliced lattice token",
    "relay.shard": "Corporate relay shard",
    "relic.key": "Core relic key",
}

SCRIPTS = {
    "tracer": "Map the perimeter mesh",
    "spoof": "Mint a mask signature",
    "fork": "Split a relay channel to the core",
    "sniffer": "Sweep for hidden signals",
    "splice": "Forge a lattice token",
    "ghost": "Mask the audit trail",
}

NODES = {
    "hub.home": {
        "title": "HUB/HOME",
        "desc": block("""
            A sterile hub and a dead net outside the glass.
            The prompt waits. The drift is quiet tonight.
        """),
        "entry": {"items": [], "flags": []},
        "links": ["market.node", "perimeter.gate"],
        "files": {
            "readme.txt": {
                "type": "text",
                "content": block("""
                    HACKTERM//BOOTSTRAP
                    This shell simulates a dead net for training and salvage.

                    Commands:
                      scan              list discovered nodes
                      connect <node>    jump to a node
                      ls                list files in the node
                      cat <file>        read a file
                      download <file>   take a script or item
                      run <script>      execute a script in your kit
                      decode rot13|b64  decode the last cipher you read
                      inventory         list your scripts and items
                      log               review your activity
                      home              return to hub
                      save              write a save file
                      load              load save file
                """),
            },
            "message.txt": {
                "type": "text",
                "content": block("""
                    FROM: SWITCHBOARD
                    SUBJ: ember signal

                    We caught a pulse in the Drift. It points at the Sable Archive.
                    Follow the ember. Bring back what you can. Decide if it should
                    leave the net or stay buried.

                    Start by mapping the edge with tracer.s.
                    Then sweep for hidden signals with sniffer.s.
                """),
            },
            "tracer.s": {
                "type": "script",
                "script_id": "tracer",
                "downloadable": True,
                "content": block("""
                    /* tracer.s */
                    function main() {
                      // Map the perimeter mesh and expose reachable nodes.
                      // Output is cached to your local scan results.
                    }
                """),
            },
        },
    },
    "market.node": {
        "title": "SCRAP EXCHANGE",
        "desc": block("""
            A low signal bazaar built from scavenged hardware.
            Deals are cheap. Trust is not.
        """),
        "entry": {"items": [], "flags": ["trace_open"]},
        "links": ["hub.home", "perimeter.gate", "weaver.den"],
        "files": {
            "stall.log": {
                "type": "text",
                "content": block("""
                    SCRAP EXCHANGE LOG
                    Juniper keeps a mask routine in plain sight. Run spoof.s to mint
                    a mask.dat. The perimeter gate will not open without a badge
                    and a mask.
                """),
            },
            "rumor.txt": {
                "type": "text",
                "content": block("""
                    RUMOR SLIP
                    There's a quiet band with a Weaver den and a corp audit node.
                    Sniffer pulses can spot them. Pull sniffer.s and sweep.
                """),
            },
            "sniffer.s": {
                "type": "script",
                "script_id": "sniffer",
                "downloadable": True,
                "content": block("""
                    /* sniffer.s */
                    function main() {
                      // Sweep the quiet bands for hidden signals.
                    }
                """),
            },
            "spoof.s": {
                "type": "script",
                "script_id": "spoof",
                "downloadable": True,
                "content": block("""
                    /* spoof.s */
                    function main() {
                      // Spoof a temporary mask signature.
                      // Output: mask.dat
                    }
                """),
            },
        },
    },
    "weaver.den": {
        "title": "WEAVER.DEN",
        "desc": block("""
            A low-lit workshop of stitched code and soft voices.
            The Weavers trade in patterns and provenance.
        """),
        "entry": {"items": [], "flags": ["sniffer_run"]},
        "links": ["market.node", "archives.arc", "corp.audit"],
        "files": {
            "weaver.log": {
                "type": "text",
                "content": block("""
                    WEAVER.DEN LOG
                    Bring proof of thread. The Lattice cache honors a token spliced
                    from badge.sig + mask.dat + weaver.mark. Use splice.s.
                    Ghost your trail with ghost.s to reach the corporate audit node.
                """),
            },
            "weaver.mark": {
                "type": "item",
                "item_id": "weaver.mark",
                "downloadable": True,
                "content": block("""
                    WEAVER.MARK
                    A stitched glyph accepted by those who know.
                """),
            },
            "splice.s": {
                "type": "script",
                "script_id": "splice",
                "downloadable": True,
                "content": block("""
                    /* splice.s */
                    function main() {
                      // Forge a lattice token from badge, mask, and mark.
                    }
                """),
            },
            "ghost.s": {
                "type": "script",
                "script_id": "ghost",
                "downloadable": True,
                "content": block("""
                    /* ghost.s */
                    function main() {
                      // Mask your audit trail to slip past corp sensors.
                    }
                """),
            },
        },
    },
    "corp.audit": {
        "title": "CORP.AUDIT",
        "desc": block("""
            An audit chamber lit by cold LEDs.
            Anything unmasked gets burned.
        """),
        "entry": {"items": [], "flags": ["ghosted"]},
        "links": ["weaver.den"],
        "files": {
            "audit.log": {
                "type": "text",
                "content": block("""
                    CORP AUDIT SUMMARY
                    A relay shard was quarantined after the Drift patch.
                    If you want it, stay ghosted and move quiet.
                """),
            },
            "relay.shard": {
                "type": "item",
                "item_id": "relay.shard",
                "downloadable": True,
                "content": block("""
                    RELAY.SHARD
                    Segment: LK-ACCT/relay
                    Status: cold
                """),
            },
        },
    },
    "lattice.cache": {
        "title": "LATTICE.CACHE",
        "desc": block("""
            A vault of interlocked lattice.
            The air tastes like static and old promises.
        """),
        "entry": {"items": ["token.key", "weaver.mark"], "flags": ["lattice_sigil"]},
        "links": ["archives.arc", "core.relic"],
        "files": {
            "cache.log": {
                "type": "text",
                "content": block("""
                    LATTICE CACHE
                    The lattice accepts the token and the weaver mark.
                    The relic key rests inside. Fork the relay to expose the core.
                """),
            },
            "cache.rot13": {
                "type": "text",
                "cipher": True,
                "content": "gur eryvp xrl jnvgf va gur pnpur.",
            },
            "relic.key": {
                "type": "item",
                "item_id": "relic.key",
                "downloadable": True,
                "content": block("""
                    RELIC.KEY
                    Access key for CORE RELIC.
                """),
            },
        },
    },
    "perimeter.gate": {
        "title": "PERIMETER.GATE",
        "desc": block("""
            The Lotus-Kline perimeter still hums with old security.
            A quiet node, a long memory.
        """),
        "entry": {"items": [], "flags": ["trace_open"]},
        "links": ["hub.home", "market.node", "archives.arc"],
        "files": {
            "access.log": {
                "type": "text",
                "content": block("""
                    PERIMETER ACCESS LOG
                    Gate rejects unmasked access. Badge required.
                    Attached note looks like rot13. See cipher.txt.
                """),
            },
            "cipher.txt": {
                "type": "text",
                "cipher": True,
                "content": "rzore vf gur qevsg. gur nepuvir jnagf n onqtr naq n znfx.",
            },
            "badge.sig": {
                "type": "item",
                "item_id": "badge.sig",
                "downloadable": True,
                "content": block("""
                    BADGE.SIG
                    Issuer: Lotus-Kline perimeter
                    Signature: 9f3a-77b1
                """),
            },
        },
    },
    "archives.arc": {
        "title": "SABLE ARCHIVE",
        "desc": block("""
            Cold stacks of memory and a faint relay tone.
            The archive is here, waiting.
        """),
        "entry": {"items": ["badge.sig", "mask.dat"], "flags": ["ember_phrase"]},
        "links": ["perimeter.gate", "weaver.den", "lattice.cache"],
        "files": {
            "lore.log": {
                "type": "text",
                "content": block("""
                    SABLE ARCHIVE INDEX
                    The archive remembers the first operators and the patch that
                    turned the net to drift. A relay called the Relic is folded
                    inside. The old manifest warns: sigil stored in base64.
                    The Lattice cache answers only to a token and a weaver mark.
                """),
            },
            "weaver.note": {
                "type": "text",
                "content": block("""
                    SWITCHBOARD NOTE
                    A Weaver den sits off-band. Run sniffer.s to locate it.
                    They can stitch the token the lattice requires.
                """),
            },
            "key.b64": {
                "type": "text",
                "cipher": True,
                "content": "U0lHSUw6IExBVFRJQ0U=",
            },
            "fork.s": {
                "type": "script",
                "script_id": "fork",
                "downloadable": True,
                "content": block("""
                    /* fork.s */
                    function main() {
                      // Split a relay channel to expose the core.
                    }
                """),
            },
        },
    },
    "core.relic": {
        "title": "CORE RELIC",
        "desc": block("""
            A buried relay and a voice in the static.
            You can feel the drift pull at the edges.
        """),
        "entry": {
            "items": ["relay.shard", "relic.key"],
            "flags": ["lattice_sigil", "forked"],
        },
        "links": ["archives.arc"],
        "files": {
            "core.log": {
                "type": "text",
                "content": block("""
                    CORE RELIC
                    The relic wakes. It asks for a choice.

                    Type: exfiltrate  - lift it out into a private shell
                    Type: restore     - bind it back to the Drift
                """),
            },
        },
    },
}


def fresh_state(handle):
    return {
        "handle": handle or "ghost",
        "location": "hub.home",
        "inventory": set(),
        "scripts": set(),
        "flags": set(),
        "discovered": {"hub.home"},
        "log": [],
        "visited": set(),
        "last_cipher": None,
        "ended": False,
    }


def log_event(state, text):
    state["log"].append(text)


def discover(state, nodes):
    added = []
    for node_id in nodes:
        if node_id not in state["discovered"]:
            state["discovered"].add(node_id)
            added.append(node_id)
    return added


def requirements_for(state, node_id):
    entry = NODES[node_id].get("entry", {})
    req_items = entry.get("items", [])
    req_flags = entry.get("flags", [])
    missing_items = [item for item in req_items if item not in state["inventory"]]
    missing_flags = [flag for flag in req_flags if flag not in state["flags"]]
    ok = not missing_items and not missing_flags
    return ok, missing_items, missing_flags


def enter_node(state, node_id):
    state["location"] = node_id
    if node_id not in state["visited"]:
        state["visited"].add(node_id)
        log_event(state, f"Entered {node_id}")
    print()
    print(f":: {node_id} :: {NODES[node_id]['title']}")
    show(NODES[node_id]["desc"])


def current_files(state):
    return NODES[state["location"]]["files"]


def cmd_help(state, args):
    show(block("""
        Commands:
          help                 show this list
          scan                 list discovered nodes
          connect <node>       jump to a node
          ls                   list files in the node
          cat <file>           read a file
          download <file>      take a script or item
          run <script>         execute a script in your kit
          decode rot13|b64     decode the last cipher you read
          inventory            list your scripts and items
          profile              show your handle and status
          log                  review your activity
          home                 return to hub
          save                 write a save file
          load                 load save file
          quit                 exit
    """))


def cmd_scan(state, args):
    nodes = sorted([n for n in state["discovered"] if n != state["location"]])
    if not nodes:
        show("No other signals.")
        return
    show("Signals:")
    for node_id in nodes:
        ok, missing_items, missing_flags = requirements_for(state, node_id)
        status = "OPEN" if ok else "LOCKED"
        line = f"- {node_id} [{status}]"
        if not ok:
            needs = []
            if missing_items:
                needs.append("items: " + ", ".join(missing_items))
            if missing_flags:
                needs.append("signals: " + ", ".join(missing_flags))
            line += " (" + "; ".join(needs) + ")"
        print(line)


def cmd_connect(state, args):
    if not args:
        show("Connect where?")
        return
    node_id = args[0]
    if node_id not in state["discovered"]:
        show("No signal by that name.")
        return
    ok, missing_items, missing_flags = requirements_for(state, node_id)
    if not ok:
        needs = []
        if missing_items:
            needs.append("items: " + ", ".join(missing_items))
        if missing_flags:
            needs.append("signals: " + ", ".join(missing_flags))
        show("Access denied. Missing " + "; ".join(needs) + ".")
        return
    enter_node(state, node_id)


def cmd_ls(state, args):
    files = current_files(state)
    if not files:
        show("No files in this node.")
        return
    for name, meta in files.items():
        print(f"- {name} ({meta['type']})")


def cmd_cat(state, args):
    if not args:
        show("Read which file?")
        return
    name = args[0]
    files = current_files(state)
    if name not in files:
        show("File not found.")
        return
    entry = files[name]
    content = entry.get("content", "")
    show(content)
    if entry.get("cipher"):
        state["last_cipher"] = content
        log_event(state, f"Read cipher {name}")


def cmd_download(state, args):
    if not args:
        show("Download which file?")
        return
    name = args[0]
    files = current_files(state)
    if name not in files:
        show("File not found.")
        return
    entry = files[name]
    if not entry.get("downloadable"):
        show("Nothing to download here.")
        return
    if entry["type"] == "script":
        script_id = entry["script_id"]
        if script_id in state["scripts"]:
            show("Script already in your kit.")
            return
        state["scripts"].add(script_id)
        log_event(state, f"Downloaded script {script_id}")
        show(f"Downloaded script: {script_id}")
    elif entry["type"] == "item":
        item_id = entry["item_id"]
        if item_id in state["inventory"]:
            show("Item already in your kit.")
            return
        state["inventory"].add(item_id)
        log_event(state, f"Downloaded item {item_id}")
        show(f"Downloaded item: {item_id}")
    else:
        show("Nothing to download here.")


def run_script(state, script_id):
    if script_id == "tracer":
        added = discover(state, ["market.node", "perimeter.gate"])
        state["flags"].add("trace_open")
        log_event(state, "Tracer mapped the perimeter")
        show("Tracer online. Mesh resolved.")
        if added:
            show("New signals: " + ", ".join(added))
        return
    if script_id == "spoof":
        if "mask.dat" in state["inventory"]:
            show("Mask already minted.")
            return
        state["inventory"].add("mask.dat")
        log_event(state, "Minted mask.dat")
        show("Mask minted: mask.dat")
        return
    if script_id == "sniffer":
        if "sniffer_run" in state["flags"]:
            show("Sniffer already swept the quiet bands.")
            return
        state["flags"].add("sniffer_run")
        added = discover(state, ["weaver.den", "corp.audit", "lattice.cache"])
        log_event(state, "Sniffer swept the quiet bands")
        show("Sniffer pulse complete.")
        if added:
            show("New signals: " + ", ".join(added))
        return
    if script_id == "splice":
        if "token.key" in state["inventory"]:
            show("Token already forged.")
            return
        missing = [
            item
            for item in ("badge.sig", "mask.dat", "weaver.mark")
            if item not in state["inventory"]
        ]
        if missing:
            show("Splice failed. Missing: " + ", ".join(missing))
            return
        state["inventory"].add("token.key")
        log_event(state, "Spliced token.key")
        show("Token forged: token.key")
        return
    if script_id == "ghost":
        if "ghosted" in state["flags"]:
            show("Ghost protocol already active.")
            return
        if "weaver.mark" not in state["inventory"]:
            show("Ghost protocol requires weaver.mark.")
            return
        state["flags"].add("ghosted")
        added = discover(state, ["corp.audit"])
        log_event(state, "Ghosted the audit trail")
        show("Ghost protocol active. Your trail is cold.")
        if added:
            show("New signal: " + ", ".join(added))
        return
    if script_id == "fork":
        if "forked" in state["flags"]:
            show("Relay already forked.")
            return
        state["flags"].add("forked")
        added = discover(state, ["core.relic"])
        log_event(state, "Forked the relay to the core")
        show("Relay forked. Core channel exposed.")
        if added:
            show("New signal: core.relic")
        return
    show("Script returned no response.")


def cmd_run(state, args):
    if not args:
        show("Run which script?")
        return
    raw = args[0]
    script_id = raw[:-2] if raw.endswith(".s") else raw
    if script_id in state["scripts"]:
        run_script(state, script_id)
        return
    files = current_files(state)
    for entry in files.values():
        if entry.get("type") == "script" and entry.get("script_id") == script_id:
            run_script(state, script_id)
            show("Tip: download the script to keep it in your kit.")
            return
    show("Script not found in your kit or this node.")


def cmd_decode(state, args):
    if not args:
        show("Usage: decode rot13|b64 <text>")
        return
    cipher = args[0].lower()
    payload = " ".join(args[1:]).strip() if len(args) > 1 else None
    if not payload:
        payload = state.get("last_cipher")
    if not payload:
        show("No cached cipher. Read a cipher file first.")
        return
    result = None
    if cipher in ("rot13", "rot", "r13"):
        result = codecs.decode(payload, "rot_13")
    elif cipher in ("b64", "base64"):
        try:
            raw = base64.b64decode(payload.encode("utf-8"), validate=True)
            result = raw.decode("utf-8", errors="replace")
        except Exception:
            show("Base64 decode failed.")
            return
    else:
        show("Unknown cipher. Use rot13 or b64.")
        return

    show("Decoded:")
    show(result)
    upper = result.upper()
    if "EMBER" in upper and "ember_phrase" not in state["flags"]:
        state["flags"].add("ember_phrase")
        log_event(state, "Decoded ember phrase")
    if "LATTICE" in upper and "lattice_sigil" not in state["flags"]:
        state["flags"].add("lattice_sigil")
        log_event(state, "Decoded lattice sigil")


def cmd_inventory(state, args):
    if not state["scripts"] and not state["inventory"]:
        show("Your kit is empty.")
        return
    if state["scripts"]:
        print("Scripts: " + ", ".join(sorted(state["scripts"])))
    if state["inventory"]:
        print("Items: " + ", ".join(sorted(state["inventory"])))


def cmd_profile(state, args):
    show(f"Handle: {state['handle']}")
    show(f"Location: {state['location']}")
    show(f"Scripts: {len(state['scripts'])} | Items: {len(state['inventory'])}")
    show(f"Signals: {len(state['discovered'])}")


def cmd_log(state, args):
    if not state["log"]:
        show("Log is empty.")
        return
    for entry in state["log"]:
        print(f"- {entry}")


def cmd_home(state, args):
    enter_node(state, "hub.home")


def cmd_exfiltrate(state, args):
    if state["location"] != "core.relic":
        show("No target to exfiltrate here.")
        return
    show(block("""
        You lift the relic into your shell. The Drift goes quiet behind you.
        A new story begins, sealed from the old net.
    """))
    state["ended"] = True
    log_event(state, "Ending: exfiltrate")


def cmd_restore(state, args):
    if state["location"] != "core.relic":
        show("No target to restore here.")
        return
    show(block("""
        You bind the relic back to the Drift. The net exhales.
        The archive sleeps, but its signal will haunt the edges.
    """))
    state["ended"] = True
    log_event(state, "Ending: restore")


def serialize_state(state):
    return {
        "handle": state["handle"],
        "location": state["location"],
        "inventory": sorted(state["inventory"]),
        "scripts": sorted(state["scripts"]),
        "flags": sorted(state["flags"]),
        "discovered": sorted(state["discovered"]),
        "log": state["log"],
        "visited": sorted(state["visited"]),
        "last_cipher": state.get("last_cipher"),
        "ended": state.get("ended", False),
    }


def cmd_save(state, args):
    data = serialize_state(state)
    with open(SAVE_PATH, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
    show("Saved to save.json")


def load_state():
    with open(SAVE_PATH, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    state = fresh_state(data.get("handle", "ghost"))
    state["location"] = data.get("location", "hub.home")
    state["inventory"] = set(data.get("inventory", []))
    state["scripts"] = set(data.get("scripts", []))
    state["flags"] = set(data.get("flags", []))
    state["discovered"] = set(data.get("discovered", []))
    state["log"] = data.get("log", [])
    state["visited"] = set(data.get("visited", []))
    state["last_cipher"] = data.get("last_cipher")
    state["ended"] = data.get("ended", False)
    if state["location"] not in state["discovered"]:
        state["discovered"].add(state["location"])
    return state


def cmd_load(state, args):
    if not os.path.exists(SAVE_PATH):
        show("No save file found.")
        return state
    try:
        new_state = load_state()
    except Exception:
        show("Failed to load save file.")
        return state
    show("Save loaded.")
    enter_node(new_state, new_state["location"])
    return new_state


def handle_command(state, line):
    try:
        parts = shlex.split(line)
    except ValueError:
        show("Malformed command.")
        return state
    if not parts:
        return state
    cmd = parts[0].lower()
    args = parts[1:]

    if cmd in ("help", "?"):
        cmd_help(state, args)
    elif cmd == "scan":
        cmd_scan(state, args)
    elif cmd in ("connect", "go"):
        cmd_connect(state, args)
    elif cmd == "ls":
        cmd_ls(state, args)
    elif cmd in ("cat", "read"):
        cmd_cat(state, args)
    elif cmd == "download":
        cmd_download(state, args)
    elif cmd == "run":
        cmd_run(state, args)
    elif cmd == "decode":
        cmd_decode(state, args)
    elif cmd in ("inventory", "inv"):
        cmd_inventory(state, args)
    elif cmd == "profile":
        cmd_profile(state, args)
    elif cmd == "log":
        cmd_log(state, args)
    elif cmd == "home":
        cmd_home(state, args)
    elif cmd == "save":
        cmd_save(state, args)
    elif cmd == "load":
        state = cmd_load(state, args)
    elif cmd == "exfiltrate":
        cmd_exfiltrate(state, args)
    elif cmd == "restore":
        cmd_restore(state, args)
    elif cmd in ("quit", "exit", "q"):
        sys.exit(0)
    else:
        show("Unknown command. Type help for options.")
    return state


def start_state():
    if os.path.exists(SAVE_PATH):
        answer = input("Load save? (y/N) ").strip().lower()
        if answer == "y":
            try:
                return load_state()
            except Exception:
                show("Failed to load save file, starting fresh.")
    handle = input("HANDLE? ").strip()
    return fresh_state(handle)


def main():
    show("hackterm // local drift sim")
    show("Type help for commands. Type quit to exit.")
    state = start_state()
    enter_node(state, state["location"])
    while True:
        try:
            line = input(f"{state['location']}> ")
        except (EOFError, KeyboardInterrupt):
            print()
            show("Session ended.")
            return
        state = handle_command(state, line)


if __name__ == "__main__":
    main()
