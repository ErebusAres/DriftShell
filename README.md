# DriftShell

A local, single-player game inspired by hackmud's terminal aesthetic and script-driven mechanics.

## Play (GitHub Pages)

Once GitHub Pages is enabled, play at `https://erebusares.github.io/DriftShell/`.

## Play (recommended: web UI)

Open `index.html` (double-click) to launch the terminal UI using the bundled `whiterabbit-webfont.ttf`.

If your browser blocks local file features, run a local server from the repo root:

```powershell
py -m http.server 8080
```

Then open `http://localhost:8080/`.

## Quick start

- At the prompt, type a handle (or type `load` if you already saved).
- Type `help` for commands.
- Start with `scan`, then `connect public.exchange`.
- Use `ls`, `cat`, and `download` to pick up `.s` scripts, then `call <script>` to run them.
- Use `breach <loc>` and `unlock <answer>` to clear lock stacks.
- Use `decode rot13` / `decode b64` after reading cipher files.
- Use `save` / `load` to persist progress (saved in browser localStorage).
- Use `export` / `import` to move saves between browsers (or back up).
