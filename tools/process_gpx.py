#!/usr/bin/env python3
"""Procesa un GPX (track de Wikiloc u otra app) y genera route.json para la app.

Uso:
    python3 tools/process_gpx.py data/<id>/track.gpx data/<id>/meta.json data/<id>/route.json

- track.gpx: el fichero original (se publica tal cual para descargarlo).
- meta.json: datos editados a mano (nombre, waypoints confirmados, notas...).
- route.json: salida que consume la app.

Las distancias, desniveles y tiempos los vuelve a calcular la app en el
navegador (para poder invertir el sentido); aquí se calculan las mismas
cifras como referencia y para verificar que ambos cálculos coinciden.
"""
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from datetime import datetime

NS = '{http://www.topografix.com/GPX/1/1}'
R = 6371008.8
GAIN_THRESHOLD = 3.0  # m; histéresis para no sumar ruido de altitud


def haversine(a, b):
    f1, f2 = math.radians(a[0]), math.radians(b[0])
    dp = f2 - f1
    dl = math.radians(b[1] - a[1])
    x = math.sin(dp / 2) ** 2 + math.cos(f1) * math.cos(f2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(x))


def gain_loss(ele):
    """Desnivel acumulado con histéresis (igual que la app, ver app.js)."""
    up = down = 0.0
    ref = ele[0]
    for e in ele[1:]:
        d = e - ref
        if d >= GAIN_THRESHOLD:
            up += d
            ref = e
        elif d <= -GAIN_THRESHOLD:
            down -= d
            ref = e
    return up, down


def strip_html(s):
    s = re.sub(r'<[^>]+>', ' ', s or '')
    return re.sub(r'\s+', ' ', s).strip()


def main(gpx_path, meta_path, out_path):
    root = ET.parse(gpx_path).getroot()
    pts, times = [], []
    for t in root.iter(NS + 'trkpt'):
        e = t.find(NS + 'ele')
        tm = t.find(NS + 'time')
        pts.append([float(t.get('lat')), float(t.get('lon')), float(e.text) if e is not None else None])
        times.append(datetime.fromisoformat(tm.text.replace('Z', '+00:00')) if tm is not None else None)

    # Distancia acumulada
    cum = [0.0]
    for i in range(1, len(pts)):
        cum.append(cum[-1] + haversine(pts[i - 1], pts[i]))

    # Sin suavizado: con un punto cada ~70 m, suavizar borra relieve real.
    # El ruido se filtra con la histéresis de gain_loss().
    raw = [p[2] for p in pts]
    ele = raw
    up, down = gain_loss(ele)

    # Tiempos de la grabación original (referencia, no estimación propia)
    rec = None
    if all(times):
        total = (times[-1] - times[0]).total_seconds()
        moving = 0.0
        for i in range(len(pts) - 1):
            dt = (times[i + 1] - times[i]).total_seconds()
            d = cum[i + 1] - cum[i]
            if dt > 0 and d / dt * 3.6 >= 1.0:  # < 1 km/h se considera parado
                moving += dt
        rec = {
            'date': times[0].date().isoformat(),
            'total_s': round(total),
            'moving_s': round(moving),
            'offsets_s': [round((t - times[0]).total_seconds()) for t in times],
        }

    desc_el = root.find(f'{NS}trk/{NS}desc')
    desc = desc_el.text if desc_el is not None else ''
    videos = re.findall(r'youtube\.com/embed/([\w-]+)', desc or '')
    link_el = root.find(f'{NS}metadata/{NS}link')

    meta = json.load(open(meta_path, encoding='utf-8'))

    # Waypoints: se indican por índice de punto del track en meta.json
    wps = []
    for w in meta.get('waypoints', []):
        i = w['idx']
        wps.append({**w, 'lat': pts[i][0], 'lon': pts[i][1]})

    lats = [p[0] for p in pts]
    lons = [p[1] for p in pts]
    out = {
        'id': meta['id'],
        'name': meta['name'],
        'zone': meta.get('zone', ''),
        'notes': meta.get('notes', []),
        'source': {
            'url': link_el.get('href') if link_el is not None else None,
            'videos': [f'https://www.youtube.com/watch?v={v}' for v in videos],
            'description': strip_html(desc),
            'gpx': 'track.gpx',
        },
        'points': [[round(p[0], 6), round(p[1], 6), round(e, 1)] for p, e in zip(pts, ele)],
        'recorded': rec,
        'waypoints': wps,
        'bounds': [[min(lats), min(lons)], [max(lats), max(lons)]],
        'reference': {
            'distance_m': round(cum[-1]),
            'gain_m': round(up),
            'loss_m': round(down),
            'ele_min': round(min(ele)),
            'ele_max': round(max(ele)),
            'points': len(pts),
            'loop_gap_m': round(haversine(pts[0], pts[-1])),
        },
    }
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(json.dumps(out['reference'], ensure_ascii=False))
    if rec:
        print('grabación: total', rec['total_s'] / 3600, 'h · en movimiento', rec['moving_s'] / 3600, 'h')


if __name__ == '__main__':
    main(*sys.argv[1:4])
