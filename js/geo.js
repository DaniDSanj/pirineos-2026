// Cálculos de la ruta: distancias, desnivel, tiempos, posición sobre el track y sol.
// Sin dependencias, para poder probarlo también en Node (tools/test_geo.mjs).

const R = 6371008.8;
export const GAIN_THRESHOLD = 3; // m, igual que tools/process_gpx.py
export const LOOP_MAX_GAP = 150; // m entre inicio y fin para considerar la ruta circular

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function haversine(a, b) {
  const f1 = rad(a[0]), f2 = rad(b[0]);
  const dp = f2 - f1, dl = rad(b[1] - a[1]);
  const x = Math.sin(dp / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export function bearing(a, b) {
  const f1 = rad(a[0]), f2 = rad(b[0]), dl = rad(b[1] - a[1]);
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

// Clases de pendiente (valor absoluto, %). Mismos colores en mapa, perfil y leyenda.
export const SLOPE_CLASSES = [
  { max: 8, label: 'Suave', hint: 'menos del 8 %', color: '#3b9c5a' },
  { max: 15, label: 'Moderada', hint: '8–15 %', color: '#e3b505' },
  { max: 25, label: 'Fuerte', hint: '15–25 %', color: '#ea7317' },
  { max: 35, label: 'Muy fuerte', hint: '25–35 %', color: '#cf2a2a' },
  { max: Infinity, label: 'Extrema', hint: 'más del 35 %', color: '#6b2d8f' },
];
export const slopeClass = (g) => SLOPE_CLASSES.findIndex((c) => Math.abs(g) < c.max);

/**
 * Prepara la ruta para la app. `raw` es el route.json; `reversed` invierte el sentido.
 * Devuelve puntos, distancias y desniveles acumulados, pendientes, waypoints y tramos.
 */
export function buildRoute(raw, reversed = false) {
  let pts = raw.points.map((p) => [p[0], p[1], p[2]]);
  const n = pts.length;
  if (reversed) pts = pts.reverse();
  const mapIdx = (i) => (reversed ? n - 1 - i : i);

  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));

  // Desnivel acumulado con histéresis (filtra el ruido de altitud del GPS)
  const cumUp = [0], cumDown = [0];
  let ref = pts[0][2], up = 0, down = 0;
  for (let i = 1; i < n; i++) {
    const d = pts[i][2] - ref;
    if (d >= GAIN_THRESHOLD) { up += d; ref = pts[i][2]; }
    else if (d <= -GAIN_THRESHOLD) { down -= d; ref = pts[i][2]; }
    cumUp.push(up); cumDown.push(down);
  }

  // Pendiente por segmento, medida sobre una ventana de ≥250 m para no exagerar el ruido
  const grade = [];
  for (let i = 0; i < n - 1; i++) {
    let a = i, b = i + 1;
    while (cum[b] - cum[a] < 250 && (a > 0 || b < n - 1)) {
      if (a > 0) a--;
      if (cum[b] - cum[a] < 250 && b < n - 1) b++;
    }
    grade.push(((pts[b][2] - pts[a][2]) / (cum[b] - cum[a])) * 100);
  }

  const total = cum[n - 1];
  const loopGap = haversine(pts[0], pts[n - 1]);
  const isLoop = loopGap <= LOOP_MAX_GAP;

  // Waypoints en el sentido elegido
  let wps = raw.waypoints.map((w) => {
    const idx = mapIdx(w.idx);
    return { ...w, idx, along: cum[idx], ele: pts[idx][2] };
  });
  // El punto de inicio de un track circular, al invertir, queda al final: lo duplicamos
  // como inicio y como fin para que los tramos empiecen y acaben en él.
  const startWp = raw.waypoints.find((w) => w.type === 'start');
  wps = wps.filter((w) => w.type !== 'start');
  const first = { id: 'start', idx: 0, along: 0, ele: pts[0][2], type: 'start',
    name: startWp && (isLoop || !reversed) ? startWp.name : 'Inicio',
    note: startWp && (isLoop || !reversed) ? startWp.note : '', confirmed: startWp?.confirmed ?? false };
  const last = { id: 'end', idx: n - 1, along: total, ele: pts[n - 1][2], type: 'end',
    name: isLoop && startWp ? startWp.name : (reversed && startWp ? startWp.name : 'Fin'),
    note: isLoop ? 'Llegada al punto de partida.' : '', confirmed: startWp?.confirmed ?? false };
  wps.sort((a, b) => a.along - b.along);
  const stops = [first, ...wps, last];
  // Numeración solo para los puntos intermedios (la salida y la llegada tienen su propio símbolo)
  stops.forEach((w, k) => { w.num = w.type === 'start' || w.type === 'end' ? null : k; });

  const route = { raw, reversed, pts, cum, cumUp, cumDown, grade, total, isLoop, loopGap, stops };
  route.legs = stops.slice(0, -1).map((a, k) => {
    const b = stops[k + 1];
    const r = rangeStats(route, a.along, b.along);
    return { from: a, to: b, ...r, avgGrade: ((b.ele - a.ele) / Math.max(1, r.dist)) * 100 };
  });
  return route;
}

// Interpola una magnitud acumulada (cum, cumUp...) en una distancia `along` del track
function interp(route, arr, along) {
  const { cum } = route;
  if (along <= 0) return arr[0];
  if (along >= route.total) return arr[arr.length - 1];
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= along) lo = m; else hi = m; }
  const t = (along - cum[lo]) / (cum[hi] - cum[lo] || 1);
  return arr[lo] + (arr[hi] - arr[lo]) * t;
}

