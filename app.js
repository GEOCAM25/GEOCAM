'use strict';

/* =========================================================================
   GeoCam v2 — cámara web con texto, fecha y coordenadas
   Almacenamiento 100% local por dispositivo (localStorage).
   Cada instalación es un "usuario" independiente: nada se comparte solo.
   Solo se comparte configuración cuando TÚ generas un enlace/archivo y la otra
   persona CONFIRMA la importación. No hay servidor ni sincronización automática.
   ========================================================================= */

/* ---------------- Almacenamiento local ---------------- */
const LS = { config: 'geocam.config.v1', modes: 'geocam.modes.v1' };

const DEFAULT_CONFIG = {
  customText: '',
  orientation: 'auto',     // auto | portrait | landscape
  align: 'left',           // left | center | right
  colorMode: 'fixed',      // fixed | auto  (auto = se adapta al fondo)
  textColor: '#C9D646',
  shadow: true,            // sombreado/contorno negro
  showAltitude: true,
  showAddress: false,      // incluir la dirección (calle) en la foto
  decimals: 5,
  saveMode: 'auto',        // auto | share | download
  filePrefix: 'foto',
  aspect: 'full',          // full | 4:3 | 3:4 | 16:9 | 9:16 | 1:1
  textScale: 1,            // tamaño del texto en la imagen (0.8 a 1.5)
  defaultMode: '',         // id del modo por defecto al abrir ('' = el primero / libre)
  compass: true,           // brújula en pantalla (nunca en la foto)
  sound: false,            // sonido al capturar (por defecto silencio)
  flash: false,            // flash al capturar (usa linterna)
  torchStart: false,       // linterna encendida al abrir
  nightMode: false,        // linterna automática con poca luz
  whatsapp: false,         // compartir por WhatsApp tras capturar
  whatsappMode: 'each',    // each | complete (cada foto | todas al completar el modo)
  whatsappTarget: ''       // chat/grupo por defecto (referencia)
};

// Texto sembrado en versiones antiguas: si quedó guardado, se limpia (debe ir en blanco).
const LEGACY_SEED_TEXT = 'Departamento de Operación y Distribución [EEPA]';

// Sin modos predeterminados: cada persona crea los suyos en Configuración.
const DEFAULT_MODES = [];

const clone = (o) => JSON.parse(JSON.stringify(o));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS.config) || '{}'); } catch (e) { saved = {}; }
  const cfg = Object.assign({}, DEFAULT_CONFIG, saved);
  // El texto personalizado debe venir en blanco; limpiamos el sembrado antiguo.
  if (cfg.customText === LEGACY_SEED_TEXT) cfg.customText = '';
  return cfg;
}
function saveConfig() { localStorage.setItem(LS.config, JSON.stringify(config)); }
function loadModes() {
  try { const m = JSON.parse(localStorage.getItem(LS.modes)); return (Array.isArray(m) && m.length) ? m : clone(DEFAULT_MODES); }
  catch (e) { return clone(DEFAULT_MODES); }
}
function saveModes() { localStorage.setItem(LS.modes, JSON.stringify(modes)); }

let config = loadConfig();
let modes = loadModes();

/* ---------------- Plataforma ---------------- */
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function isStandalone() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
}

/* ---------------- Atajos DOM ---------------- */
const $ = (id) => document.getElementById(id);
const body = document.body;
const video = $('video');

/* ---------------- Estado cámara ---------------- */
let stream = null, videoTrack = null, currentDeviceId = null;
let lensList = [], lensIndex = 0;
let torchOn = false, torchSupported = false, torchAutoOn = false;
let cameraStarting = false;
let zoom = 1, zoomMin = 1, zoomMax = 5, zoomStep = 0.1, nativeZoom = false;

/* ---------------- Geo / brújula ---------------- */
let lastPos = null, geoWatch = null, lastHeading = null, headingBound = false, headingState = 'idle';

/* ---------------- Color automático (vista en vivo) ---------------- */
let liveAutoColor = null;

/* ---------------- Modos ---------------- */
let activeModeId = (config.defaultMode && modes.some(m => m.id === config.defaultMode))
  ? config.defaultMode
  : ((modes[0] && modes[0].id) || 'libre');
let stepIndex = 0;
let macroActive = false;          // botón macro: solo enfoque cercano (no captura)
let modeBatch = [];               // fotos acumuladas del modo para compartir juntas

/* ---------------- Dirección (geocodificación inversa) ---------------- */
let currentStreetShort = '';      // calle para mostrar arriba (solo visual)
let currentAddressFull = '';      // dirección para la foto (si se activa)
let lastGeoFetch = 0, lastGeoLatLon = null;

/* ---------------- Importación pendiente ---------------- */
let pendingImport = null;

/* =========================================================================
   PANTALLAS
   ========================================================================= */
function isScreen(name) { return body.dataset.screen === name; }
function showScreen(name) {
  body.dataset.screen = name;
  if (name === 'camera') { ensureCamera(); startBrightnessMonitor(); }
  else { stopBrightnessMonitor(); }
  if (name === 'settings') renderSettings();
  if (name === 'share') renderShareScreen();
}

/* =========================================================================
   CÁMARA
   ========================================================================= */
async function ensureCamera() {
  if (stream && video.srcObject && videoTrack && videoTrack.readyState === 'live') return;
  await startCamera(currentDeviceId);
}
function stopStream() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null; videoTrack = null; torchOn = false;
}

async function startCamera(deviceId) {
  if (cameraStarting) return;
  cameraStarting = true;
  hideStartOverlay();
  stopStream();
  // Pide la mayor resolución posible (el navegador elige la mejor del sensor)
  const base = { width: { ideal: 4096 }, height: { ideal: 2160 } };
  const constraints = {
    audio: false,
    video: deviceId ? Object.assign({ deviceId: { exact: deviceId } }, base)
                    : Object.assign({ facingMode: { ideal: 'environment' } }, base)
  };
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    cameraStarting = false;
    showStartOverlay(err);
    return;
  }
  video.srcObject = stream;
  try { await video.play(); } catch (e) {}
  videoTrack = stream.getVideoTracks()[0];
  try { currentDeviceId = videoTrack.getSettings().deviceId || deviceId || null; } catch (e) {}
  // Sube a la resolución máxima del equipo si está disponible
  try {
    const caps = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
    if (caps.width && caps.height && caps.width.max && caps.height.max) {
      await videoTrack.applyConstraints({ width: { ideal: caps.width.max }, height: { ideal: caps.height.max } });
    }
  } catch (e) {}
  detectTorch();
  await enumerateCams();
  // Autoenfoque continuo si el equipo lo permite (mejora el enfoque general)
  try {
    const caps = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
    if (caps.focusMode && caps.focusMode.includes('continuous')) {
      await videoTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    }
  } catch (e) {}
  macroActive = false; $('btn-macro').classList.remove('active');
  // Zoom: usa el del hardware si existe (Android); si no, zoom digital (iPhone)
  try {
    const caps = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
    if (caps.zoom && typeof caps.zoom.max === 'number') {
      nativeZoom = true; zoomMin = caps.zoom.min || 1; zoomMax = caps.zoom.max; zoomStep = caps.zoom.step || 0.1;
    } else {
      nativeZoom = false; zoomMin = 1; zoomMax = 5; zoomStep = 0.1;
    }
  } catch (e) { nativeZoom = false; zoomMin = 1; zoomMax = 5; zoomStep = 0.1; }
  zoom = zoomMin; applyZoom(zoom);
  // Linterna siempre encendida al abrir
  if (config.torchStart && torchSupported && !torchOn) {
    try { await videoTrack.applyConstraints({ advanced: [{ torch: true }] }); torchOn = true; $('btn-torch').classList.add('on'); } catch (e) {}
  }
  cameraStarting = false;
  updateAspectFrame();
  updateLiveOverlay();
}

/* ---- Zoom (pinza con dos dedos) ---- */
function applyZoom(z) {
  zoom = Math.min(zoomMax, Math.max(zoomMin, z));
  if (nativeZoom && videoTrack) {
    try { videoTrack.applyConstraints({ advanced: [{ zoom: zoom }] }); } catch (e) {}
    video.style.transform = '';
  } else {
    video.style.transformOrigin = 'center center';
    video.style.transform = zoom > 1.01 ? `scale(${zoom})` : '';
  }
  const badge = $('zoom-badge');
  if (badge) {
    const rel = nativeZoom ? (zoom / (zoomMin || 1)) : zoom;
    badge.textContent = rel.toFixed(1) + '×';
    badge.classList.toggle('show', zoom > zoomMin + 0.02);
  }
}
function resetZoom() { applyZoom(zoomMin); }
let pinchStartDist = 0, pinchStartZoom = 1;
function touchDist(t) { const dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY; return Math.hypot(dx, dy); }
function bindPinch() {
  const z = $('viewfinder-tap');
  z.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) { pinchStartDist = touchDist(e.touches); pinchStartZoom = zoom; }
  }, { passive: true });
  z.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinchStartDist > 0) {
      e.preventDefault();
      const d = touchDist(e.touches);
      applyZoom(pinchStartZoom * (d / pinchStartDist));
    }
  }, { passive: false });
  z.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) pinchStartDist = 0;
  }, { passive: true });
}

