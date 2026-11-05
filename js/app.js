// Pirineos 2026: guía de ruta sin conexión.
import * as G from './geo.js';
import { VERSION } from './version.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Formatos (es-ES) ----------
const nf1 = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });
const fmtKm = (m) => (m < 1000 ? `${nf0.format(Math.round(m / 10) * 10)} m` : `${nf1.format(m / 1000)} km`);
const fmtM = (m) => `${nf0.format(Math.round(m))} m`;
const fmtDur = (h) => {
  const min = Math.max(0, Math.round((h * 60) / 5) * 5);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
};
const fmtClock = (d) => d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
const stopLabel = (s) => (s.type === 'start' ? 'S' : s.type === 'end' ? 'L' : String(s.num));
const stopTitle = (s) => (s.type === 'start' ? `Salida: ${s.name}` : s.type === 'end' ? `Llegada: ${s.name}` : s.name);

// ---------- Estado ----------
const PACES = [
  { id: 'tranquilo', factor: 1.2, label: 'Tranquilo', note: 'Un 20 % más lento que la referencia' },
  { id: 'normal', factor: 1.0, label: 'Normal', note: 'Referencia de montaña (DIN 33466)' },
  { id: 'agil', factor: 0.85, label: 'Ágil', note: 'Un 15 % más rápido' },
  { id: 'track', factor: null, label: 'Como el track', note: 'Ritmo de quien lo grabó' },
];
const S = {
  routes: [], raw: null, route: null,
  reversed: false, paceId: 'normal', layer: 'mtn',
  fix: null, proj: null, watchId: null, follow: false, wakeLock: null,
  cursor: null,
};
const settingsKey = () => `pir26:${S.raw?.id || 'x'}`;
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(settingsKey()) || '{}');
    if (typeof s.reversed === 'boolean') S.reversed = s.reversed;
    if (PACES.some((p) => p.id === s.paceId)) S.paceId = s.paceId;
    if (s.layer === 'mtn' || s.layer === 'pnoa') S.layer = s.layer;
  } catch { /* sin almacenamiento: valores por defecto */ }
}
function saveSettings() {
  try { localStorage.setItem(settingsKey(), JSON.stringify({ reversed: S.reversed, paceId: S.paceId, layer: S.layer })); } catch { /* nada */ }
}
function trackPace() {
  const rec = S.raw?.recorded;
  if (!rec?.moving_s) return null;
  const din = G.hoursBetween(G.buildRoute(S.raw, false), 0, Infinity, 1);
  return Math.round((rec.moving_s / 3600 / din) * 100) / 100;
}
function pace() {
  const p = PACES.find((x) => x.id === S.paceId);
  return p.factor ?? trackPace() ?? 1;
}

// ---------- Arranque ----------
async function init() {
  $('appVersion').textContent = `Versión ${VERSION}.`;
  setupTabs();
  setupInstallHint();
  registerSW();
  try {
    const list = await (await fetch('data/routes.json')).json();
    S.routes = list.routes;
    const sel = $('routeSelect');
    if (S.routes.length > 1) {
      sel.hidden = false;
      sel.innerHTML = S.routes.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
      sel.addEventListener('change', () => loadRoute(sel.value));
    }
    const fromHash = location.hash.slice(1);
    await loadRoute(S.routes.some((r) => r.id === fromHash) ? fromHash : S.routes[0].id);
  } catch (e) {
    $('routeName').textContent = 'No se pudo cargar la ruta';
    $('routeSub').textContent = 'Abre la guía una vez con cobertura para guardarla en el móvil.';
    console.error(e);
  }
  setupGps();
  setupWakeLock();
  prepareOffline();
}

async function loadRoute(id) {
  S.raw = await (await fetch(`data/${id}/route.json`)).json();
  S.raw.base = `data/${id}/`;
  loadSettings();
  S.proj = null;
  rebuild();
  initMap();
  fitRoute();
}

function rebuild() {
  S.route = G.buildRoute(S.raw, S.reversed);
  if (S.fix) S.proj = null; // recalcular la posición en el nuevo sentido
  $('routeName').textContent = S.raw.name;
  $('routeSub').textContent = [S.raw.zone, S.route.isLoop ? 'circular' : 'lineal', S.reversed ? 'sentido inverso' : null].filter(Boolean).join(', ');
  if (map) drawTrack();
  drawProfile();
  renderFicha();
  if (S.fix) onFix(S.fix); else renderLive();
}

