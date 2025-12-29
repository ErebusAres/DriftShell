# DriftShell

A local, single-player game inspired by hackmud's terminal aesthetic and script-driven mechanics.

## Play

- GitHub Pages: `https://erebusares.github.io/DriftShell/`
- Direct file: `https://erebusares.github.io/DriftShell/index.html`
- Local: open `index.html`

## Quick start

- At the prompt, type a handle (or type `load` if you already saved).
- Type `help` for commands.
- Start with `scan`, then `connect public.exchange`.
- Use `ls`, `cat`, and `download` to pick up `.s` scripts, then `call <script>` to run them.
- Most readable files can be downloaded too; use `drive` to list them and `cat drive:<loc>/<file>` to open.
- Use `breach <loc>` and `unlock <answer>` to clear lock stacks.
- Use `decode rot13` / `decode b64` after reading cipher files.
- Optional: once you find `relay.uplink`, you can `upload` scripts/files back into the net (and track them with `uploads`).
- GC is currency: at `public.exchange`, use `store` / `buy <item>` then `install <upgrade>`.
- Saves: autosave + `save` / `load` (browser localStorage), plus `export` / `import` for backups/cross-browser.