async function enumerateCams() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    lensList = devices.filter(d => d.kind === 'videoinput'); // todas las cámaras (incluye frontal)
    const idx = lensList.findIndex(d => d.deviceId === currentDeviceId);
    lensIndex = idx >= 0 ? idx : 0;
    $('btn-lens').classList.toggle('hidden', lensList.length < 2);
  } catch (e) {}
}

async function switchLens() {
  if (lensList.length < 2) { toast('Sin otras cámaras en este equipo'); return; }
  lensIndex = (lensIndex + 1) % lensList.length;
  const label = (lensList[lensIndex].label || '').toLowerCase();
  await startCamera(lensList[lensIndex].deviceId);
  toast(/front|frontal|user|face|selfie/.test(label) ? 'Cámara frontal'
      : /ultra|gran|wide/.test(label) ? 'Gran angular'
      : /tele/.test(label) ? 'Teleobjetivo'
      : 'Cámara ' + (lensIndex + 1));
}

/* ---- Linterna ---- */
function detectTorch() {
  torchSupported = false;
  try { const caps = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {}; torchSupported = !!caps.torch; }
  catch (e) {}
  $('btn-torch').classList.toggle('disabled', !torchSupported);
  if (!torchSupported) $('btn-torch').classList.remove('on');
}
async function toggleTorch() {
  if (!torchSupported) {
    toast(isIOS ? 'La linterna no está disponible en Safari (iPhone)' : 'Linterna no soportada en este equipo');
    return;
  }
  torchOn = !torchOn;
  torchAutoOn = false; // toque manual: el modo nocturno no lo apagará por su cuenta
  try {
    await videoTrack.applyConstraints({ advanced: [{ torch: torchOn }] });
    $('btn-torch').classList.toggle('on', torchOn);
  } catch (e) { torchOn = !torchOn; toast('No se pudo cambiar la linterna'); }
}

/* ---- Macro (toggle de enfoque cercano; NO captura) ---- */
async function toggleMacro() {
  if (!videoTrack) { toast('La cámara aún no está lista'); return; }
  macroActive = !macroActive;
  const btn = $('btn-macro');
  if (macroActive) {
    let ok = false;
    try {
      const caps = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
      if (caps.focusDistance) {
        await videoTrack.applyConstraints({ advanced: [{ focusMode: 'manual', focusDistance: caps.focusDistance.min }] });
        ok = true;
      }
    } catch (e) {}
    if (!ok) {
      const uw = lensList.find(d => /ultra|gran|wide/i.test(d.label || ''));
      if (uw && uw.deviceId !== currentDeviceId) {
        await startCamera(uw.deviceId);
        lensIndex = lensList.findIndex(d => d.deviceId === uw.deviceId);
        macroActive = true; // startCamera lo resetea; lo reactivamos
        ok = true;
      }
    }
    btn.classList.add('active');
    toast(ok ? 'Macro activado · enfoca de cerca y toca la foto'
             : (isIOS ? 'Macro limitado en iPhone (web). Acerca el equipo' : 'Acerca el equipo al objeto'));
  } else {
    await restoreFocus();
    btn.classList.remove('active');
    toast('Macro desactivado');
  }
}
async function restoreFocus() {
  try {
    const caps = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
    if (caps.focusMode && caps.focusMode.includes('continuous')) {
      await videoTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    }
  } catch (e) {}
}
function macroOffAfterCapture() {
  if (macroActive) { macroActive = false; $('btn-macro').classList.remove('active'); restoreFocus(); }
}

/* ---- Deslizar izquierda/derecha para cambiar de modo (estilo iPhone) ---- */
let swipeX = null, swipeY = null, swipeMoved = false;
function bindSwipe() {
  const z = $('viewfinder-tap');
  z.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1) { swipeX = null; return; } // dos dedos = zoom, no deslizar
    const t = e.touches[0]; swipeX = t.clientX; swipeY = t.clientY; swipeMoved = false;
  }, { passive: true });
  z.addEventListener('touchmove', (e) => {
    if (swipeX == null) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - swipeX) > 12 || Math.abs(t.clientY - swipeY) > 12) swipeMoved = true;
  }, { passive: true });
  z.addEventListener('touchend', (e) => {
    if (swipeX == null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - swipeX, dy = t.clientY - swipeY;
    swipeX = swipeY = null;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.6) {
      stepMode(dx < 0 ? 1 : -1); // izquierda = siguiente, derecha = anterior
    }
  }, { passive: true });
}

/* ---- Tocar para enfocar ---- */
function onViewfinderTap(e) {
  if (!isScreen('camera')) return;
  if (swipeMoved) { swipeMoved = false; return; } // fue un deslizamiento, no un toque
  ensureHeading();
  const t = e.touches && e.touches[0] ? e.touches[0] : e;
  showFocusRing(t.clientX, t.clientY);
  if (!videoTrack) return;
  const rect = video.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (t.clientX - rect.left) / rect.width));
  const y = Math.min(1, Math.max(0, (t.clientY - rect.top) / rect.height));
  try {
    const caps = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
    const adv = {};
    if (caps.focusMode && caps.focusMode.includes('single-shot')) adv.focusMode = 'single-shot';
    if (caps.pointsOfInterest) adv.pointsOfInterest = [{ x, y }];
    if (Object.keys(adv).length) videoTrack.applyConstraints({ advanced: [adv] }).catch(() => {});
  } catch (e) {}
}
let focusTimer = null;
function showFocusRing(x, y) {
  const r = $('focus-ring');
  r.style.left = x + 'px'; r.style.top = y + 'px';
  r.classList.remove('show'); void r.offsetWidth; r.classList.add('show');
  if (focusTimer) clearTimeout(focusTimer);
  focusTimer = setTimeout(() => r.classList.remove('show'), 900);
}

/* ---- Monitor de luminosidad (poca luz + color automático en vivo) ---- */
let brightTimer = null;
const bCanvas = document.createElement('canvas'); bCanvas.width = 16; bCanvas.height = 16;
const bCtx = bCanvas.getContext('2d', { willReadFrequently: true });
function startBrightnessMonitor() { stopBrightnessMonitor(); brightTimer = setInterval(sampleBrightness, 1500); }
function stopBrightnessMonitor() { if (brightTimer) clearInterval(brightTimer); brightTimer = null; }
function avgLum(data) { let s = 0; for (let i = 0; i < data.length; i += 4) s += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; return s / (data.length / 4); }
function sampleBrightness() {
  if (document.hidden || !isScreen('camera') || !video.videoWidth) return;
  try {
    bCtx.drawImage(video, 0, 0, 16, 16);
    const avg = avgLum(bCtx.getImageData(0, 0, 16, 16).data);
    $('lowlight').classList.toggle('show', avg < 42);

    // Modo nocturno: linterna automática con poca luz (con histéresis para no parpadear).
    if (config.nightMode && torchSupported && videoTrack) {
      if (avg < 34 && !torchOn) {
        videoTrack.applyConstraints({ advanced: [{ torch: true }] })
          .then(() => { torchOn = true; torchAutoOn = true; $('btn-torch').classList.add('on'); }).catch(() => {});
      } else if (avg > 62 && torchOn && torchAutoOn) {
        videoTrack.applyConstraints({ advanced: [{ torch: false }] })
          .then(() => { torchOn = false; torchAutoOn = false; $('btn-torch').classList.remove('on'); }).catch(() => {});
      }
    }

    if (config.colorMode === 'auto') {
      const vw = video.videoWidth, vh = video.videoHeight;
      bCtx.drawImage(video, 0, vh * 0.62, vw, vh * 0.38, 0, 0, 16, 16);
      const lum = avgLum(bCtx.getImageData(0, 0, 16, 16).data);
      const c = lum > 140 ? '#0c0c0c' : (config.textColor || '#C9D646');
      if (c !== liveAutoColor) { liveAutoColor = c; updateLiveOverlay(); }
    }
  } catch (e) {}
}

/* =========================================================================
   GEOLOCALIZACIÓN
   ========================================================================= */
function startGeo() {
  if (!navigator.geolocation) { $('coords-readout').textContent = 'GPS no disponible'; return; }
  if (geoWatch != null) return;
  geoWatch = navigator.geolocation.watchPosition(
    (p) => { lastPos = p; updateLiveOverlay(); maybeReverseGeocode(); },
    (e) => { if (!currentStreetShort) $('coords-readout').textContent = 'Buscando ubicación…'; },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
  );
}

/* Distancia aproximada en metros */
function haversine(la1, lo1, la2, lo2) {
  const R = 6371000, toR = Math.PI / 180;
  const dLa = (la2 - la1) * toR, dLo = (lo2 - lo1) * toR;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * toR) * Math.cos(la2 * toR) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* Nombre de calle (arriba, solo visual) + dirección para la foto.
   Usa OpenStreetMap (Nominatim). Si falla o no hay conexión, se omite. */