// ---------- Pestañas ----------
function setupTabs() {
  document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
}
function showTab(name) {
  document.querySelectorAll('.tabbar button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== `tab-${name}`; });
  window.scrollTo(0, 0);
  if (name === 'ruta' && map) setTimeout(() => { map.invalidateSize(); drawProfile(); }, 30);
}

// ---------- Mapa ----------
let map, layers, trackGroup, meMarker, meAccuracy, cursorMarker;
function initMap() {
  const [[s, w], [n, e]] = S.raw.bounds;
  const dLat = 500 / 111320, dLon = 500 / (111320 * Math.cos(((s + n) / 2) * Math.PI / 180));
  const tileBounds = L.latLngBounds([s - dLat, w - dLon], [n + dLat, e + dLon]);
  if (!map) {
    map = L.map('map', {
      zoomControl: false, minZoom: 12, maxZoom: 18,
      maxBounds: tileBounds.pad(1.5), maxBoundsViscosity: 0.8, tap: true,
    });
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
    map.on('dragstart', () => setFollow(false));
    $('btnLayer').addEventListener('click', () => { S.layer = S.layer === 'mtn' ? 'pnoa' : 'mtn'; saveSettings(); setLayer(); });
    $('btnFit').addEventListener('click', () => { setFollow(false); fitRoute(); });
    $('btnLocate').addEventListener('click', () => {
      if (!S.fix) { startGps(); setFollow(true); return; }
      setFollow(true);
      map.setView([S.fix.lat, S.fix.lon], Math.max(map.getZoom(), 15));
    });
  }
  if (layers) Object.values(layers).forEach((l) => map.removeLayer(l));
  const opts = { minZoom: 12, maxNativeZoom: 16, maxZoom: 18, bounds: tileBounds, keepBuffer: 4 };
  layers = {
    mtn: L.tileLayer('tiles/mtn/{z}/{x}/{y}.jpg', { ...opts, attribution: 'Mapa © <a href="https://www.ign.es">IGN</a>' }),
    pnoa: L.tileLayer('tiles/pnoa/{z}/{x}/{y}.jpg', { ...opts, attribution: 'Ortofoto PNOA © <a href="https://www.ign.es">IGN</a>' }),
  };
  setLayer();
  drawTrack();
}
function setLayer() {
  Object.entries(layers).forEach(([k, l]) => (k === S.layer ? l.addTo(map) : map.removeLayer(l)));
  layers[S.layer].bringToBack();
  $('btnLayer').textContent = S.layer === 'mtn' ? 'Foto' : 'Mapa';
}
function fitRoute() {
  const b = L.latLngBounds(S.route.pts.map((p) => [p[0], p[1]]));
  map.fitBounds(b, { padding: [24, 24] });
}
function setFollow(on) {
  S.follow = on;
  $('btnLocate').classList.toggle('is-on', on);
}

function drawTrack() {
  if (trackGroup) map.removeLayer(trackGroup);
  trackGroup = L.layerGroup().addTo(map);
  const r = S.route;
  const ll = r.pts.map((p) => [p[0], p[1]]);
  L.polyline(ll, { color: '#fff', weight: 9, opacity: 0.9, interactive: false }).addTo(trackGroup);
  // Tramos coloreados por pendiente (agrupando segmentos consecutivos de la misma clase)
  let runStart = 0;
  for (let i = 1; i <= r.grade.length; i++) {
    const cls = G.slopeClass(r.grade[runStart]);
    if (i === r.grade.length || G.slopeClass(r.grade[i]) !== cls) {
      L.polyline(ll.slice(runStart, i + 1), { color: G.SLOPE_CLASSES[cls].color, weight: 5, opacity: 1, interactive: false }).addTo(trackGroup);
      runStart = i;
    }
  }
  // Línea invisible ancha para poder tocar el track
  L.polyline(ll, { color: '#000', weight: 26, opacity: 0 })
    .on('click', (e) => setCursor(G.projectOnRoute(r, e.latlng.lat, e.latlng.lng, S.cursor).along, 'map'))
    .addTo(trackGroup);
  // Flechas de sentido cada 600 m
  for (let a = 300; a < r.total - 150; a += 600) {
    const p1 = G.pointAt(r, a - 25), p2 = G.pointAt(r, a + 25), p = G.pointAt(r, a);
    const b = G.bearing(p1, p2);
    L.marker([p[0], p[1]], {
      interactive: false, keyboard: false,
      icon: L.divIcon({ className: 'arrow-icon', iconSize: [18, 18],
        html: `<svg width="18" height="18" viewBox="0 0 18 18" style="transform:rotate(${b}deg)"><path d="M4 13 9 4l5 9-5-3z" fill="#1d2b2f" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>` }),
    }).addTo(trackGroup);
  }
  // Puntos clave
  for (const s of r.stops) {
    if (s.type === 'end' && r.isLoop) continue; // en circular coincide con la salida
    const p = r.pts[s.idx];
    const cls = `wp-icon${s.type === 'start' ? ' is-start' : ''}${s.confirmed ? '' : ' is-pending'}`;
    const label = s.type === 'start' && r.isLoop ? 'S' : stopLabel(s);
    L.marker([p[0], p[1]], {
      title: stopTitle(s),
      icon: L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html: `<span class="${cls}">${label}</span>` }),
    }).bindPopup(wpPopup(s)).addTo(trackGroup);
  }
  if (S.fix) drawMe();
  if (S.cursor != null) setCursor(S.cursor, 'redraw');
}
function wpPopup(s) {
  const pending = s.confirmed ? '' : '<br><em>Propuesto a partir del perfil, sin confirmar.</em>';
  return `<strong>${esc(stopTitle(s))}</strong><br>km ${nf1.format(s.along / 1000)}, ${fmtM(s.ele)}${s.note ? `<br>${esc(s.note)}` : ''}${pending}`;
}
function drawMe() {
  const { lat, lon, acc } = S.fix;
  if (!meMarker) {
    meAccuracy = L.circle([lat, lon], { radius: acc, color: '#1d2b2f', weight: 1, fillColor: '#f2c300', fillOpacity: 0.15, interactive: false }).addTo(map);
    meMarker = L.circleMarker([lat, lon], { radius: 9, color: '#1d2b2f', weight: 3, fillColor: '#f2c300', fillOpacity: 1 }).addTo(map);
  } else {
    meMarker.setLatLng([lat, lon]).bringToFront();
    meAccuracy.setLatLng([lat, lon]).setRadius(acc);
  }
  if (S.follow) map.panTo([lat, lon]);
}

