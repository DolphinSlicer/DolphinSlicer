#!/usr/bin/env python3
"""Reference G-code for the preset parity test, sliced by desktop OrcaSlicer 2.5.0.

For each slot in engine/test/fixtures/presets/combos.json (chosen by
engine/test/presets-pick.mjs), the first candidate that desktop slices:
  1. desktop CLI: load the printer, process and filament straight from the vendor profiles,
     arrange the model on that printer's bed, export a 3MF  -> fixtures/presets/<NN>.3mf
  2. desktop CLI: slice that 3MF with --arrange 0 and export the flattened config
       -> fixtures/presets/<NN>.gcode.gz, fixtures/presets/<NN>.settings.json.gz
Candidates desktop refuses to slice (invalid combinations) are kept as well, with desktop's
message: the engine must refuse them with the same message. Every candidate tried is listed in
fixtures/presets/refs.json: combos (references), refused, cli_only (refused by the CLI only, not
by the desktop app), nondeterministic (desktop's own output differs between two runs) and
unloadable (files the CLI cannot read).
engine/test/presets-parity.mjs then composes the same selection with the engine's
PresetBundle, slices <NN>.3mf with it and compares the G-code with the reference.

Runs the desktop CLI in the pinned container (engine/docker/ref.Dockerfile), with the profile
tree the app ships (.work/orca-src/resources/profiles) mounted read-only.
Usage: make-preset-refs.py [NN ...]   (only those combinations; default all; needs docker)
"""
import gzip
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ENGINE = Path(__file__).resolve().parent.parent
REPO = ENGINE.parent
FIX = ENGINE / 'test' / 'fixtures'
OUT = FIX / 'presets'
PROFILES = REPO / '.work' / 'orca-src' / 'resources' / 'profiles'
REF_IMAGE = 'dolphin-slicer-ref:2.5.0'


def preset_file(vendor: str, kind: str, name: str) -> str:
    """The profile file of a system preset relative to the profile root, from the vendor index
    (the file name can differ from the preset name). Filaments may also come from the shared
    OrcaFilamentLibrary."""
    for v in (vendor, 'OrcaFilamentLibrary') if kind == 'filament' else (vendor,):
        idx = json.loads((PROFILES / f'{v}.json').read_text())
        for e in idx.get(f'{kind}_list', []):
            if e['name'] == name:
                return f"{v}/{e['sub_path']}"
    raise SystemExit(f'{name}: not in the {vendor} profile index')


def files_of(c):
    return [preset_file(c['vendor'], 'machine', c['printer']), preset_file(c['vendor'], 'process', c['process']),
            preset_file(c['vendor'], 'filament', c['filament'])]


def orca(work: Path, c, *args, prof: Path = PROFILES):
    machine, process, filament = (f'/prof/{f}' for f in files_of(c))
    r = subprocess.run(
        ['docker', 'run', '--rm', '-u', f'{os.getuid()}:{os.getgid()}', '-v', f'{work}:/w',
         '-v', f'{prof}:/prof:ro', '-w', '/w', REF_IMAGE,
         '--load-settings', f'{machine};{process}', '--load-filaments', filament, *args],
        capture_output=True, text=True)
    if r.returncode:
        out = next((a for a in args if a.startswith('/w/') and '-' in a and not a.endswith('.json')), None)
        result = work / out[3:] / 'result.json' if out else None
        detail = json.loads(result.read_text()).get('error_string', '') if result and result.exists() else ''
        # The specific message is on stderr after "exit..."; result.json's error_string can be
        # generic ("There are some incorrect slicing parameters…"), so it is only the fallback.
        message = (r.stdout + r.stderr).split('exit...')[-1].strip() or detail
        raise RuntimeError(f"desktop CLI failed ({r.returncode}): {(r.stdout + r.stderr)[-800:]}exit...{message}")


def marked_system(work: Path, c) -> Path:
    """A copy of the profile tree in which the three preset files say "from": "system".

    The CLI reads a preset file given on its command line only when the file says
    "from": "system" (or "User"); some vendors' files say nothing or "System". For a "system"
    file the CLI then loads the file's whole vendor tree with the loader the desktop app uses
    (PresetBundle::load_vendor_configs_from_json), which ignores "from", and takes the preset
    from there. So marking the file changes which files the CLI accepts, not the result."""
    prof = work / 'prof-marked'
    if prof.exists():
        shutil.rmtree(prof)
    prof.mkdir()
    for v in {c['vendor'], 'OrcaFilamentLibrary'}:
        shutil.copytree(PROFILES / v, prof / v)
        shutil.copy(PROFILES / f'{v}.json', prof / f'{v}.json')
    for f in files_of(c):
        j = json.loads((prof / f).read_text())
        j['from'] = 'system'
        (prof / f).write_text(json.dumps(j, indent=4))
    return prof


