#!/usr/bin/env python3
"""Build the engine test fixtures and their reference G-code with desktop OrcaSlicer 2.5.0.

For each fixture in engine/test/fixtures/fixtures.json:
  1. generate meshes (gen_models.py)
  2. desktop CLI: arrange + export a 3MF  -> fixtures/<name>.3mf   (positions frozen from here on)
  3. apply per-object overrides by editing Metadata/model_settings.config in the 3MF
  4. desktop CLI: slice that 3MF with --arrange 0, export the flattened config
       -> fixtures/ref/<name>.gcode.gz, fixtures/ref/<name>.settings.json
The engine test feeds <name>.3mf + <name>.settings.json to the WASM engine and compares the
G-code with the reference (see engine/test/gcode-compare.mjs).

Runs the desktop CLI in the pinned container built from engine/docker/ref.Dockerfile.
Usage: make-fixtures.py [NAME ...]   (only the named fixtures; default all; needs docker)
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
REF = FIX / 'ref'
ENV = dict(l.split('=', 1) for l in (ENGINE / 'versions.env').read_text().splitlines()
           if l and not l.startswith('#'))
REF_IMAGE = 'dolphin-slicer-ref:2.5.0'
ORCA_PROFILES = REPO / '.work' / 'orca-src' / 'resources' / 'profiles'


def sh(*args, **kw):
    print('+', ' '.join(map(str, args)), file=sys.stderr)
    return subprocess.run(args, check=True, **kw)


def ensure_ref_image():
    if subprocess.run(['docker', 'image', 'inspect', REF_IMAGE], capture_output=True).returncode:
        sh('docker', 'build', '-f', ENGINE / 'docker' / 'ref.Dockerfile',
           '--build-arg', f"REF_IMAGE_BASE={ENV['REF_IMAGE_BASE']}",
           '--build-arg', f"ORCA_APPIMAGE_URL={ENV['ORCA_APPIMAGE_URL']}",
           '--build-arg', f"ORCA_APPIMAGE_SHA256={ENV['ORCA_APPIMAGE_SHA256']}",
           '-t', REF_IMAGE, ENGINE / 'docker')


def make_profiles(work: Path, spec):
    """Copy the vendors we use and register fixture-only process presets in the vendor index
    (the CLI resolves `inherits` only for presets listed in <vendor>.json)."""
    prof = work / 'prof'
    for v in ('Custom', 'OrcaFilamentLibrary'):
        shutil.copytree(ORCA_PROFILES / v, prof / v)
        shutil.copy(ORCA_PROFILES / f'{v}.json', prof / f'{v}.json')
    idx_path = prof / 'Custom.json'
    idx = json.loads(idx_path.read_text())
    for p in spec['process_presets']:
        (prof / 'Custom' / 'process' / f"{p['name']}.json").write_text(json.dumps(p, indent=2))
        idx['process_list'].append({'name': p['name'], 'sub_path': f"process/{p['name']}.json"})
    idx_path.write_text(json.dumps(idx, indent=4))


def orca(work: Path, fx, spec, *args):
    p = '/w/prof/Custom'
    sh('docker', 'run', '--rm', '-u', f'{os.getuid()}:{os.getgid()}', '-v', f'{work}:/w', '-w', '/w', REF_IMAGE,
       '--load-settings', f"{p}/machine/{spec['machine']}.json;{p}/process/{fx['process']}.json",
       '--load-filaments', f"/w/prof/OrcaFilamentLibrary/filament/{spec['filament']}.json",
       *args, stdout=subprocess.DEVNULL)


def rewrite_3mf(src: Path, dst: Path, overrides: dict):
    """Drop sliced artifacts from the exported 3MF and add per-object setting overrides."""
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            name = item.filename
            if name.startswith('Metadata/plate_') and '.gcode' in name:
                continue
            data = zin.read(name)
            if name == 'Metadata/model_settings.config':
                text = data.decode()
                text = '\n'.join(l for l in text.split('\n') if 'key="gcode_file"' not in l)
                for obj_name, kv in overrides.items():
                    anchor = f'<metadata key="name" value="{obj_name}"/>'
                    i = text.index(anchor)  # first occurrence is the <object> level name
                    extra = ''.join(f'\n    <metadata key="{k}" value="{v}"/>' for k, v in kv.items())
                    text = text[:i + len(anchor)] + extra + text[i + len(anchor):]
                data = text.encode()
            zout.writestr(item, data)


def main():
    spec = json.loads((FIX / 'fixtures.json').read_text())
    ensure_ref_image()
    REF.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        work = Path(td)
        sh(sys.executable, '-I', FIX / 'gen_models.py', work / 'models')
        make_profiles(work, spec)
        only = set(sys.argv[1:])
        for fx in spec['fixtures']:
            name = fx['name']
            if only and name not in only:
                continue
            models = [f"models/{m}" for m in fx['models']]
            orca(work, fx, spec, '--arrange', '1', '--slice', '0', '--outputdir', f'/w/{name}-arr',
                 '--export-3mf', f'{name}.3mf', *models)
            rewrite_3mf(work / f'{name}-arr' / f'{name}.3mf', FIX / f'{name}.3mf', fx.get('per_object', {}))
            shutil.copy(FIX / f'{name}.3mf', work / f'{name}.3mf')
            orca(work, fx, spec, '--arrange', '0', '--slice', '0', '--outputdir', f'/w/{name}-ref',
                 '--export-settings', f'/w/{name}-ref/settings.json', f'{name}.3mf')
            gcode = (work / f'{name}-ref' / 'plate_1.gcode').read_bytes()
            with gzip.GzipFile(REF / f'{name}.gcode.gz', 'wb', mtime=0) as g:
                g.write(gcode)
            shutil.copy(work / f'{name}-ref' / 'settings.json', REF / f'{name}.settings.json')
            print(f'{name}: {len(gcode)} bytes of reference G-code', file=sys.stderr)


if __name__ == '__main__':
    main()