// ---------- Cursor compartido mapa / perfil ----------
function setCursor(along, from) {
  S.cursor = along;
  const p = G.pointAt(S.route, along);
  if (map) {
    if (!cursorMarker) cursorMarker = L.circleMarker([p[0], p[1]], { radius: 7, color: '#1d2b2f', weight: 3, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(map);
    else cursorMarker.setLatLng([p[0], p[1]]).addTo(map);
    if (from === 'profile' && !map.getBounds().pad(-0.1).contains([p[0], p[1]])) map.panTo([p[0], p[1]]);
  }
  drawProfileCursor();
}

// ---------- Perfil ----------
const PF = { l: 34, r: 8, t: 22, b: 20, h: 170 };
let pfScale = null;
function drawProfile() {
  const svg = $('profile');
  const w = svg.clientWidth || 340;
  const r = S.route;
  const eles = r.pts.map((p) => p[2]);
  const step = 100;
  const emin = Math.floor(Math.min(...eles) / step) * step;
  const emax = Math.ceil(Math.max(...eles) / step) * step;
  const x = (d) => PF.l + (d / r.total) * (w - PF.l - PF.r);
  const y = (e) => PF.t + ((emax - e) / (emax - emin)) * (PF.h - PF.t - PF.b);
  const base = PF.h - PF.b;
  pfScale = { x, y, w };
  let s = `<g>`;
  for (let e = emin; e <= emax; e += step) {
    s += `<line x1="${PF.l}" x2="${w - PF.r}" y1="${y(e)}" y2="${y(e)}" stroke="#c5d0cc" stroke-width="1"/>`;
    if ((e - emin) % (step * 2) === 0 || emax - emin <= 400) s += `<text x="${PF.l - 4}" y="${y(e) + 4}" text-anchor="end">${e}</text>`;
  }
  const kmStep = r.total > 15000 ? 5 : r.total > 6000 ? 2 : 1;
  for (let k = 0; k * 1000 <= r.total; k += kmStep) s += `<text x="${x(k * 1000)}" y="${PF.h - 4}" text-anchor="middle">${k} km</text>`;
  s += `</g><g>`;
  for (let i = 0; i < r.pts.length - 1; i++) {
    const c = G.SLOPE_CLASSES[G.slopeClass(r.grade[i])].color;
    const x1 = x(r.cum[i]), x2 = x(r.cum[i + 1]);
    s += `<path d="M${x1} ${y(eles[i])}L${x2} ${y(eles[i + 1])}L${x2} ${base}L${x1} ${base}Z" fill="${c}" stroke="${c}" stroke-width=".5"/>`;
  }
  s += `<path d="${r.pts.map((p, i) => `${i ? 'L' : 'M'}${x(r.cum[i])} ${y(p[2])}`).join('')}" fill="none" stroke="#1d2b2f" stroke-width="1.6" stroke-linejoin="round"/>`;
  for (const st of r.stops) {
    if (st.type === 'end' && r.isLoop) continue;
    const sx = x(st.along);
    s += `<line x1="${sx}" x2="${sx}" y1="${PF.t - 2}" y2="${base}" stroke="#1d2b2f" stroke-width="1" stroke-dasharray="2 3" opacity=".6"/>`;
    s += `<circle cx="${sx}" cy="${PF.t - 11}" r="8" fill="${st.type === 'start' ? '#1d2b2f' : '#24564a'}"/><text class="wp-num" x="${sx}" y="${PF.t - 7}" text-anchor="middle">${stopLabel(st)}</text>`;
  }
  s += `</g><g id="pfMe"></g><g id="pfCursor"></g>`;
  svg.setAttribute('viewBox', `0 0 ${w} ${PF.h}`);
  svg.innerHTML = s;
  $('legend').innerHTML = G.SLOPE_CLASSES.map((c) => `<li><i style="background:${c.color}"></i>${c.label} (${c.hint})</li>`).join('');
  drawProfileMe();
  drawProfileCursor();
  if (!svg.dataset.bound) {
    svg.dataset.bound = '1';
    const handle = (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * pfScale.w;
      const d = ((px - PF.l) / (pfScale.w - PF.l - PF.r)) * S.route.total;
      setCursor(Math.max(0, Math.min(S.route.total, d)), 'profile');
    };
    svg.addEventListener('pointerdown', (e) => { try { svg.setPointerCapture(e.pointerId); } catch { /* algunos navegadores */ } handle(e); });
    svg.addEventListener('click', handle);
    svg.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') handle(e); });
    window.addEventListener('resize', () => drawProfile());
  }
}
function drawProfileMe() {
  const g = document.getElementById('pfMe');
  if (!g || !pfScale) return;
  const a = S.proj && S.proj.dist < 300 ? S.proj.along : null;
  if (a == null) { g.innerHTML = ''; return; }
  const e = G.pointAt(S.route, a)[2];
  g.innerHTML = `<circle cx="${pfScale.x(a)}" cy="${pfScale.y(e)}" r="7" fill="#f2c300" stroke="#1d2b2f" stroke-width="3"/>`;
}
function drawProfileCursor() {
  const g = document.getElementById('pfCursor');
  const tip = $('profileTip');
  if (!g || !pfScale || S.cursor == null) { if (g) g.innerHTML = ''; tip.hidden = true; return; }
  const a = S.cursor, r = S.route;
  const e = G.pointAt(r, a)[2];
  const cx = pfScale.x(a);
  g.innerHTML = `<line x1="${cx}" x2="${cx}" y1="${PF.t}" y2="${PF.h - PF.b}" stroke="#1d2b2f" stroke-width="1.5"/><circle cx="${cx}" cy="${pfScale.y(e)}" r="5" fill="#fff" stroke="#1d2b2f" stroke-width="2.5"/>`;
  const gr = r.grade[G.segmentIndexAt(r, a)];
  tip.hidden = false;
  tip.textContent = `km ${nf1.format(a / 1000)}   ${fmtM(e)}   ${gr >= 0 ? '+' : '−'}${nf0.format(Math.abs(gr))} %`;
  const rect = $('profile').getBoundingClientRect();
  const left = (cx / pfScale.w) * rect.width;
  tip.style.left = `${Math.max(60, Math.min(rect.width - 60, left))}px`;
  tip.style.top = `${PF.t + 4}px`;
}

// ---------- GPS ----------
function setupGps() {
  $('btnGps').addEventListener('click', () => (S.watchId == null ? startGps() : stopGps()));
}
function startGps() {
  if (!('geolocation' in navigator)) return gpsMsg('Este navegador no permite usar el GPS.');
  if (!window.isSecureContext) return gpsMsg('El GPS solo funciona abriendo la guía desde su enlace (https), no como fichero.');
  gpsMsg('Buscando señal GPS… Al aire libre suele tardar menos de un minuto.');
  S.watchId = navigator.geolocation.watchPosition(
    (pos) => onFix({ lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy, alt: pos.coords.altitude, altAcc: pos.coords.altitudeAccuracy, t: pos.timestamp }),
    (err) => {
      if (err.code === 1) { gpsMsg('Permiso de ubicación denegado. Actívalo en los ajustes del navegador para esta web y vuelve a pulsar «Activar GPS».'); stopGps(true); }
      else gpsMsg('Sin señal GPS por ahora. Sigue intentándolo; bajo árboles o en barrancos puede tardar más.');
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
  );
  const b = $('btnGps'); b.textContent = 'Apagar GPS'; b.classList.add('is-on');
}
function stopGps(keepMsg = false) {
  if (S.watchId != null) navigator.geolocation.clearWatch(S.watchId);
  S.watchId = null;
  const b = $('btnGps'); b.textContent = 'Activar GPS'; b.classList.remove('is-on');
  if (!keepMsg) gpsMsg(null);
}
function gpsMsg(t) { const m = $('gpsMsg'); m.hidden = !t; m.textContent = t || ''; }

function onFix(fix) {
  const first = !S.fix;
  S.fix = fix;
  gpsMsg(null);
  const hint = S.proj && S.proj.dist < 300 ? S.proj.along : null;
  S.proj = G.projectOnRoute(S.route, fix.lat, fix.lon, hint);
  if (map) {
    drawMe();
    if (first && S.proj.dist < 2000) { setFollow(true); map.setView([fix.lat, fix.lon], 15); }
  }
  drawProfileMe();
  renderLive();
  renderSafety();
}

// ---------- Panel en ruta ----------
function renderLive() {
  const r = S.route, pc = pace();
  const onRoute = S.proj && S.proj.dist < 1000;
  const along = onRoute ? S.proj.along : 0;
  const rem = G.rangeStats(r, along, r.total);
  const remH = G.hoursBetween(r, along, r.total, pc);
  const sp = $('signpost');
  sp.className = 'signpost';
  const next = r.stops.find((s) => s.along > along + 30 && !(s.type === 'start'));
  if (S.proj && !onRoute) {
    const d = G.haversine([S.fix.lat, S.fix.lon], r.pts[0]);
    sp.innerHTML = `<p class="sp-kicker">Estás fuera de la zona de la ruta</p><p class="sp-dest">A ${fmtKm(d)} de la salida</p><p class="sp-data"><span>Salida: ${esc(r.stops[0].name)}</span></p>`;
  } else if (onRoute && S.proj.dist > 60) {
    sp.classList.add('is-off');
    sp.innerHTML = `<p class="sp-kicker">Te has separado del track</p><p class="sp-dest">A ${fmtM(S.proj.dist)} del camino</p><p class="sp-data"><span>Vuelve al trazado antes de seguir</span></p>`;
  } else if (!next || rem.dist < 30) {
    sp.classList.add('is-done');
    sp.innerHTML = `<p class="sp-kicker">Ruta completada</p><p class="sp-dest">${esc(r.stops.at(-1).name)}</p>`;
  } else {
    const st = G.rangeStats(r, along, next.along);
    const h = G.hoursBetween(r, along, next.along, pc);
    const kicker = onRoute ? 'Siguiente punto' : 'Sin GPS: primer objetivo desde la salida';
    sp.innerHTML = `<p class="sp-kicker">${kicker}</p>
      <p class="sp-dest"><span class="sp-num">${esc(stopLabel(next))}</span>${esc(next.name)}</p>
      <p class="sp-data"><span>${fmtDur(h)}</span><span>${fmtKm(st.dist)}</span><span>+${nf0.format(st.up)} m</span><span>−${nf0.format(st.down)} m</span></p>`;
  }

  const cells = [];
  const cell = (label, value, small = '', cls = '') => cells.push(`<div class="${cls}"><dt>${label}</dt><dd>${value}${small ? `<small>${small}</small>` : ''}</dd></div>`);
  if (onRoute) {
    cell('Recorrido', fmtKm(along), `de ${fmtKm(r.total)}`);
    cell('Queda', fmtKm(rem.dist), `+${nf0.format(rem.up)} −${nf0.format(rem.down)} m`);
    const eta = new Date(Date.now() + remH * 36e5);
    cell('Llegada estimada', fmtClock(eta), `en ${fmtDur(remH)}`);
    const d = S.proj.dist;
    cell('Distancia al track', d < 25 ? 'En el track' : fmtM(d), d < 25 ? '' : '', d > 60 ? 'is-bad' : d > 30 ? 'is-warn' : '');
    const alt = S.fix.alt != null ? `${fmtM(S.fix.alt)}` : `${fmtM(G.pointAt(r, along)[2])}`;
    cell('Altitud', alt, S.fix.alt != null ? 'GPS' : 'según el track');
    const age = Math.round((Date.now() - S.fix.t) / 1000);
    cell('Precisión GPS', `±${fmtM(S.fix.acc)}`, age > 20 ? `hace ${age} s` : '', S.fix.acc > 50 ? 'is-warn' : '');
  } else {
    cell('Distancia', fmtKm(r.total), r.isLoop ? 'circular' : '');
    cell('Tiempo estimado', fmtDur(remH), 'sin paradas');
    cell('Subida', `+${fmtM(rem.up)}`);
    cell('Bajada', `−${fmtM(rem.down)}`);
  }
  $('live').innerHTML = cells.join('');
}
setInterval(() => { if (S.fix) renderLive(); }, 15000);

// ---------- Ficha ----------
function renderFicha() {
  const r = S.route, pc = pace();
  const eles = r.pts.map((p) => p[2]);
  const facts = [
    ['Distancia', fmtKm(r.total)],
    ['Tiempo estimado', fmtDur(G.hoursBetween(r, 0, r.total, pc))],
    ['Subida acumulada', `+${fmtM(r.cumUp.at(-1))}`],
    ['Bajada acumulada', `−${fmtM(r.cumDown.at(-1))}`],
    ['Altitud máxima', fmtM(Math.max(...eles))],
    ['Altitud mínima', fmtM(Math.min(...eles))],
  ];
  $('facts').innerHTML = facts.map(([a, b]) => `<div><dt>${a}</dt><dd>${b}</dd></div>`).join('');

  const tp = trackPace();
  $('paceGroup').innerHTML = PACES.filter((p) => p.factor != null || tp).map((p) => {
    const f = p.factor ?? tp;
    const fx = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 }).format(f);
    return `<button type="button" role="radio" aria-checked="${p.id === S.paceId}" data-pace="${p.id}">${p.label}<small>${p.note} (×${fx})</small></button>`;
  }).join('');
  $('paceGroup').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    S.paceId = b.dataset.pace; saveSettings(); renderFicha(); renderLive(); renderSafety();
  }));
  $('paceNote').textContent = 'Tiempos en marcha, sin contar paradas. La referencia es la norma DIN 33466: 4 km/h en llano, 300 m/h subiendo y 500 m/h bajando.'
    + (tp ? ` Quien grabó el track en ${new Date(S.raw.recorded.date).getFullYear()} caminó ${fmtDur(S.raw.recorded.moving_s / 3600)} en movimiento (×${String(tp).replace('.', ',')}).` : '');

  $('directionText').textContent = S.reversed ? 'Sentido inverso al del track original.' : 'Mismo sentido en que se grabó el track.';

  $('legs').innerHTML = r.legs.map((l, k) => {
    const h = G.hoursBetween(r, l.from.along, l.to.along, pc);
    const acc = G.hoursBetween(r, 0, l.to.along, pc);
    const g = l.avgGrade;
    const pend = l.to.confirmed ? '' : '<span class="badge">sin confirmar</span>';
    return `<li><button type="button" data-leg="${k}">
      <span class="leg-ids">${stopLabel(l.from)} a ${stopLabel(l.to)}</span>
      <span class="leg-name">${esc(l.to.type === 'end' ? 'Llegada' : l.to.name)}${l.to.type === 'end' ? '' : pend}</span>
      <span class="leg-time">${fmtDur(h)}</span>
      <span class="leg-data"><span>${fmtKm(l.dist)}</span><span>+${nf0.format(l.up)} m</span><span>−${nf0.format(l.down)} m</span><span>pendiente media ${g >= 0 ? '+' : '−'}${nf0.format(Math.abs(g))} %</span><span>acumulado ${fmtDur(acc)}</span></span>
      ${l.to.note ? `<span class="leg-note">${esc(l.to.note)}</span>` : ''}
    </button></li>`;
  }).join('');
  $('legs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    const l = r.legs[+b.dataset.leg];
    showTab('ruta');
    setTimeout(() => {
      setFollow(false);
      const seg = r.pts.slice(l.from.idx, l.to.idx + 1).map((p) => [p[0], p[1]]);
      map.fitBounds(L.latLngBounds(seg), { padding: [30, 30] });
      setCursor(l.to.along, 'leg');
    }, 60);
  }));
  const pending = r.stops.filter((s) => !s.confirmed && s.type !== 'end').length;
  $('wpNotice').hidden = !pending;
  $('wpNotice').textContent = `Los ${pending} puntos de referencia los he propuesto a partir del perfil y del mapa del IGN (cambios de pendiente, topónimos cercanos y la parada larga de quien grabó el track). Están pendientes de que les pongáis nombre o los descartéis.`;

  const src = S.raw.source;
  const items = [];
  if (src.url) items.push(`<a href="${esc(src.url)}" rel="noopener">Ver la ruta en Wikiloc</a> (necesita cobertura)`);
  src.videos.forEach((v) => items.push(`<a href="${esc(v)}" rel="noopener">Vídeo de la ruta en YouTube</a> (necesita cobertura)`));
  items.push(`<a href="${esc(S.raw.base + src.gpx)}" download="${esc(S.raw.id)}.gpx">Descargar el GPX</a> para abrirlo en Wikiloc, Organic Maps u otra app`);
  $('sources').innerHTML = items.map((i) => `<li>${i}</li>`).join('');

  const ref = S.raw.reference;
  const spacing = Math.round(ref.distance_m / (ref.points - 1));
  $('dataQuality').textContent = `Calculado a partir de ${ref.points} puntos del track (uno cada ${spacing} m de media). Con tan pocos puntos, la distancia real suele ser algo mayor y otras apps pueden dar cifras distintas. Las altitudes vienen del GPS de quien lo grabó y pueden desviarse 10–30 m. Por eso el aviso de "fuera del track" salta a partir de 60 m.`;
}

