# Engine: OrcaSlicer → WebAssembly

Builds OrcaSlicer v2.5.0's slicing core (libslic3r) into `slicer-st.wasm` (single-threaded)
and `slicer-mt.wasm` (pthreads + oneTBB). The C API is in `bridge/orca_engine.h`.

Everything runs in pinned containers. The only host requirements are Docker, git, Python 3 and
Node ≥ 22.

```bash
engine/scripts/build-deps.sh st      # WASM dependencies, single-threaded variant (~30–60 min cold)
engine/scripts/build-deps.sh mt      # … multithreaded variant
engine/scripts/build-engine.sh st    # patched Orca + bridge → .work/build-engine-st/dist/slicer-st.{mjs,wasm}
engine/scripts/build-engine.sh mt
node engine/test/parity.mjs st       # slice the fixtures, compare with desktop reference G-code
node engine/test/parity.mjs mt
node engine/test/presets-check.mjs st  # compose a config with the engine's PresetBundle, slice with it
node engine/test/presets-parity.mjs st # 50 system preset combinations across vendors vs desktop
node engine/test/presets-user.mjs st   # user presets, desktop's into the engine and back
node engine/test/presets-compare.mjs st # any preset's settings, for comparing presets side by side
node engine/test/paint.mjs st           # support painting: brush, fill, gap fill; the paint in the slice
node engine/test/preview.mjs st        # the preview's moves of a slice, and of the same G-code read as a file
node engine/test/bench-large.mjs both  # large-model timings → .work/bench/ (also big G-code for the preview benchmark)
python3 -I engine/scripts/make-fixtures.py [name ...]   # regenerate fixtures with the desktop CLI
```

## API (version 3, `bridge/orca_engine.h`)

- **Slicing:** `orca_create`, `orca_load_model` (opens a project or mesh), `orca_add_model`
  (adds geometry), `orca_set_layout` (object order and instance matrices),
  `orca_set_config` (full config JSON), `orca_slice_start` / `_poll` / `orca_cancel`,
  `orca_progress`, `orca_result`, `orca_last_error`.
- **Arrange:** `orca_arrange`, desktop's Arrange (ArrangeJob, one plate, the arrange dialog's
  defaults) for the loaded model with the config set; returns the new instance matrices.
- **Inspection:** `orca_model_info` (objects, instances, bounding boxes, plates) and
  `orca_export_meshes` (binary meshes in object coordinates).
- **Presets:** `orca_presets_*`. This is OrcaSlicer's own `PresetBundle`: load vendor trees from
  MEMFS, select printer, process and filament as the desktop does, and get `full_config()`.
  Editing: `orca_presets_values` / `_edit` / `_reset` / `_save` / `_delete` / `_import`.
  `orca_presets_values` also reports which settings apply (desktop's toggle rules), and
  `orca_presets_state` reports which presets have unsaved edits. Custom printers:
  `orca_presets_templates` and `orca_presets_create_printer` follow desktop's Create Printer dialog, `orca_presets_filament_list` and `orca_presets_create_filament` its Create
  Filament dialog; `_save` takes `detach`; `_delete` keeps presets others inherit from and takes a
  custom printer's own presets along. Tested by `engine/test/presets-custom.mjs`.
- Out-of-memory comes back as `ORCA_OOM` in both builds. `bridge/new_delete.cpp` makes
  `operator new` throw instead of mimalloc's abort.

### Parity fixtures

- `cube`, `overhang`, `multi`: byte-identical to desktop except the timestamp.
- `sphere`: a UV sphere whose degenerate poles exercise Arachne. It carries an exactly pinned
  known difference (`known_difference` in `fixtures.json`). The test fails if the
  difference changes in either direction.

### Preset parity

`presets-parity.mjs` checks the engine's preset composition against desktop across vendors.
`presets-pick.mjs` chooses 52 vendor slots (the vendors with the most printers), each with a few
candidate printers and a compatible process and filament. `make-preset-refs.py` has the desktop
CLI slice the first candidate per slot that it can, twice, and stores the arranged 3MF, G-code
and config (`test/fixtures/presets/`, listed in `refs.json`). Candidates are set aside when:

- desktop refuses them: kept, the engine must refuse with the same message;
- only the CLI refuses them: whole-config validation and the multi-extruder area check, which
  the desktop app doesn't make before slicing;
- desktop's own output differs between two runs: `{random()}` in the start G-code.

The test composes each combination with the engine, slices, and requires the G-code to equal
desktop's. Allowed differences: the date line, the config block and object label ids. Config
differences are classified (project settings, CLI metadata, variant arrays checked
element-wise, and a few CLI-only normalizations); anything unclassified fails. One pinned
difference is in `known.json`.

`presets-user.mjs` covers user presets. It imports desktop-format user presets (printer,
process, filament) and must slice them as desktop does. Presets the engine saves must stay
byte-identical, and desktop slices them to the same G-code (`make-user-refs.py`, desktop
loading them from a data folder). Regenerate in this order:
`presets-pick.mjs` → `make-preset-refs.py` → `presets-user.mjs st --export` → `make-user-refs.py`.

The build state lives in `.work/` (gitignored):
- the pristine Orca checkout;
- the patched tree;
- the dependency prefixes;
- the ccache and Emscripten caches.

## Layout

| Path | What |
|---|---|
| `versions.env` | Orca tag/SHA, toolchain image digest, reference AppImage hash |
| `docker/Dockerfile` | Toolchain: `emscripten/emsdk:6.0.13` plus build tools |
| `docker/ref.Dockerfile` | Desktop OrcaSlicer 2.5.0 CLI, used only to make reference G-code |
| `deps/` | Dependency superbuild (versions and options mirror Orca's `deps/`) |
| `patches/orca/` | `git am` series on top of the Orca tag; see `docs/PATCHES.md` |
| `patches/deps/` | Dependency patches |
| `tbb-serial/` | Serial TBB implementation for the single-threaded build |
| `shims/` | MD5 replacement for OpenSSL |
| `CMakeLists.txt` | Top-level build: our replacement for Orca's root CMake |
| `bridge/` | C API and the wasm link target |
| `test/` | Fixtures, reference G-code, Node harness, parity test |
| `scripts/make-fixtures.py` | Regenerates fixtures and reference G-code with the desktop CLI |
| `scripts/make-preset-refs.py`, `make-user-refs.py` | Desktop references for the preset parity tests |
