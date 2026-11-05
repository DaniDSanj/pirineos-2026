#!/usr/bin/env python3
"""Descarga las teselas del IGN que cubren cada ruta, para usarlas sin conexión.

Uso:
    python3 tools/fetch_tiles.py            # todas las rutas de data/routes.json

Fuentes (datos abiertos del IGN, licencia CC BY 4.0, atribución "© IGN"):
- mtn:  Mapa topográfico (servicio WMTS mapa-raster, capa MTN)
- pnoa: Ortofoto PNOA máxima actualidad (servicio WMTS pnoa-ma)

Escribe tiles/<capa>/<z>/<x>/<y>.jpg y tiles/index.json (lista para la caché offline).
Las teselas ya descargadas no se vuelven a pedir.
"""
import json
import math
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUFFER_M = 500
ZOOMS = range(12, 17)  # 16 ≈ 1,7 m/píxel a esta latitud; más cerca, la app amplía la 16
LAYERS = {
    'mtn': 'https://www.ign.es/wmts/mapa-raster?service=WMTS&request=GetTile&version=1.0.0'
           '&layer=MTN&style=default&tilematrixset=GoogleMapsCompatible'
           '&tilematrix={z}&tilerow={y}&tilecol={x}&format=image/jpeg',
    'pnoa': 'https://www.ign.es/wmts/pnoa-ma?service=WMTS&request=GetTile&version=1.0.0'
            '&layer=OI.OrthoimageCoverage&style=default&tilematrixset=GoogleMapsCompatible'
            '&tilematrix={z}&tilerow={y}&tilecol={x}&format=image/jpeg',
}
UA = 'pirineos-2026-offline-trail-guide (uso personal)'


def tile_xy(lat, lon, z):
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


def tiles_for(bounds):
    (s, w), (n, e) = bounds
    dlat = BUFFER_M / 111320
    dlon = BUFFER_M / (111320 * math.cos(math.radians((s + n) / 2)))
    s, w, n, e = s - dlat, w - dlon, n + dlat, e + dlon
    for z in ZOOMS:
        x0, y0 = tile_xy(n, w, z)
        x1, y1 = tile_xy(s, e, z)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                yield z, x, y


def compose_from_children(layer, z, x, y, path):
    try:
        from PIL import Image
    except ImportError:
        return False
    kids = [(dx, dy, os.path.join(ROOT, 'tiles', layer, str(z + 1), str(2 * x + dx), f'{2 * y + dy}.jpg'))
            for dx in (0, 1) for dy in (0, 1)]
    if not all(os.path.exists(k[2]) for k in kids):
        return False
    canvas = Image.new('RGB', (512, 512))
    for dx, dy, k in kids:
        canvas.paste(Image.open(k).convert('RGB').resize((256, 256)), (dx * 256, dy * 256))
    canvas.resize((256, 256), Image.LANCZOS).save(path, 'JPEG', quality=85)
    return True


def main():
    routes = json.load(open(os.path.join(ROOT, 'data', 'routes.json'), encoding='utf-8'))
    wanted = set()
    for r in routes['routes']:
        route = json.load(open(os.path.join(ROOT, 'data', r['id'], 'route.json'), encoding='utf-8'))
        wanted.update(tiles_for(route['bounds']))
    wanted = sorted(wanted)
    total_bytes, fetched, errors = 0, 0, []
    for layer, url in LAYERS.items():
        for z, x, y in wanted:
            path = os.path.join(ROOT, 'tiles', layer, str(z), str(x), f'{y}.jpg')
            if not os.path.exists(path):
                os.makedirs(os.path.dirname(path), exist_ok=True)
                req = urllib.request.Request(url.format(z=z, x=x, y=y), headers={'User-Agent': UA})
                try:
                    with urllib.request.urlopen(req, timeout=30) as resp:
                        body = resp.read()
                        if not resp.headers.get('Content-Type', '').startswith('image/'):
                            raise ValueError('respuesta no es imagen')
                    with open(path, 'wb') as f:
                        f.write(body)
                    fetched += 1
                    time.sleep(0.05)  # no saturar el servidor del IGN
                except Exception as ex:  # noqa: BLE001
                    # Algunas teselas fallan siempre en el servidor (502). Si existen
                    # las 4 hijas del nivel siguiente, se compone a partir de ellas.
                    if not compose_from_children(layer, z, x, y, path):
                        errors.append((layer, z, x, y, str(ex)))
                        continue
                    print(f'  {layer} {z}/{x}/{y}: compuesta desde el nivel {z + 1} ({ex})')
            total_bytes += os.path.getsize(path)
    index = {
        'zooms': [min(ZOOMS), max(ZOOMS)],
        'layers': list(LAYERS),
        'tiles': [f'{z}/{x}/{y}' for z, x, y in wanted],
    }
    with open(os.path.join(ROOT, 'tiles', 'index.json'), 'w') as f:
        json.dump(index, f, separators=(',', ':'))
    print(f'{len(wanted)} teselas por capa · {fetched} descargadas ahora · '
          f'{total_bytes / 1e6:.1f} MB en total · {len(errors)} errores')
    for e in errors[:10]:
        print('  ERROR', e)
    sys.exit(1 if errors else 0)


if __name__ == '__main__':
    main()