$('btnReverse').addEventListener('click', () => { S.reversed = !S.reversed; saveSettings(); S.cursor = null; rebuild(); });

// ---------- Seguridad ----------
function renderSafety() {
  if (!S.route) return;
  const r = S.route;
  const now = new Date();
  const [lat, lon] = r.pts[0];
  const sun = G.sunTimes(now, lat, lon);
  $('sun').innerHTML = [
    ['Salida del sol', sun.sunrise ? fmtClock(sun.sunrise) : '—'],
    ['Puesta del sol', sun.sunset ? fmtClock(sun.sunset) : '—'],
    ['Se hace de noche', sun.dusk ? fmtClock(sun.dusk) : '—'],
  ].map(([a, b]) => `<div><dt>${a}</dt><dd>${b}</dd></div>`).join('');

  const adv = $('sunAdvice');
  adv.classList.remove('is-bad');
  const pc = pace();
  const onRoute = S.proj && S.proj.dist < 1000;
  if (sun.sunset) {
    if (onRoute) {
      const remH = G.hoursBetween(r, S.proj.along, r.total, pc);
      const eta = new Date(now.getTime() + remH * 36e5);
      const margin = (sun.sunset - eta) / 36e5;
      adv.textContent = margin >= 0
        ? `A vuestro ritmo llegaríais a las ${fmtClock(eta)}, ${fmtDur(margin)} antes de la puesta del sol.`
        : `A vuestro ritmo llegaríais a las ${fmtClock(eta)}, después de la puesta del sol. Valorad daros la vuelta o acortar, y tened a mano frontales.`;
      if (margin < 0.5) adv.classList.add('is-bad');
    } else {
      const totalH = G.hoursBetween(r, 0, r.total, pc);
      const latest = new Date(sun.sunset.getTime() - (totalH + 1.5) * 36e5);
      adv.textContent = `La ruta completa son unas ${fmtDur(totalH)} en marcha. Para volver con luz contando 1 h 30 min de paradas y margen, empezad antes de las ${fmtClock(latest)}.`;
    }
  }
  adv.textContent += ' Horas calculadas para hoy en el propio móvil.';

  if (S.fix) {
    const { lat: la, lon: lo, acc } = S.fix;
    $('sosCoords').textContent = `${la.toFixed(5)}, ${lo.toFixed(5)}`;
    const near = r.stops.reduce((m, s) => {
      const d = G.haversine([la, lo], r.pts[s.idx]);
      return d < m.d ? { s, d } : m;
    }, { s: null, d: Infinity });
    const alt = S.fix.alt != null ? `Altitud ${fmtM(S.fix.alt)}. ` : '';
    $('sosMeta').textContent = `${alt}Precisión ±${fmtM(acc)}. A ${fmtKm(near.d)} de «${near.s.name}». Hora del dato: ${fmtClock(new Date(S.fix.t))}.`;
    $('btnCopy').disabled = false;
  }
}
$('btnCopy').addEventListener('click', async () => {
  const { lat, lon } = S.fix;
  const text = `Mi posición: ${lat.toFixed(5)}, ${lon.toFixed(5)} (ruta ${S.raw.name}). https://maps.google.com/?q=${lat.toFixed(5)},${lon.toFixed(5)}`;
  const m = $('copyMsg');
  try { await navigator.clipboard.writeText(text); m.textContent = 'Coordenadas copiadas. Pégalas en un SMS o WhatsApp.'; }
  catch { m.textContent = `No se pudo copiar. Díctalas: ${lat.toFixed(5)}, ${lon.toFixed(5)}`; }
  m.hidden = false;
});