export function pointAt(route, along) {
  const lat = interp(route, route.pts.map((p) => p[0]), along);
  const lon = interp(route, route.pts.map((p) => p[1]), along);
  const ele = interp(route, route.pts.map((p) => p[2]), along);
  return [lat, lon, ele];
}

export function segmentIndexAt(route, along) {
  const { cum } = route;
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < along) i++;
  return i;
}

/** Distancia y desnivel entre dos posiciones del track (en metros desde el inicio). */
export function rangeStats(route, a, b) {
  return {
    dist: Math.max(0, b - a),
    up: Math.max(0, interp(route, route.cumUp, b) - interp(route, route.cumUp, a)),
    down: Math.max(0, interp(route, route.cumDown, b) - interp(route, route.cumDown, a)),
  };
}

/**
 * Tiempo de marcha (horas) según la norma DIN 33466, la que usan muchas
 * señalizaciones de montaña: 4 km/h en llano, 300 m/h de subida y 500 m/h de bajada;
 * se toma el mayor de (horizontal, vertical) más la mitad del menor.
 * `pace` multiplica el resultado (1 = ritmo de referencia; 1,2 = un 20 % más lento).
 */
export const DIN = { kmh: 4, upH: 300, downH: 500 };
export function walkHours(dist, up, down, pace = 1) {
  const th = dist / 1000 / DIN.kmh;
  const tv = up / DIN.upH + down / DIN.downH;
  return (Math.max(th, tv) + Math.min(th, tv) / 2) * pace;
}

/** Tiempo desde `along` hasta `target` respetando los tramos (como lo calcularía la señalización). */
export function hoursBetween(route, from, to, pace = 1) {
  let h = 0;
  for (const leg of route.legs) {
    const a = Math.max(from, leg.from.along), b = Math.min(to, leg.to.along);
    if (b <= a) continue;
    const r = rangeStats(route, a, b);
    h += walkHours(r.dist, r.up, r.down, pace);
  }
  return h;
}

/**
 * Proyecta una posición GPS sobre el track.
 * Con `hint` (posición anterior sobre el track) se prefiere la solución más cercana a ella,
 * para no "saltar" al final en rutas circulares que pasan dos veces por la misma zona.
 */
export function projectOnRoute(route, lat, lon, hint = null) {
  const { pts, cum } = route;
  const kx = Math.cos(rad(lat)) * 111320, ky = 110574;
  const cands = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = (pts[i][1] - lon) * kx, ay = (pts[i][0] - lat) * ky;
    const bx = (pts[i + 1][1] - lon) * kx, by = (pts[i + 1][0] - lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const px = ax + t * dx, py = ay + t * dy;
    cands.push({ i, t, dist: Math.hypot(px, py), along: cum[i] + t * (cum[i + 1] - cum[i]) });
  }
  const best = cands.reduce((m, c) => (c.dist < m.dist ? c : m));
  // Soluciones casi igual de cercanas (≤ 40 m más lejos que la mejor), agrupadas en
  // "pasadas": candidatos a menos de 300 m de distancia recorrida son la misma pasada.
  const near = cands.filter((c) => c.dist <= best.dist + 40).sort((a, b) => a.along - b.along);
  const passes = [];
  for (const c of near) {
    const last = passes.at(-1);
    if (last && c.along - last.lastAlong < 300) {
      if (c.dist < last.best.dist) last.best = c;
      last.lastAlong = c.along;
    } else passes.push({ best: c, lastAlong: c.along });
  }
  if (passes.length === 1) return passes[0].best;
  // Varias pasadas por la misma zona: sin pista, la primera; con pista, la más próxima a ella
  if (hint == null) return passes[0].best;
  return passes.reduce((m, p) => (Math.abs(p.best.along - hint) < Math.abs(m.best.along - hint) ? p : m)).best;
}

// ---------- Sol (algoritmo del Almanaque Náutico / NOAA simplificado) ----------
function sunEvent(date, lat, lon, zenith, rising) {
  const start = Date.UTC(date.getFullYear(), 0, 0);
  const today = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const N = Math.round((today - start) / 864e5);
  const lngHour = lon / 15;
  const t = N + ((rising ? 6 : 18) - lngHour) / 24;
  const M = 0.9856 * t - 3.289;
  let L = M + 1.916 * Math.sin(rad(M)) + 0.02 * Math.sin(rad(2 * M)) + 282.634;
  L = ((L % 360) + 360) % 360;
  let RA = deg(Math.atan(0.91764 * Math.tan(rad(L))));
  RA = ((RA % 360) + 360) % 360;
  RA = (RA + Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90) / 15;
  const sinDec = 0.39782 * Math.sin(rad(L));
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.cos(rad(zenith)) - sinDec * Math.sin(rad(lat))) / (cosDec * Math.cos(rad(lat)));
  if (cosH > 1 || cosH < -1) return null;
  const H = (rising ? 360 - deg(Math.acos(cosH)) : deg(Math.acos(cosH))) / 15;
  const T = H + RA - 0.06571 * t - 6.622;
  const UT = (((T - lngHour) % 24) + 24) % 24;
  return new Date(today + UT * 36e5);
}

/** Salida y puesta de sol, y fin del crepúsculo civil (cuando ya no se ve sin linterna). */
export function sunTimes(date, lat, lon) {
  return {
    sunrise: sunEvent(date, lat, lon, 90.833, true),
    sunset: sunEvent(date, lat, lon, 90.833, false),
    dusk: sunEvent(date, lat, lon, 96, false),
  };
}
