// Comprueba los cálculos de js/geo.js contra la referencia de process_gpx.py.
// Uso: node tools/test_geo.mjs
import { readFileSync } from 'node:fs';
import * as g from '../js/geo.js';

const { routes } = JSON.parse(readFileSync(new URL('../data/routes.json', import.meta.url)));
let fails = 0;
const check = (name, ok, info) => { console.log(`${ok ? 'OK  ' : 'FALLO'} ${name}: ${info}`); if (!ok) fails++; };

for (const { id } of routes) {
const raw = JSON.parse(readFileSync(new URL(`../data/${id}/route.json`, import.meta.url)));
console.log(`\n== ${raw.name} ==`);
for (const reversed of [false, true]) {
  const r = g.buildRoute(raw, reversed);
  const tag = reversed ? '[invertida]' : '[normal]';
  const ref = raw.reference;
  check(`${tag} distancia`, Math.abs(r.total - ref.distance_m) < 2, `${r.total.toFixed(0)} m vs ${ref.distance_m}`);
  const up = r.cumUp.at(-1), down = r.cumDown.at(-1);
  const [eu, ed] = reversed ? [ref.loss_m, ref.gain_m] : [ref.gain_m, ref.loss_m];
  // Al invertir, la histéresis puede variar unos metros: tolerancia 15 m
  check(`${tag} desnivel +`, Math.abs(up - eu) < 15, `${up.toFixed(0)} vs ${eu}`);
  check(`${tag} desnivel −`, Math.abs(down - ed) < 15, `${down.toFixed(0)} vs ${ed}`);
  const legSum = r.legs.reduce((s, l) => s + l.dist, 0);
  check(`${tag} suma de tramos = total`, Math.abs(legSum - r.total) < 1, `${legSum.toFixed(0)}`);
  check(`${tag} circular`, r.isLoop, `hueco ${r.loopGap.toFixed(0)} m`);
  const h = g.hoursBetween(r, 0, r.total, 1);
  console.log(`     tiempo DIN ritmo 1,0: ${h.toFixed(2)} h; tramos: ${r.legs.map((l) => l.from.num + '→' + l.to.num).join(' ')}`);

  // Proyección: posición a 20 m al este de cada punto. En las curvas puede caer en el
  // segmento vecino (es geométricamente correcto), así que se admite hasta ~1,3 puntos
  // de separación (100 m); lo que no se admite es un salto a otra parte de la ruta.
  // Excepción acotada: en el punto de giro de un tramo de ida y vuelta las dos ramas son
  // la misma línea y el desvío simulado puede caer sobre la otra. Se admite si el punto
  // elegido está en el mismo sitio (< 40 m) y el error es < 300 m; se cuentan aparte.
  let maxErr = 0, overlap = 0, hint = null;
  for (let i = 0; i < r.pts.length; i += 3) {
    const [lat, lon] = r.pts[i];
    const p = g.projectOnRoute(r, lat, lon + 20 / (111320 * Math.cos(lat * Math.PI / 180)), hint);
    const err = Math.abs(p.along - r.cum[i]);
    if (err >= 100 && err < 300 && g.haversine(g.pointAt(r, p.along), r.pts[i]) < 40) overlap++;
    else maxErr = Math.max(maxErr, err);
    hint = p.along;
  }
  check(`${tag} seguimiento GPS simulado`, maxErr < 100, `error máx. ${maxErr.toFixed(0)} m sobre el track`
    + (overlap ? ` (más ${overlap} puntos en la otra rama de un tramo de ida y vuelta)` : ''));
  // Puntos intermedios exactos sobre el track: error ~0
  let e2 = 0; hint = null;
  for (let a = 0; a < r.total; a += 137) {
    const [la, lo] = g.pointAt(r, a);
    const p = g.projectOnRoute(r, la, lo, hint); e2 = Math.max(e2, Math.abs(p.along - a)); hint = p.along;
  }
  check(`${tag} puntos sobre el track`, e2 < 2, `error máx. ${e2.toFixed(1)} m`);
  // En el inicio de una circular, sin pista previa, debe elegir el principio y no el final
  const p0 = g.projectOnRoute(r, r.pts[0][0], r.pts[0][1], null);
  check(`${tag} arranque en circular`, p0.along < 50, `along ${p0.along.toFixed(0)} m`);
}

// Recorded pace equivalence
const r = g.buildRoute(raw);
const din = g.hoursBetween(r, 0, r.total, 1);
console.log(`ritmo de la grabación ≈ ×${(raw.recorded.moving_s / 3600 / din).toFixed(2)} (en movimiento ${(raw.recorded.moving_s / 3600).toFixed(2)} h)`);

}

// Sol en la zona: 5/11/2026 y 15/9
const [lat, lon] = JSON.parse(readFileSync(new URL(`../data/${routes[0].id}/route.json`, import.meta.url))).points[0];
for (const d of [new Date('2026-11-05T12:00:00Z'), new Date('2026-09-15T12:00:00Z')]) {
  const s = g.sunTimes(d, lat, lon);
  const f = (x) => x.toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' });
  console.log(`sol ${d.toISOString().slice(0, 10)}: sale ${f(s.sunrise)} · se pone ${f(s.sunset)} · fin crepúsculo ${f(s.dusk)}`);
}
process.exit(fails ? 1 : 0);