// ---------- Pantalla encendida ----------
function setupWakeLock() {
  const t = $('wakeToggle');
  if (!('wakeLock' in navigator)) { t.closest('label').hidden = true; return; }
  const request = async () => {
    try { S.wakeLock = await navigator.wakeLock.request('screen'); S.wakeLock.addEventListener('release', () => { S.wakeLock = null; }); }
    catch { t.checked = false; }
  };
  t.addEventListener('change', async () => {
    if (t.checked) await request();
    else if (S.wakeLock) { await S.wakeLock.release(); S.wakeLock = null; }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && t.checked && !S.wakeLock) request(); });
}

// ---------- Instalación y modo sin conexión ----------
function setupInstallHint() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let dismissed = false;
  try { dismissed = localStorage.getItem('pir26:installHint') === '1'; } catch { /* nada */ }
  if (standalone || dismissed) return;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  $('installText').textContent = ios
    ? 'Para usarla sin cobertura, instálala: en Safari pulsa Compartir y después «Añadir a pantalla de inicio». Luego ábrela desde ese icono con cobertura y espera a que ponga «Lista sin cobertura».'
    : 'Para usarla sin cobertura, instálala: en Chrome abre el menú ⋮ y pulsa «Instalar aplicación» o «Añadir a pantalla de inicio». Luego ábrela desde ese icono y espera a que ponga «Lista sin cobertura».';
  $('installHint').hidden = false;
  $('installClose').addEventListener('click', () => {
    $('installHint').hidden = true;
    try { localStorage.setItem('pir26:installHint', '1'); } catch { /* nada */ }
  });
}