async function maybeReverseGeocode() {
  if (!lastPos) return;
  const lat = lastPos.coords.latitude, lon = lastPos.coords.longitude;
  const now = Date.now();
  if (lastGeoLatLon && haversine(lat, lon, lastGeoLatLon[0], lastGeoLatLon[1]) < 25 && now - lastGeoFetch < 30000) return;
  if (now - lastGeoFetch < 8000) return; // respeta el límite de uso
  lastGeoFetch = now; lastGeoLatLon = [lat, lon];
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&zoom=18&addressdetails=1&lat=${lat}&lon=${lon}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return;
    const j = await res.json();
    const a = j.address || {};
    const road = a.road || a.pedestrian || a.residential || a.footway || a.path || a.cycleway || '';
    const num = a.house_number ? ' ' + a.house_number : '';
    const area = a.suburb || a.neighbourhood || a.quarter || a.city_district || a.town || a.city || a.village || a.county || '';
    currentStreetShort = road ? (road + num) : (area || '');
    currentAddressFull = [road ? road + num : '', area].filter(Boolean).join(', ') || currentStreetShort;
    updateTopStreet();
    if (config.showAddress) updateLiveOverlay();
  } catch (e) { /* sin conexión o bloqueado: se omite la dirección */ }
}
function updateTopStreet() {
  const el = $('coords-readout');
  el.textContent = currentStreetShort || '—';
  el.classList.toggle('ok', !!currentStreetShort);
}

/* =========================================================================
   BRÚJULA (solo pantalla, nunca en la foto)
   ========================================================================= */
async function ensureHeading() {
  if (headingBound) return;
  const handler = (ev) => {
    let h = null;
    if (typeof ev.webkitCompassHeading === 'number') h = ev.webkitCompassHeading;          // iOS: norte real
    else if (ev.absolute && typeof ev.alpha === 'number') h = (360 - ev.alpha) % 360;       // Android absoluto
    if (h != null && !isNaN(h)) { lastHeading = h; scheduleCompass(); }
  };
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') { headingState = 'denied'; updateCompass(); return; }
    } catch (e) { headingState = 'idle'; return; } // se reintenta en el próximo toque
  }
  window.addEventListener('deviceorientationabsolute', handler, true);
  window.addEventListener('deviceorientation', handler, true);
  headingBound = true; headingState = 'on'; updateCompass();
}
const CARD8 = ['Norte', 'Nororiente', 'Oriente', 'Suroriente', 'Sur', 'Surponiente', 'Poniente', 'Norponiente'];
function cardinalES(h) {
  h = ((h % 360) + 360) % 360;
  return CARD8[Math.round(h / 45) % 8];
}
let compassRAF = 0;
function scheduleCompass() {
  if (compassRAF) return;
  compassRAF = requestAnimationFrame(() => { compassRAF = 0; updateCompass(); });
}
function updateCompass() {
  const wrap = $('compass');
  if (!config.compass) { wrap.classList.remove('show'); return; }
  wrap.classList.add('show');
  const arc = $('compass-arc');
  const label = $('compass-label');
  const marks = arc ? arc.querySelectorAll('.cm') : [];
  if (lastHeading == null) {
    label.textContent = headingState === 'denied' ? 'sin permiso' : 'tocar';
    marks.forEach(el => { el.style.display = 'none'; });
    return;
  }
  const W = arc.clientWidth || 280, R = 150, cx = W / 2;
  marks.forEach(el => {
    const b = +el.dataset.deg;
    let diff = ((b - lastHeading + 540) % 360) - 180; // [-180,180]
    if (Math.abs(diff) > 74) { el.style.display = 'none'; return; }
    const t = diff * Math.PI / 180;
    el.style.display = '';
    el.style.left = (cx + R * Math.sin(t)) + 'px';
    el.style.top = (10 + R - R * Math.cos(t)) + 'px';   // 10px = desfase del arco visible
    el.style.opacity = String(Math.max(0.28, 1 - Math.abs(diff) / 82));
  });
  label.textContent = cardinalES(lastHeading).toUpperCase();
}

/* =========================================================================
   OVERLAY (texto + coords + fecha)
   ========================================================================= */
function pad(n) { return String(n).padStart(2, '0'); }
function formatDate(d) {
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function buildLines(pos, date) {
  date = date || new Date();
  const lines = [];
  (config.customText || '').split('\n').forEach(t => { if (t.trim() !== '') lines.push(t); });
  if (config.showAddress && currentAddressFull) lines.push(currentAddressFull);
  let coord;
  if (pos && pos.coords && typeof pos.coords.latitude === 'number') {
    const lat = pos.coords.latitude.toFixed(config.decimals);
    const lon = pos.coords.longitude.toFixed(config.decimals);
    coord = `${lat}, ${lon}`;
    if (config.showAltitude && pos.coords.altitude != null && !isNaN(pos.coords.altitude))
      coord += `, ${pos.coords.altitude.toFixed(1)}m`;
  } else {
    coord = 'Sin señal GPS';
  }
  lines.push(coord);
  lines.push(formatDate(date));
  return lines;
}

function updateLiveOverlay() {
  const ov = $('overlay');
  document.documentElement.style.setProperty('--ov-scale', config.textScale || 1);
  const lines = buildLines(lastPos);
  ov.style.textAlign = config.align;
  ov.style.color = (config.colorMode === 'auto' && liveAutoColor) ? liveAutoColor : (config.textColor || '#C9D646');
  ov.style.textShadow = config.shadow ? '0 1px 3px rgba(0,0,0,.85),0 0 1px rgba(0,0,0,.9)' : 'none';
  ov.innerHTML = '';
  lines.forEach(t => { const div = document.createElement('div'); div.textContent = t; ov.appendChild(div); });
  // Arriba va el nombre de la calle (visual); las coordenadas solo van abajo.
  updateTopStreet();
}

/* color automático según luminancia del fondo */
function pickColors(lum) {
  if (config.colorMode === 'auto') {
    if (lum > 140) return { text: '#0c0c0c', outline: 'rgba(255,255,255,0.92)' };
    return { text: (config.textColor || '#C9D646'), outline: 'rgba(0,0,0,0.82)' };
  }
  return { text: (config.textColor || '#C9D646'), outline: 'rgba(0,0,0,0.7)' };
}
function regionLuminance(ctx, x, y, w, h) {
  x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y));
  w = Math.max(1, Math.floor(w)); h = Math.max(1, Math.floor(h));
  try { return avgLum(ctx.getImageData(x, y, w, h).data); } catch (e) { return 0; }
}

