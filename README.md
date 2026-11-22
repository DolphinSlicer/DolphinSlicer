<p align="center"><img src="app/public/dolphin-slicer-mark.svg" width="96" alt=""></p>

# DolphinSlicer

The OrcaSlicer slicing engine, compiled to WebAssembly and running entirely in your browser.
Models are sliced locally; nothing is uploaded.

- **Engine** (`engine/`): OrcaSlicer 2.5.0's libslic3r built with Emscripten. Single-threaded and
  multithreaded builds. G-code byte-identical to desktop OrcaSlicer on the test fixtures.
- **App** (`app/`): Vite + React + three.js static site. Import, arrange, slice in a worker,
  G-code preview, the full OrcaSlicer settings and system profiles, user presets compatible with
  desktop.

Start with [`engine/README.md`](engine/README.md) and [`app/README.md`](app/README.md). More in
[`docs/`](docs/).

Licence: AGPL-3.0-or-later (see `LICENSE` and `NOTICE`).
