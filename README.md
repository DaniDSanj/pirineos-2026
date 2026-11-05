# Pirineos 2026

Guía de rutas para el móvil que funciona sin cobertura (app web instalable).

- Enlace: https://danidsanj.github.io/pirineos-2026/
- Cada ruta vive en `data/<id>/`: `track.gpx` (original), `meta.json` (nombres y puntos clave, editado a mano) y `route.json` (generado).
- Mapas: teselas del IGN (MTN y ortofoto PNOA, CC BY 4.0) en `tiles/`, descargadas con `tools/fetch_tiles.py`.

## Publicar una versión

```
python3 tools/fetch_tiles.py   # solo si hay rutas nuevas
python3 tools/build.py         # regenera datos, versión y lista offline
node tools/test_geo.mjs        # comprueba los cálculos
```