function drawLines(ctx, lines, o) {
  const lh = Math.round(o.fontPx * 1.34);
  ctx.font = `600 ${o.fontPx}px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  ctx.textAlign = o.align; ctx.textBaseline = 'top';
  lines.forEach((t, i) => {
    const y = o.topY + i * lh;
    if (o.shadow) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.78)';
      ctx.shadowBlur = Math.max(2, o.fontPx * 0.14);
      ctx.shadowOffsetY = Math.max(1, o.fontPx * 0.05);
      ctx.lineWidth = Math.max(1, o.fontPx * 0.09);
      ctx.lineJoin = 'round';
      ctx.strokeStyle = o.outline || 'rgba(0,0,0,0.55)';
      ctx.strokeText(t, o.x, y);
      ctx.restore();
    }
    ctx.fillStyle = o.color; ctx.fillText(t, o.x, y);
  });
  return lh * lines.length;
}

function overlayAnchorX(w) {
  return config.align === 'left' ? Math.round(w * 0.028)
       : config.align === 'right' ? Math.round(w * 0.972)
       : Math.round(w / 2);
}
function drawOverlayBottom(ctx, w, h, pos, date) {
  const lines = buildLines(pos, date);
  const scale = config.textScale || 1;
  const fontPx = Math.max(12, Math.round(Math.min(w, h) * 0.033 * scale));
  const lh = Math.round(fontPx * 1.34);
  const blockH = lh * lines.length;
  const topY = h - Math.round(h * 0.03) - blockH;
  const lum = regionLuminance(ctx, w * 0.04, topY, w * 0.92, blockH);
  const col = pickColors(lum);
  drawLines(ctx, lines, { fontPx, color: col.text, outline: col.outline, align: config.align, x: overlayAnchorX(w), topY, shadow: config.shadow });
}

/* =========================================================================
   ORIENTACIÓN (no permite fotos al revés)
   ========================================================================= */
function deviceAngle() {
  let a = 0;
  if (screen.orientation && typeof screen.orientation.angle === 'number') a = screen.orientation.angle;
  else if (typeof window.orientation === 'number') a = window.orientation;
  return ((a % 360) + 360) % 360;
}
function captureAllowed() {
  const a = deviceAngle();
  if (config.orientation === 'portrait') {
    if (a === 0) return { ok: true };
    return { ok: false, msg: 'Mantén el teléfono vertical' };
  }
  if (config.orientation === 'landscape') {
    if (a === 90 || a === 270) return { ok: true };
    return { ok: false, msg: 'Mantén el teléfono horizontal' };
  }
  // auto: vertical u horizontal, pero nunca al revés (180°)
  if (a === 180) return { ok: false, msg: 'No se permite al revés. Gira el teléfono' };
  return { ok: true };
}

/* =========================================================================
   CAPTURA Y GUARDADO
   ========================================================================= */
const shotCanvas = document.createElement('canvas');
const blurCanvas = document.createElement('canvas');
const BLUR_THRESHOLD = 60; // ajustable: menor = más permisivo

/* ---- Relación de aspecto ---- */
function aspectRatioValue() {
  switch (config.aspect) {
    case '4:3': return 4 / 3;
    case '3:4': return 3 / 4;
    case '16:9': return 16 / 9;
    case '9:16': return 9 / 16;
    case '1:1': return 1;
    default: return null; // completa
  }
}
function cropRectForAspect(vw, vh) {
  const r = aspectRatioValue();
  if (!r) return { sx: 0, sy: 0, sw: vw, sh: vh };
  let sw, sh;
  if (vw / vh > r) { sh = vh; sw = Math.round(vh * r); }
  else { sw = vw; sh = Math.round(vw / r); }
  return { sx: Math.round((vw - sw) / 2), sy: Math.round((vh - sh) / 2), sw, sh };
}
function updateAspectFrame() {
  const f = $('aspect-frame');
  if (!f) return;
  const r = aspectRatioValue();
  if (!r) { f.classList.remove('show'); return; }
  f.classList.add('show');
  const vw = window.innerWidth, vh = window.innerHeight;
  let w = vw * 0.96, h = w / r;
  if (h > vh * 0.66) { h = vh * 0.66; w = h * r; }
  f.style.width = Math.round(w) + 'px';
  f.style.height = Math.round(h) + 'px';
}

async function capturePhoto() {
  if (!video.videoWidth) { toast('La cámara aún no está lista'); return; }
  const gate = captureAllowed();
  if (!gate.ok) { toast(gate.msg); return; }

  // Flash (pseudo): pulso de linterna alrededor de la captura
  let turnedOn = false;
  if (config.flash && torchSupported && !torchOn) {
    try { await videoTrack.applyConstraints({ advanced: [{ torch: true }] }); turnedOn = true; await sleep(130); } catch (e) {}
  }

  const vw = video.videoWidth, vh = video.videoHeight;
  const { sx, sy, sw, sh } = cropRectForAspect(vw, vh);
  shotCanvas.width = sw; shotCanvas.height = sh;
  const ctx = shotCanvas.getContext('2d', { willReadFrequently: true });
  // Zoom digital (iPhone): recorta el centro y lo escala; el óptico ya viene aplicado.
  let srcX = sx, srcY = sy, srcW = sw, srcH = sh;
  if (!nativeZoom && zoom > 1.01) {
    srcW = sw / zoom; srcH = sh / zoom;
    srcX = sx + (sw - srcW) / 2; srcY = sy + (sh - srcH) / 2;
  }
  ctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, sw, sh);
  const blurry = isBlurry(shotCanvas);
  const now = new Date();
  drawOverlayBottom(ctx, sw, sh, lastPos, now);
  flashScreen();
  shutterSound();

  if (turnedOn) { try { await videoTrack.applyConstraints({ advanced: [{ torch: false }] }); } catch (e) {} }
  macroOffAfterCapture(); // el macro se apaga tras tomar la foto

  shotCanvas.toBlob(async (blob) => {
    // Graba el GPS real en el archivo (EXIF), así la galería ubica la foto en el mapa
    if (lastPos && lastPos.coords && typeof lastPos.coords.latitude === 'number') {
      try { blob = await insertExifGps(blob, lastPos.coords.latitude, lastPos.coords.longitude, lastPos.coords.altitude); } catch (e) {}
    }
    const fname = `${config.filePrefix || 'foto'}_${tsName(now)}.jpg`;
    const file = new File([blob], fname, { type: 'image/jpeg' });
    setThumb(blob);
    handleCapturedFile(file, blob, now);
    if (blurry) toast('IMAGEN MOVIDA', 1000);
    afterCaptureAdvance();
    checkBatchComplete();
  }, 'image/jpeg', 0.95);
}

/* =========================================================================
   EXIF GPS — escribe las coordenadas reales dentro del archivo JPEG.
   Sin librerías: arma un bloque APP1/Exif mínimo solo con GPS y lo inserta.
   No sube nada a internet; queda solo en el archivo del teléfono.
   ========================================================================= */
async function insertExifGps(blob, lat, lon, alt) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return blob; // no es JPEG válido
  const exif = buildExifGps(lat, lon, alt);
  // Inserta el segmento APP1 justo después del SOI (FFD8)
  const out = new Uint8Array(2 + exif.length + (buf.length - 2));
  out.set(buf.subarray(0, 2), 0);
  out.set(exif, 2);
  out.set(buf.subarray(2), 2 + exif.length);
  return new Blob([out], { type: 'image/jpeg' });
}
function buildExifGps(lat, lon, alt) {
  const latRef = lat < 0 ? 'S' : 'N';
  const lonRef = lon < 0 ? 'W' : 'E';
  const dms = (v) => { v = Math.abs(v); const d = Math.floor(v); const mf = (v - d) * 60; const m = Math.floor(mf); const s = (mf - m) * 60; return [[d, 1], [m, 1], [Math.round(s * 10000), 10000]]; };
  const latD = dms(lat), lonD = dms(lon);
  const hasAlt = (alt != null && !isNaN(alt));
  const altRef = (hasAlt && alt < 0) ? 1 : 0;
  const altVal = hasAlt ? Math.round(Math.abs(alt) * 100) : 0;

  // TIFF little-endian. Offsets relativos al inicio del TIFF.
  const tiff = new Uint8Array(256);
  const dv = new DataView(tiff.buffer);
  let p = 0;
  dv.setUint8(p++, 0x49); dv.setUint8(p++, 0x49);   // "II"
  dv.setUint16(p, 42, true); p += 2;                 // 42
  dv.setUint32(p, 8, true); p += 2 + 2;              // offset a IFD0 = 8 (p pasa a 8)

  // IFD0 en offset 8: 1 entrada (puntero a GPS IFD)
  let o = 8;
  dv.setUint16(o, 1, true); o += 2;                  // num entradas
  dv.setUint16(o, 0x8825, true); o += 2;             // GPS IFD pointer
  dv.setUint16(o, 4, true); o += 2;                  // tipo LONG
  dv.setUint32(o, 1, true); o += 4;                  // count
  const gpsIfdOffset = 26;
  dv.setUint32(o, gpsIfdOffset, true); o += 4;       // valor = offset GPS IFD
  dv.setUint32(o, 0, true); o += 4;                  // next IFD = 0

  // GPS IFD en offset 26: 7 entradas
  let g = gpsIfdOffset;
  dv.setUint16(g, 7, true); g += 2;
  const dataStart = gpsIfdOffset + 2 + 7 * 12 + 4;   // = 116
  let dptr = dataStart;
  const entry = (tag, type, count, valueWriter, inline) => {
    dv.setUint16(g, tag, true); g += 2;
    dv.setUint16(g, type, true); g += 2;
    dv.setUint32(g, count, true); g += 4;
    if (inline) { valueWriter(g); g += 4; }
    else { dv.setUint32(g, dptr, true); g += 4; dptr += valueWriter(dptr); }
  };
  // GPSVersionID 2,3,0,0
  entry(0x0000, 1, 4, (at) => { dv.setUint8(at, 2); dv.setUint8(at + 1, 3); dv.setUint8(at + 2, 0); dv.setUint8(at + 3, 0); }, true);
  // GPSLatitudeRef
  entry(0x0001, 2, 2, (at) => { dv.setUint8(at, latRef.charCodeAt(0)); dv.setUint8(at + 1, 0); }, true);
  // GPSLatitude (3 rationals)
  entry(0x0002, 5, 3, (at) => { latD.forEach((r, i) => { dv.setUint32(at + i * 8, r[0], true); dv.setUint32(at + i * 8 + 4, r[1], true); }); return 24; }, false);
  // GPSLongitudeRef
  entry(0x0003, 2, 2, (at) => { dv.setUint8(at, lonRef.charCodeAt(0)); dv.setUint8(at + 1, 0); }, true);
  // GPSLongitude
  entry(0x0004, 5, 3, (at) => { lonD.forEach((r, i) => { dv.setUint32(at + i * 8, r[0], true); dv.setUint32(at + i * 8 + 4, r[1], true); }); return 24; }, false);
  // GPSAltitudeRef (BYTE)
  entry(0x0005, 1, 1, (at) => { dv.setUint8(at, altRef); }, true);
  // GPSAltitude (1 rational)
  entry(0x0006, 5, 1, (at) => { dv.setUint32(at, altVal, true); dv.setUint32(at + 4, 100, true); return 8; }, false);
  dv.setUint32(g, 0, true); g += 4;                  // next IFD = 0

  const tiffLen = dptr;                              // largo real usado
  // Envoltura APP1: FFE1 + length(BE) + "Exif\0\0" + TIFF
  const payloadLen = 6 + tiffLen;                    // "Exif\0\0" + tiff
  const app1 = new Uint8Array(2 + 2 + payloadLen);
  app1[0] = 0xFF; app1[1] = 0xE1;
  app1[2] = (payloadLen + 2) >> 8; app1[3] = (payloadLen + 2) & 0xFF;
  app1.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 4); // "Exif\0\0"
  app1.set(tiff.subarray(0, tiffLen), 10);
  return app1;
}

/* Decide qué hacer con cada foto: guardar, compartir, o acumular para el lote */
function handleCapturedFile(file, blob, date) {
  const mode = activeMode();
  const inSeq = mode && mode.steps && mode.steps.length;
  if (config.whatsapp && config.whatsappMode === 'complete' && inSeq) {
    modeBatch.push({ file, stamp: stampOf(date) }); // se comparte/guarda todo al completar
  } else if (config.whatsapp) {
    shareFiles([file], waCaptionSingle(date));       // compartir esta foto (puedes enviar y guardar)
  } else {
    saveBlob(blob, file);                            // guardar según "Al guardar"
  }
}

/* Si la secuencia del modo se completó, comparte todas las fotos juntas */
function checkBatchComplete() {
  const mode = activeMode();
  if (!mode || !mode.steps || !mode.steps.length) return;
  if (config.whatsapp && config.whatsappMode === 'complete' && stepIndex >= mode.steps.length && modeBatch.length) {
    const files = modeBatch.map(b => b.file);
    const caption = batchCaption(mode, modeBatch);
    modeBatch = [];
    shareFiles(files, caption);
  }
}
function batchCaption(mode, batch) {
  const parts = [];
  if (mode && mode.waMessage) parts.push(mode.waMessage);
  else if (config.customText) parts.push(config.customText);
  if (mode && mode.name) parts.push('Modo: ' + mode.name);
  if (batch.length) {
    parts.push('Primera imagen: ' + batch[0].stamp);
    parts.push('Última imagen: ' + batch[batch.length - 1].stamp);
  }
  const target = (mode && mode.waTarget) || config.whatsappTarget;
  if (target) parts.push('Para: ' + target);
  return parts.join('\n');
}
async function shareFiles(files, caption) {
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files, text: caption }); toast('Elige WhatsApp y el chat, luego envía'); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  toast('Compartir no está disponible aquí; las fotos quedaron guardadas');
}

/* Detección simple de imagen movida (varianza del laplaciano) */
function isBlurry(canvas) {
  try {
    const tw = 180, th = Math.max(1, Math.round(canvas.height / canvas.width * tw));
    blurCanvas.width = tw; blurCanvas.height = th;
    const c = blurCanvas.getContext('2d', { willReadFrequently: true });
    c.drawImage(canvas, 0, 0, tw, th);
    const d = c.getImageData(0, 0, tw, th).data;
    const g = new Float32Array(tw * th);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    let sum = 0, sumSq = 0, n = 0;
    for (let y = 1; y < th - 1; y++) for (let x = 1; x < tw - 1; x++) {
      const idx = y * tw + x;
      const lap = 4 * g[idx] - g[idx - 1] - g[idx + 1] - g[idx - tw] - g[idx + tw];
      sum += lap; sumSq += lap * lap; n++;
    }
    if (!n) return false;
    const m = sum / n;
    return (sumSq / n - m * m) < BLUR_THRESHOLD;
  } catch (e) { return false; }
}

function tsName(d) {
  d = d || new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function stampOf(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}
function waCaption() { return buildLines(lastPos).join('\n'); }
function waCaptionSingle(date) { return buildLines(lastPos, date).join('\n'); }

async function saveBlob(blob, file) {
  file = file || new File([blob], `${config.filePrefix || 'foto'}_${tsName()}.jpg`, { type: 'image/jpeg' });
  const wantShare = config.saveMode === 'share' || (config.saveMode === 'auto' && isIOS);
  if (wantShare && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); toast('Guarda con "Guardar imagen"'); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('Imagen guardada');
}

let lastThumbURL = null;
function setThumb(blob) {
  if (lastThumbURL) URL.revokeObjectURL(lastThumbURL);
  lastThumbURL = URL.createObjectURL(blob);
  const t = $('thumb');
  t.style.backgroundImage = `url(${lastThumbURL})`;
  t.classList.add('has');
}
function flashScreen() {
  const f = $('flash'); f.classList.add('on');
  setTimeout(() => f.classList.remove('on'), 140);
}

/* sonido de obturador (silencio por defecto) */
let audioCtx = null;
function shutterSound() {
  if (!config.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'square'; o.frequency.value = 1050;
    const t = audioCtx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(g).connect(audioCtx.destination);
    o.start(t); o.stop(t + 0.1);
  } catch (e) {}
}

/* =========================================================================
   MODOS + RECORDATORIOS (rueda estilo iPhone)
   ========================================================================= */
function activeMode() { return modes.find(m => m.id === activeModeId) || modes[0]; }

function renderWheel() {
  const wheel = $('wheel');
  wheel.innerHTML = '';
  if (!modes.length) {
    const ghost = document.createElement('button');
    ghost.className = 'wheel-item ghost active';
    ghost.textContent = '＋ Crea tus modos en ⚙️';
    ghost.addEventListener('click', () => showScreen('settings'));
    wheel.appendChild(ghost);
    updateReminder();
    return;
  }
  modes.forEach(m => {
    const el = document.createElement('button');
    el.className = 'wheel-item';
    el.dataset.id = m.id;
    el.textContent = m.name;
    el.addEventListener('click', () => selectMode(m.id, true));
    wheel.appendChild(el);
  });
  if (!modes.find(m => m.id === activeModeId)) activeModeId = modes[0].id;
  updateWheelActive();
  updateReminder();
  requestAnimationFrame(() => scrollWheelTo(activeModeId, false));
}
function selectMode(id, doScroll) {
  if (id === activeModeId) { stepIndex = 0; } else { activeModeId = id; stepIndex = 0; }
  modeBatch = [];
  updateWheelActive();
  updateReminder();
  if (doScroll) scrollWheelTo(id, true);
}
function updateWheelActive() {
  [...$('wheel').children].forEach(c => c.classList.toggle('active', c.dataset.id === activeModeId));
}
function stepMode(dir) {
  if (!modes.length) return;
  let i = modes.findIndex(m => m.id === activeModeId);
  if (i < 0) i = 0;
  i = (i + dir + modes.length) % modes.length;
  selectMode(modes[i].id, true);
}
function scrollWheelTo(id, smooth) {
  const wheel = $('wheel');
  const el = [...wheel.children].find(c => c.dataset.id === id);
  if (!el) return;
  const target = el.offsetLeft - wheel.clientWidth / 2 + el.clientWidth / 2;
  wheel.scrollTo({ left: target, behavior: smooth ? 'smooth' : 'auto' });
}
let wheelScrollT = null;
function bindWheelScroll() {
  const wheel = $('wheel');
  wheel.addEventListener('scroll', () => {
    if (wheelScrollT) clearTimeout(wheelScrollT);
    wheelScrollT = setTimeout(() => {
      const center = wheel.scrollLeft + wheel.clientWidth / 2;
      let best = null, bd = Infinity;
      [...wheel.children].forEach(c => {
        const cc = c.offsetLeft + c.clientWidth / 2;
        const d = Math.abs(cc - center);
        if (d < bd) { bd = d; best = c; }
      });
      if (best && best.dataset.id !== activeModeId) {
        activeModeId = best.dataset.id; stepIndex = 0;
        updateWheelActive(); updateReminder();
      }
    }, 110);
  }, { passive: true });
}
function updateReminder() {
  const m = activeMode();
  const rem = $('reminder');
  if (!m || !m.steps || m.steps.length === 0) { rem.classList.remove('show'); return; }
  rem.classList.add('show');
  const done = stepIndex >= m.steps.length;
  $('reminder-skip').style.display = done ? 'none' : '';
  $('reminder-restart').style.display = (done || stepIndex > 0) ? '' : 'none';
  if (done) {
    $('reminder-text').textContent = 'Secuencia completa';
    $('reminder-count').textContent = `${m.steps.length}/${m.steps.length}`;
  } else {
    $('reminder-text').textContent = m.steps[stepIndex];
    $('reminder-count').textContent = `${stepIndex + 1}/${m.steps.length}`;
  }
}
function afterCaptureAdvance() {
  const m = activeMode();
  if (m && m.steps && m.steps.length && stepIndex < m.steps.length) { stepIndex++; updateReminder(); }
}
function skipStep() {
  const m = activeMode();
  if (m && m.steps && stepIndex < m.steps.length) { stepIndex++; updateReminder(); }
}
function restartSeq() { stepIndex = 0; modeBatch = []; updateReminder(); }

/* =========================================================================
   CONFIGURACIÓN
   ========================================================================= */
function renderSettings() {
  $('cfg-text').value = config.customText;
  $('cfg-orientation').value = config.orientation;
  $('cfg-align').value = config.align;
  $('cfg-color-mode').value = config.colorMode;
  $('cfg-color').value = config.textColor;
  $('cfg-shadow').checked = config.shadow;
  $('cfg-altitude').checked = config.showAltitude;
  $('cfg-address').checked = config.showAddress;
  $('cfg-aspect').value = config.aspect;
  $('cfg-text-size').value = String(config.textScale);
  $('cfg-decimals').value = String(config.decimals);
  $('cfg-save').value = config.saveMode;
  $('cfg-prefix').value = config.filePrefix;
  $('cfg-compass').checked = config.compass;
  $('cfg-sound').checked = config.sound;
  $('cfg-flash').checked = config.flash;
  $('cfg-torch-start').checked = config.torchStart;
  $('cfg-night').checked = config.nightMode;
  $('cfg-whatsapp').checked = config.whatsapp;
  $('cfg-whatsapp-mode').value = config.whatsappMode;
  $('cfg-whatsapp-target').value = config.whatsappTarget || '';
  const dm = $('cfg-default-mode');
  dm.innerHTML = '<option value="">Primero de la lista</option>';
  modes.forEach(m => {
    const o = document.createElement('option');
    o.value = m.id; o.textContent = m.name;
    dm.appendChild(o);
  });
  dm.value = (config.defaultMode && modes.some(m => m.id === config.defaultMode)) ? config.defaultMode : '';
  renderModesEditor();
}

function bindSettings() {
  $('cfg-text').addEventListener('input', e => { config.customText = e.target.value; saveConfig(); updateLiveOverlay(); });
  $('cfg-orientation').addEventListener('change', e => { config.orientation = e.target.value; saveConfig(); applyOrientation(); });
  $('cfg-align').addEventListener('change', e => { config.align = e.target.value; saveConfig(); updateLiveOverlay(); });
  $('cfg-color-mode').addEventListener('change', e => { config.colorMode = e.target.value; saveConfig(); liveAutoColor = null; updateLiveOverlay(); });
  $('cfg-color').addEventListener('input', e => { config.textColor = e.target.value; saveConfig(); updateLiveOverlay(); });
  $('cfg-shadow').addEventListener('change', e => { config.shadow = e.target.checked; saveConfig(); updateLiveOverlay(); });
  $('cfg-altitude').addEventListener('change', e => { config.showAltitude = e.target.checked; saveConfig(); updateLiveOverlay(); });
  $('cfg-address').addEventListener('change', e => { config.showAddress = e.target.checked; saveConfig(); if (config.showAddress) maybeReverseGeocode(); updateLiveOverlay(); });
  $('cfg-aspect').addEventListener('change', e => { config.aspect = e.target.value; saveConfig(); updateAspectFrame(); });
  $('cfg-text-size').addEventListener('change', e => { config.textScale = parseFloat(e.target.value); saveConfig(); updateLiveOverlay(); });
  $('cfg-default-mode').addEventListener('change', e => { config.defaultMode = e.target.value; saveConfig(); });
  $('cfg-decimals').addEventListener('change', e => { config.decimals = parseInt(e.target.value, 10); saveConfig(); updateLiveOverlay(); });
  $('cfg-save').addEventListener('change', e => { config.saveMode = e.target.value; saveConfig(); });
  $('cfg-prefix').addEventListener('input', e => { config.filePrefix = e.target.value.replace(/[^\w\-]/g, '') || 'foto'; saveConfig(); });
  $('cfg-compass').addEventListener('change', e => { config.compass = e.target.checked; saveConfig(); if (config.compass) ensureHeading(); updateCompass(); });
  $('cfg-sound').addEventListener('change', e => { config.sound = e.target.checked; saveConfig(); });
  $('cfg-flash').addEventListener('change', e => {
    config.flash = e.target.checked; saveConfig();
    if (config.flash && isIOS) toast('El flash usa la linterna; no disponible en iPhone (web)');
  });
  $('cfg-torch-start').addEventListener('change', e => {
    config.torchStart = e.target.checked; saveConfig();
    if (config.torchStart && isIOS) { toast('La linterna no está disponible en iPhone (web)'); return; }
    if (config.torchStart && torchSupported && videoTrack && !torchOn) {
      videoTrack.applyConstraints({ advanced: [{ torch: true }] }).then(() => { torchOn = true; $('btn-torch').classList.add('on'); }).catch(() => {});
    }
  });
  $('cfg-night').addEventListener('change', e => {
    config.nightMode = e.target.checked; saveConfig();
    if (config.nightMode && isIOS) { toast('El modo nocturno usa la linterna; no disponible en iPhone (web)'); return; }
    if (config.nightMode && !torchSupported) { toast('Este equipo no permite controlar la linterna'); return; }
    if (!config.nightMode && torchOn && torchAutoOn && videoTrack) {
      videoTrack.applyConstraints({ advanced: [{ torch: false }] }).then(() => { torchOn = false; torchAutoOn = false; $('btn-torch').classList.remove('on'); }).catch(() => {});
    }
  });
  $('cfg-whatsapp').addEventListener('change', e => { config.whatsapp = e.target.checked; saveConfig(); });
  $('cfg-whatsapp-mode').addEventListener('change', e => { config.whatsappMode = e.target.value; saveConfig(); });
  $('cfg-whatsapp-target').addEventListener('input', e => { config.whatsappTarget = e.target.value; saveConfig(); });
  $('btn-open-share').addEventListener('click', () => showScreen('share'));
  $('btn-add-mode').addEventListener('click', addMode);
  $('btn-reset').addEventListener('click', () => {
    if (confirm('¿Restablecer textos y modos a los valores de fábrica? Solo afecta a este dispositivo.')) {
      config = clone(DEFAULT_CONFIG); modes = clone(DEFAULT_MODES);
      saveConfig(); saveModes(); renderSettings(); renderWheel(); updateLiveOverlay(); updateCompass();
      toast('Restablecido');
    }
  });
}

/* --- Editor de modos --- */
function slug(s) { return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '') || ('m' + Date.now()); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function renderModesEditor() {
  const list = $('modes-list');
  list.innerHTML = '';
  modes.forEach((m, i) => {
    const card = document.createElement('div');
    card.className = 'mode-card';

    const head = document.createElement('div');
    head.className = 'mode-head';

    const name = document.createElement('input');
    name.className = 'mode-name';
    name.value = m.name;
    name.placeholder = 'Nombre del modo';
    name.addEventListener('input', e => { m.name = e.target.value; saveModes(); refreshWheelNames(); });

    const tools = document.createElement('div');
    tools.className = 'mode-tools';
    const up = iconBtn('▲', 'Subir', () => moveMode(i, -1));
    const dn = iconBtn('▼', 'Bajar', () => moveMode(i, 1));
    const del = iconBtn('🗑', 'Eliminar modo', () => {
      if (confirm(`¿Eliminar el modo "${m.name}"?`)) { modes.splice(i, 1); saveModes(); renderModesEditor(); renderWheel(); }
    });
    tools.append(up, dn, del);
    head.append(name, tools);

    const hint = document.createElement('div');
    hint.className = 'mode-hint';
    hint.textContent = i === 0 ? 'Modo por defecto (el primero de la lista). Una línea por imagen.' : 'Una línea por imagen. Aparecen en orden sobre el botón de captura.';

    const steps = document.createElement('textarea');
    steps.className = 'mode-steps';
    steps.rows = Math.max(3, (m.steps || []).length + 1);
    steps.value = (m.steps || []).join('\n');
    steps.placeholder = 'Imagen panorámica\nImagen transformador\nNúmero de poste';
    steps.addEventListener('input', e => {
      m.steps = e.target.value.split('\n').map(s => s.trim()).filter(s => s !== '');
      saveModes();
    });

    // WhatsApp por modo
    const waWrap = document.createElement('div');
    waWrap.className = 'mode-wa';
    const waTarget = document.createElement('input');
    waTarget.className = 'mode-wa-target';
    waTarget.value = m.waTarget || '';
    waTarget.placeholder = 'WhatsApp: chat o grupo (referencia)';
    waTarget.addEventListener('input', e => { m.waTarget = e.target.value; saveModes(); });
    const waMsg = document.createElement('textarea');
    waMsg.className = 'mode-wa-msg';
    waMsg.rows = 2;
    waMsg.value = m.waMessage || '';
    waMsg.placeholder = 'Mensaje al compartir (opcional). Se le añaden las horas de la 1ª y última imagen.';
    waMsg.addEventListener('input', e => { m.waMessage = e.target.value; saveModes(); });
    waWrap.append(waTarget, waMsg);

    card.append(head, hint, steps, waWrap);
    list.appendChild(card);
  });
}
function iconBtn(txt, title, fn) {
  const b = document.createElement('button');
  b.className = 'mini-btn'; b.textContent = txt; b.title = title;
  b.addEventListener('click', fn);
  return b;
}
function moveMode(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= modes.length) return;
  const t = modes[i]; modes[i] = modes[j]; modes[j] = t;
  saveModes(); renderModesEditor(); renderWheel();
}
function addMode() {
  const name = 'Nuevo modo';
  modes.push({ id: slug(name) + '_' + uid(), name, steps: [] });
  saveModes(); renderModesEditor(); renderWheel();
  const list = $('modes-list');
  list.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function refreshWheelNames() {
  [...$('wheel').children].forEach((c) => {
    const m = modes.find(x => x.id === c.dataset.id);
    if (m) c.textContent = m.name;
  });
}

/* --- Orientación --- */
async function applyOrientation() {
  if (config.orientation === 'auto') {
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
    return;
  }
  const lock = config.orientation === 'portrait' ? 'portrait' : 'landscape';
  try {
    if (screen.orientation && screen.orientation.lock) await screen.orientation.lock(lock);
  } catch (e) {
    if (isIOS) toast('El bloqueo de orientación no está disponible en iPhone (web)');
  }
}

/* =========================================================================
   COMPARTIR / IMPORTAR CONFIGURACIÓN
   (solo manual + confirmación; nada se sincroniza solo)
   ========================================================================= */
const SHAREABLE_KEYS = ['customText', 'orientation', 'align', 'colorMode', 'textColor', 'shadow',
  'showAltitude', 'showAddress', 'decimals', 'saveMode', 'filePrefix', 'aspect', 'textScale',
  'compass', 'sound', 'flash', 'torchStart', 'nightMode', 'whatsapp', 'whatsappMode', 'whatsappTarget'];
function pickSettings() { const o = {}; SHAREABLE_KEYS.forEach(k => { o[k] = config[k]; }); return o; }

function renderShareScreen() {
  $('chk-share-settings').checked = true;
  const list = $('share-modes-list');
  list.innerHTML = '';
  if (!modes.length) {
    const p = document.createElement('p'); p.className = 'note'; p.style.margin = '0';
    p.textContent = 'No tienes modos creados todavía.';
    list.appendChild(p);
    return;
  }
  modes.forEach(m => {
    const row = document.createElement('label');
    row.className = 'share-mode';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = true; cb.dataset.shareMode = m.id;
    const span = document.createElement('span');
    const n = (m.steps && m.steps.length) ? ` (${m.steps.length} pasos)` : ' (sin pasos)';
    span.textContent = m.name + n;
    row.append(cb, span);
    list.appendChild(row);
  });
}
function currentBundle() {
  const b = { v: 3 };
  if ($('chk-share-settings').checked) b.settings = pickSettings();
  const sel = modes.filter(m => {
    const el = document.querySelector(`input[data-share-mode="${m.id}"]`);
    return el && el.checked;
  }).map(m => ({ name: m.name, steps: m.steps || [], waTarget: m.waTarget || '', waMessage: m.waMessage || '' }));
  if (sel.length) b.modes = sel;
  return b;
}
function bundleIsEmpty(b) { return !b || (!b.settings && !(Array.isArray(b.modes) && b.modes.length) && b.text == null && !b.colorMode); }

function encodeBundle(b) {
  const bytes = new TextEncoder().encode(JSON.stringify(b));
  let bin = ''; bytes.forEach(c => bin += String.fromCharCode(c));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeBundle(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}
function shareLink(b) { return location.origin + location.pathname + '#cfg=' + encodeBundle(b); }

function copyText(t) {
  if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t).catch(() => fallbackCopy(t)); }
  else fallbackCopy(t);
}
function fallbackCopy(t) {
  const ta = document.createElement('textarea'); ta.value = t;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  ta.remove();
}

async function doShareSend() {
  const b = currentBundle();
  if (bundleIsEmpty(b)) { toast('Marca algo para compartir'); return; }
  const url = shareLink(b);
  if (navigator.share) {
    try { await navigator.share({ title: 'Configuración GeoCam', text: 'Abre este enlace para configurar GeoCam igual que yo:', url }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  copyText(url); toast('Enlace copiado al portapapeles');
}
function doShareCopy() {
  const b = currentBundle();
  if (bundleIsEmpty(b)) { toast('Marca algo para compartir'); return; }
  copyText(shareLink(b)); toast('Enlace copiado');
}

/* Aplica la configuración recibida (automático al abrir el enlace) */
function applyImport(b) {
  if (!b) return;
  if (b.settings && typeof b.settings === 'object') {
    SHAREABLE_KEYS.forEach(k => { if (b.settings[k] !== undefined) config[k] = b.settings[k]; });
  }
  // compatibilidad con enlaces antiguos
  if (b.text != null) config.customText = b.text;
  if (b.colorMode) { config.colorMode = b.colorMode; if (b.textColor) config.textColor = b.textColor; if (typeof b.shadow === 'boolean') config.shadow = b.shadow; }
  // modos: reemplaza por los del que comparte (queda igual que él)
  if (Array.isArray(b.modes)) {
    modes = b.modes.filter(mm => mm && mm.name).map(mm => ({
      id: slug(mm.name) + '_' + uid(),
      name: String(mm.name),
      steps: (mm.steps || []).map(s => String(s).trim()).filter(Boolean),
      waTarget: mm.waTarget || '', waMessage: mm.waMessage || ''
    }));
    activeModeId = modes[0] ? modes[0].id : 'libre';
    stepIndex = 0; modeBatch = [];
  }
  saveConfig(); saveModes();
  if (isScreen('settings')) renderSettings();
  renderWheel(); updateLiveOverlay(); updateCompass(); updateAspectFrame();
  toast('✓ Configuración aplicada');
}

function bindShare() {
  $('btn-share-back').addEventListener('click', () => showScreen('settings'));
  $('btn-share-send').addEventListener('click', doShareSend);
  $('btn-share-copy').addEventListener('click', doShareCopy);
}

/* Detecta enlace entrante #cfg= al abrir y lo aplica automáticamente */
function checkIncomingConfig() {
  const m = location.hash.match(/[#&]cfg=([^&]+)/);
  if (!m) return;
  let b = null;
  try { b = decodeBundle(m[1]); } catch (e) { b = null; }
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  if (b && !bundleIsEmpty(b)) applyImport(b);
}

/* =========================================================================
   EDITOR DE GALERÍA (apartado superior)
   ========================================================================= */
let editorImg = null;
let editorPos = null;
let editorDate = new Date();
let editorDrag = { x: 0.028, y: 0.92 };
let leafletMap = null, leafletMarker = null;

function openEditor() { showScreen('editor'); }
function editorLinesNow() { return buildLines(editorPos, editorDate); }

function editorRefreshOverlay() {
  const ov = $('editor-overlay');
  if (!editorImg) { ov.classList.remove('show'); return; }
  ov.classList.add('show');
  ov.style.color = (config.colorMode === 'auto') ? (config.textColor || '#C9D646') : config.textColor;
  ov.style.textAlign = config.align;
  ov.style.textShadow = config.shadow ? '0 1px 3px rgba(0,0,0,.85)' : 'none';
  ov.innerHTML = '';
  editorLinesNow().forEach(t => { const d = document.createElement('div'); d.textContent = t; ov.appendChild(d); });
  positionEditorOverlay();
}
function positionEditorOverlay() {
  const wrap = $('editor-canvas-wrap');
  const ov = $('editor-overlay');
  const r = wrap.getBoundingClientRect();
  ov.style.left = (editorDrag.x * r.width) + 'px';
  ov.style.top = (editorDrag.y * r.height) + 'px';
  ov.style.transform = config.align === 'center' ? 'translate(-50%, -100%)'
                    : config.align === 'right' ? 'translate(-100%, -100%)'
                    : 'translate(0, -100%)';
}
function loadEditorImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    editorImg = img;
    const preview = $('editor-preview');
    preview.src = url;
    preview.classList.add('show');
    $('editor-empty').classList.add('hidden');
    editorDate = new Date();
    setEditorDateInput(editorDate);
    editorRefreshOverlay();
  };
  img.src = url;
}
function setEditorDateInput(d) {
  $('editor-date').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function bindEditor() {
  $('editor-file').addEventListener('change', e => { if (e.target.files[0]) loadEditorImage(e.target.files[0]); });
  $('editor-lat').addEventListener('input', syncEditorManualCoords);
  $('editor-lon').addEventListener('input', syncEditorManualCoords);
  $('editor-alt').addEventListener('input', syncEditorManualCoords);
  $('editor-date').addEventListener('change', e => { const v = e.target.value; if (v) { editorDate = new Date(v); editorRefreshOverlay(); } });

  $('btn-editor-gps').addEventListener('click', () => {
    toast('Obteniendo ubicación…');
    navigator.geolocation.getCurrentPosition(p => {
      editorPos = p;
      $('editor-lat').value = p.coords.latitude.toFixed(config.decimals);
      $('editor-lon').value = p.coords.longitude.toFixed(config.decimals);
      $('editor-alt').value = (p.coords.altitude != null && !isNaN(p.coords.altitude)) ? p.coords.altitude.toFixed(1) : '';
      editorRefreshOverlay();
    }, () => toast('No se pudo obtener ubicación'), { enableHighAccuracy: true, timeout: 15000 });
  });
  $('btn-editor-map').addEventListener('click', openMap);
  $('btn-map-cancel').addEventListener('click', closeMap);
  $('btn-map-confirm').addEventListener('click', confirmMap);
  $('btn-map-here').addEventListener('click', mapCenterHere);
  $('btn-editor-save').addEventListener('click', saveEditorImage);

  const ov = $('editor-overlay');
  let dragging = false;
  const start = (e) => { if (!editorImg) return; dragging = true; e.preventDefault(); };
  const move = (e) => {
    if (!dragging) return;
    const t = e.touches && e.touches[0] ? e.touches[0] : e;
    const r = $('editor-canvas-wrap').getBoundingClientRect();
    editorDrag.x = Math.min(1, Math.max(0, (t.clientX - r.left) / r.width));
    editorDrag.y = Math.min(1, Math.max(0, (t.clientY - r.top) / r.height));
    positionEditorOverlay();
  };
  const end = () => { dragging = false; };
  ov.addEventListener('mousedown', start); window.addEventListener('mousemove', move); window.addEventListener('mouseup', end);
  ov.addEventListener('touchstart', start, { passive: false }); window.addEventListener('touchmove', move, { passive: false }); window.addEventListener('touchend', end);
}
function syncEditorManualCoords() {
  const lat = parseFloat($('editor-lat').value);
  const lon = parseFloat($('editor-lon').value);
  const alt = parseFloat($('editor-alt').value);
  if (!isNaN(lat) && !isNaN(lon)) {
    editorPos = { coords: { latitude: lat, longitude: lon, altitude: isNaN(alt) ? null : alt } };
  } else { editorPos = null; }
  editorRefreshOverlay();
}

/* --- Mapa (Leaflet + OpenStreetMap, carga diferida) --- */
function ensureLeaflet() {
  if (window.L) return Promise.resolve();
  return new Promise((res, rej) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}
async function openMap() {
  $('map-modal').classList.add('show');
  try { await ensureLeaflet(); } catch (e) { toast('No se pudo cargar el mapa (sin conexión)'); closeMap(); return; }
  const startLat = editorPos ? editorPos.coords.latitude : (lastPos ? lastPos.coords.latitude : -33.611);
  const startLon = editorPos ? editorPos.coords.longitude : (lastPos ? lastPos.coords.longitude : -70.575);
  if (!leafletMap) {
    leafletMap = L.map('map').setView([startLat, startLon], 16);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(leafletMap);
    leafletMap.on('click', (ev) => placeMarker(ev.latlng.lat, ev.latlng.lng));
  } else {
    leafletMap.setView([startLat, startLon], 16);
  }
  setTimeout(() => leafletMap.invalidateSize(), 80);
  if (editorPos) placeMarker(editorPos.coords.latitude, editorPos.coords.longitude);
}
let pendingMapPos = null;
function placeMarker(lat, lon) {
  pendingMapPos = { lat, lon };
  $('map-coords').textContent = `${lat.toFixed(config.decimals)}, ${lon.toFixed(config.decimals)}`;
  if (leafletMarker) leafletMarker.setLatLng([lat, lon]);
  else leafletMarker = L.marker([lat, lon]).addTo(leafletMap);
}
function mapCenterHere() {
  navigator.geolocation.getCurrentPosition(p => {
    leafletMap.setView([p.coords.latitude, p.coords.longitude], 17);
    placeMarker(p.coords.latitude, p.coords.longitude);
  }, () => toast('No se pudo obtener ubicación'), { enableHighAccuracy: true });
}
function confirmMap() {
  if (!pendingMapPos) { toast('Toca el mapa para elegir un punto'); return; }
  editorPos = { coords: { latitude: pendingMapPos.lat, longitude: pendingMapPos.lon, altitude: null } };
  $('editor-lat').value = pendingMapPos.lat.toFixed(config.decimals);
  $('editor-lon').value = pendingMapPos.lon.toFixed(config.decimals);
  editorRefreshOverlay();
  closeMap();
}
function closeMap() { $('map-modal').classList.remove('show'); }

/* --- Guardar imagen editada --- */
function saveEditorImage() {
  if (!editorImg) { toast('Primero carga una imagen'); return; }
  const w = editorImg.naturalWidth, h = editorImg.naturalHeight;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(editorImg, 0, 0, w, h);

  const lines = editorLinesNow();
  const fontPx = Math.max(14, Math.round(Math.min(w, h) * 0.033));
  const lh = Math.round(fontPx * 1.34);
  const blockH = lh * lines.length;
  const topY = Math.max(4, Math.round(editorDrag.y * h) - blockH);
  const x = Math.round(editorDrag.x * w);
  const lum = regionLuminance(ctx, Math.max(0, x - w * 0.4), topY, w * 0.8, blockH);
  const col = pickColors(lum);
  drawLines(ctx, lines, { fontPx, color: col.text, outline: col.outline, align: config.align, x, topY, shadow: config.shadow });

  c.toBlob(b => saveBlob(b), 'image/jpeg', 0.95);
}

/* =========================================================================
   INSTALAR APP (recomendación al abrir en navegador)
   ========================================================================= */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; });
window.addEventListener('appinstalled', () => { hideInstall(); });

function maybeShowInstall() {
  if (isStandalone()) return;
  if (sessionStorage.getItem('geocam.hideInstall')) return;
  $('install-text').textContent = isIOS
    ? 'Instala GeoCam: toca Compartir y "Añadir a pantalla de inicio".'
    : 'Instala GeoCam como app para abrirla más rápido.';
  $('btn-install').textContent = isIOS ? 'Cómo' : 'Instalar';
  $('install-banner').classList.add('show');
}
function hideInstall() { $('install-banner').classList.remove('show'); }
function bindInstall() {
  $('btn-install').addEventListener('click', async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      try { await deferredPrompt.userChoice; } catch (e) {}
      deferredPrompt = null; hideInstall();
    } else if (isIOS) {
      alert('Para instalar en iPhone:\n1) Toca el botón Compartir (cuadrado con flecha).\n2) "Añadir a pantalla de inicio".\n3) Añadir.');
    } else {
      toast('Usa el menú del navegador → Instalar app');
    }
  });
  $('btn-install-close').addEventListener('click', () => { sessionStorage.setItem('geocam.hideInstall', '1'); hideInstall(); });
}

/* =========================================================================
   UTILIDADES UI
   ========================================================================= */
let toastTimer = null;
function toast(msg, ms) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms || 2200);
}

function showStartOverlay(err) {
  const o = $('start-overlay');
  o.classList.add('show');
  let msg = 'Toca para activar la cámara';
  if (err) {
    if (err.name === 'NotAllowedError') msg = 'Permiso denegado. Activa la cámara en los ajustes del navegador y toca para reintentar.';
    else if (err.name === 'NotFoundError') msg = 'No se encontró cámara en este dispositivo.';
    else if (location.protocol !== 'https:' && location.hostname !== 'localhost') msg = 'La cámara requiere HTTPS. Abre la app desde su dirección https:// de GitHub Pages.';
    else msg = 'No se pudo abrir la cámara. Toca para reintentar.';
  }
  $('start-msg').textContent = msg;
}
function hideStartOverlay() { $('start-overlay').classList.remove('show'); }

/* =========================================================================
   INICIO
   ========================================================================= */
function bindControls() {
  $('shutter').addEventListener('click', () => { ensureHeading(); capturePhoto(); });
  $('btn-torch').addEventListener('click', toggleTorch);
  $('btn-macro').addEventListener('click', toggleMacro);
  $('btn-lens').addEventListener('click', switchLens);
  $('btn-settings').addEventListener('click', () => showScreen('settings'));
  $('btn-settings-back').addEventListener('click', () => showScreen('camera'));
  $('btn-editor').addEventListener('click', openEditor);
  $('btn-editor-back').addEventListener('click', () => showScreen('camera'));
  $('reminder-skip').addEventListener('click', skipStep);
  $('reminder-restart').addEventListener('click', restartSeq);
  $('start-btn').addEventListener('click', () => { ensureHeading(); startCamera(currentDeviceId); });
  $('thumb').addEventListener('click', () => { if (lastThumbURL) window.open(lastThumbURL, '_blank'); });
  $('viewfinder-tap').addEventListener('click', onViewfinderTap);
  $('compass').addEventListener('click', ensureHeading);
  $('zoom-badge').addEventListener('click', resetZoom);
}
function tickClock() { setInterval(() => { if (isScreen('camera')) updateLiveOverlay(); }, 1000); }
function registerSW() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
  }
}

function init() {
  bindControls();
  bindSettings();
  bindEditor();
  bindShare();
  bindInstall();
  bindWheelScroll();
  bindSwipe();
  bindPinch();
  renderWheel();
  updateLiveOverlay();
  updateCompass();
  updateAspectFrame();
  tickClock();
  startGeo();
  applyOrientation();
  registerSW();
  maybeShowInstall();
  checkIncomingConfig();

  window.addEventListener('resize', updateAspectFrame);
  window.addEventListener('orientationchange', () => setTimeout(updateAspectFrame, 200));

  // La brújula (iOS) exige permiso desde un gesto: lo pedimos en la primera interacción.
  const kickHeading = () => { ensureHeading(); };
  window.addEventListener('touchend', kickHeading, { once: true });
  window.addEventListener('click', kickHeading, { once: true });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isScreen('camera')) { ensureCamera(); startBrightnessMonitor(); }
    else { stopBrightnessMonitor(); }
  });

  showScreen('camera');
}

document.addEventListener('DOMContentLoaded', init);
