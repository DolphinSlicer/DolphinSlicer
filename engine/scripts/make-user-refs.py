#!/usr/bin/env python3
"""Desktop G-code for the user-preset test (engine/test/presets-user.mjs).

For each set in engine/test/fixtures/presets/user/ (desktop/, engine/), the desktop CLI slices
fixtures/cube.3mf with that set's printer, process and filament user presets, loaded from a data
folder laid out as desktop's (system/ with the vendor profiles, user/default/<machine|process|
filament>/ with the presets), as desktop loads them on start-up.
  -> fixtures/presets/user/<set>.gcode.gz, <set>.settings.json.gz
Usage: make-user-refs.py   (needs docker; export the engine set first: presets-user.mjs st --export)
"""
import importlib.util
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True  # no __pycache__ next to the scripts
spec = importlib.util.spec_from_file_location('refs', Path(__file__).with_name('make-preset-refs.py'))
refs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refs)
USER = refs.OUT / 'user'


def main():
    with tempfile.TemporaryDirectory() as td:
        work = Path(td)
        shutil.copy(refs.FIX / 'cube.3mf', work / 'cube.3mf')
        for s in ('desktop', 'engine'):
            data = work / f'data-{s}'
            for v in ('Custom', 'OrcaFilamentLibrary'):
                shutil.copytree(refs.PROFILES / v, data / 'system' / v)
                shutil.copy(refs.PROFILES / f'{v}.json', data / 'system' / f'{v}.json')
            files = {}
            for folder in ('machine', 'process', 'filament'):
                shutil.copytree(USER / s / folder, data / 'user' / 'default' / folder)
                (f,) = sorted((USER / s / folder).glob('*.json'))
                files[folder] = f'/w/data-{s}/user/default/{folder}/{f.name}'
            r = refs.subprocess.run(
                ['docker', 'run', '--rm', '-u', f'{refs.os.getuid()}:{refs.os.getgid()}', '-v', f'{work}:/w', '-w', '/w',
                 refs.REF_IMAGE, '--datadir', f'/w/data-{s}',
                 '--load-settings', f"{files['machine']};{files['process']}", '--load-filaments', files['filament'],
                 '--arrange', '0', '--slice', '0', '--outputdir', f'/w/{s}', '--export-settings', f'/w/{s}/settings.json',
                 'cube.3mf'], capture_output=True, text=True)
            if r.returncode:
                sys.exit(f'{s}: desktop CLI failed ({r.returncode}): {(r.stdout + r.stderr)[-800:]}')
            gcode = (work / s / 'plate_1.gcode').read_bytes()
            refs.write_gz(USER / f'{s}.gcode.gz', gcode)
            refs.write_gz(USER / f'{s}.settings.json.gz', (work / s / 'settings.json').read_bytes())
            print(f'{s}: {len(gcode)} bytes', file=sys.stderr)


if __name__ == '__main__':
    main()
