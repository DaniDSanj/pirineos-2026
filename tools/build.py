#!/usr/bin/env python3
"""Prepara una versión para publicar.

1. Regenera route.json de cada ruta a partir de su GPX y su meta.json.
2. Escribe la versión (fecha-hora) en js/version.js y sw.js.
3. Escribe en sw.js la lista de ficheros que se guardan en el móvil
   (todo menos los mapas, que se guardan aparte y se conservan entre versiones).

Uso: python3 tools/build.py
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXCLUDE_DIRS = {'.git', 'tools', 'tiles', 'node_modules', '.github'}
EXCLUDE_FILES = {'sw.js', 'package.json', 'README.md', '.nojekyll', 'meta.json'}


def main():
    routes = json.load(open(os.path.join(ROOT, 'data', 'routes.json'), encoding='utf-8'))
    for r in routes['routes']:
        d = os.path.join(ROOT, 'data', r['id'])
        subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'process_gpx.py'),
                        os.path.join(d, 'track.gpx'), os.path.join(d, 'meta.json'), os.path.join(d, 'route.json')],
                       check=True)

    madrid = timezone(timedelta(hours=1))
    version = datetime.now(madrid).strftime('%Y.%m.%d-%H%M')

    with open(os.path.join(ROOT, 'js', 'version.js'), 'w', encoding='utf-8') as f:
        f.write(f"export const VERSION = '{version}';\n")

    shell = ['./']
    for base, dirs, files in os.walk(ROOT):
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDE_DIRS)
        for f in sorted(files):
            if f in EXCLUDE_FILES or f.startswith('.') or f.endswith('.txt') or f == 'LICENSE':
                continue
            rel = os.path.relpath(os.path.join(base, f), ROOT).replace(os.sep, '/')
            shell.append(rel)
    shell.append('tiles/index.json')

    sw_path = os.path.join(ROOT, 'sw.js')
    sw = open(sw_path, encoding='utf-8').read()
    block = (f"// BUILD:START\nconst VERSION = '{version}';\nconst SHELL = "
             + json.dumps(shell, indent=2) + ";\n// BUILD:END")
    sw = re.sub(r'// BUILD:START.*?// BUILD:END', lambda _: block, sw, flags=re.S)
    open(sw_path, 'w', encoding='utf-8').write(sw)
    print(f'Versión {version}: {len(shell)} ficheros en la app (más los mapas).')


if __name__ == '__main__':
    main()