let swReg;
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    swReg = reg;
    const showUpdate = () => { if (reg.waiting && navigator.serviceWorker.controller) $('updateBanner').hidden = false; };
    showUpdate();
    reg.addEventListener('updatefound', () => {
      reg.installing?.addEventListener('statechange', showUpdate);
    });
    // Buscar versión nueva cada vez que se vuelve a la app (si hay cobertura)
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch((e) => console.warn('Service worker', e));
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading) { reloading = true; location.reload(); } });
  $('btnUpdate').addEventListener('click', () => swReg?.waiting?.postMessage('skipWaiting'));
}

async function prepareOffline() {
  const chip = $('offlineChip');
  const set = (cls, text, title = '') => { chip.className = `chip ${cls}`; chip.textContent = text; chip.title = title; };
  if (!('caches' in window) || !('serviceWorker' in navigator)) {
    set('is-error', 'Sin modo offline', 'Este navegador no permite guardar la guía. Ábrela desde su enlace en Safari o Chrome.');
    return;
  }
  try { await navigator.storage?.persist?.(); } catch { /* opcional */ }
  try {
    await navigator.serviceWorker.ready;
    const idx = await (await fetch('tiles/index.json')).json();
    const urls = idx.layers.flatMap((l) => idx.tiles.map((t) => `tiles/${l}/${t}.jpg`));
    const cache = await caches.open('tiles-v1');
    let done = 0, failed = 0;
    const missing = [];
    for (const u of urls) { if (await cache.match(u)) done++; else missing.push(u); }
    const update = () => set('is-busy', `Guardando ${Math.floor((done / urls.length) * 100)} %`, 'Descargando mapas para usarlos sin cobertura');
    if (missing.length) update();
    let i = 0;
    const worker = async () => {
      while (i < missing.length) {
        const u = missing[i++];
        try { const res = await fetch(u); if (res.ok) { await cache.put(u, res); done++; } else failed++; }
        catch { failed++; }
        update();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (failed) set('is-error', 'Mapas incompletos', `Faltan ${failed} trozos de mapa. Vuelve a abrir la guía con cobertura.`);
    else set('is-ready', 'Lista sin cobertura', 'La guía y sus mapas están guardados en este móvil.');
  } catch (e) {
    console.warn(e);
    set('is-error', 'Sin guardar', 'Abre la guía con cobertura para guardarla en este móvil.');
  }
}
$('offlineChip').addEventListener('click', () => {
  const c = $('offlineChip');
  if (c.title) alertBox(c.title);
});
function alertBox(text) { gpsMsg(text); showTab('ruta'); }

renderSafetyLoop();
function renderSafetyLoop() { setInterval(() => renderSafety(), 60000); }

init().then(() => renderSafety());