def strip_gcode(src: Path, dst: Path):
    """The exported 3MF without the sliced plate (as make-fixtures.py)."""
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            if item.filename.startswith('Metadata/plate_') and '.gcode' in item.filename:
                continue
            data = zin.read(item.filename)
            if item.filename == 'Metadata/model_settings.config':
                data = '\n'.join(l for l in data.decode().split('\n') if 'key="gcode_file"' not in l).encode()
            zout.writestr(item, data)


def write_gz(path: Path, data: bytes):
    with open(path, 'wb') as f, gzip.GzipFile(fileobj=f, mode='wb', mtime=0, filename='') as g:
        g.write(data)


def cli_cannot_read(message: str) -> bool:
    return 'unsupported' in message or 'can not resolve preset' in message


# Refusals of the CLI that the desktop app does not make, so the app (and the engine) slices these:
# - the CLI validates the whole config before slicing; the app does so only when it opens a 3MF
#   (Plater.cpp, a notification), not for presets it loads;
# - the CLI stops on toolpaths in a multi-extruder printer's unprintable area; the app slices and
#   shows a warning in the preview (GLCanvas3D, MultiExtruderPrintableError).
CLI_ONLY = ('Param values in 3mf/config error', 'Found G-code in unprintable area')


def without_timestamp(gcode: bytes) -> bytes:
    return b'\n'.join(l for l in gcode.split(b'\n') if not l.startswith(b'; generated by '))


def main():
    spec = json.loads((OUT / 'combos.json').read_text())
    only = set(sys.argv[1:])
    refs_path = OUT / 'refs.json'
    old = json.loads(refs_path.read_text()) if only and refs_path.exists() else {}
    refs = {'combos': [], 'refused': [], 'cli_only': [], 'nondeterministic': [], 'unloadable': []}
    with tempfile.TemporaryDirectory() as td:
        work = Path(td)
        subprocess.run([sys.executable, '-I', FIX / 'gen_models.py', work / 'models'], check=True,
                       stdout=subprocess.DEVNULL)
        for i, slot in enumerate(spec['slots'], 1):
            nn = f'{i:02d}'
            if only and nn not in only:
                for k in refs:
                    refs[k] += [r for r in old.get(k, []) if r['nn'] == nn]
                continue
            for c in slot['candidates']:
                c = {'nn': nn, 'vendor': slot['vendor'], **c}
                arranged = work / f'{nn}.3mf'

                def run(prof):
                    orca(work, c, '--arrange', '1', '--slice', '0', '--outputdir', f'/w/{nn}-arr', '--export-3mf',
                         f'{nn}.3mf', f"models/{spec['model']}", prof=prof)
                    strip_gcode(work / f'{nn}-arr' / f'{nn}.3mf', arranged)
                    for out in (f'{nn}-ref', f'{nn}-again'):
                        orca(work, c, '--arrange', '0', '--slice', '0', '--outputdir', f'/w/{out}',
                             '--export-settings', f'/w/{out}/settings.json', f'{nn}.3mf', prof=prof)
                try:
                    try:
                        run(PROFILES)
                    except RuntimeError as e:
                        if not cli_cannot_read(str(e)):
                            raise
                        c['marked_system'] = True
                        run(marked_system(work, c))
                except RuntimeError as e:
                    message = str(e).split('exit...')[-1].strip()
                    # Desktop refuses to slice this: the engine must refuse it with the same
                    # message (presets-parity.mjs slices fixtures/cube.3mf for that).
                    kind = ('unloadable' if cli_cannot_read(message) else
                            'cli_only' if message.startswith(CLI_ONLY) else 'refused')
                    refs[kind].append({**c, 'message': message})
                    print(f"{nn} {c['printer']}: {kind}: {message}", file=sys.stderr)
                    continue
                gcode = (work / f'{nn}-ref' / 'plate_1.gcode').read_bytes()
                if without_timestamp(gcode) != without_timestamp((work / f'{nn}-again' / 'plate_1.gcode').read_bytes()):
                    # E.g. start G-code with {random(…)}: desktop itself differs from run to run.
                    refs['nondeterministic'].append(c)
                    print(f"{nn} {c['printer']}: desktop G-code differs between two runs", file=sys.stderr)
                    continue
                (OUT / f'{nn}.3mf').write_bytes(arranged.read_bytes())
                write_gz(OUT / f'{nn}.gcode.gz', gcode)
                write_gz(OUT / f'{nn}.settings.json.gz', (work / f'{nn}-ref' / 'settings.json').read_bytes())
                refs['combos'].append(c)
                print(f"{nn} {c['printer']}: {len(gcode)} bytes", file=sys.stderr)
                break
            else:
                print(f'{nn} {slot["vendor"]}: no candidate sliced on desktop', file=sys.stderr)
    for k in refs:
        refs[k].sort(key=lambda r: r['nn'])
    refs_path.write_text(json.dumps(refs, indent=2, ensure_ascii=False) + '\n')
    print(', '.join(f'{len(v)} {k}' for k, v in refs.items()), file=sys.stderr)


if __name__ == '__main__':
    main()
