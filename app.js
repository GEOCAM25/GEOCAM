'use strict';

/* =========================================================================
   GeoCam — cámara web con texto, fecha y coordenadas
   Almacenamiento 100% local por dispositivo (localStorage).
   Cada instalación es un "usuario" independiente: nada se mezcla ni se comparte.
   ========================================================================= */

/* ---------------- Almacenamiento local ---------------- */
const LS = { config: 'geocam.config.v1', modes: 'geocam.modes.v1' };

const DEFAULT_CONFIG = {
  customText: 'Departamento de Operación y Distribución [EEPA]',
  orientation: 'auto',        // auto | portrait | landscape
  align: 'left',              // left | center | right
  textColor: '#C9D646',
  showAltitude: true,
  showHeading: false,
  saveMode: 'auto',           // auto | share | download
  decimals: 5,
  filePrefix: 'foto'
};

const DEFAULT_MODES = [
  { id: 'libre',        name: 'Libre',        steps: [] },
  { id: 'reemplazo_um', name: 'Reemplazo UM', steps: ['Medidor cerrado antes', 'Medidor abierto antes', 'Ambos medidores'] },
  { id: 'falla',        name: 'Falla',        steps: ['Imagen panorámica', 'Imagen transformador', 'Número de poste', 'Cinta de peligro'] }
];

const clone = (o) => JSON.parse(JSON.stringify(o));

function loadConfig() {
  try { return Object.assign({}, DEFAULT_CONFIG, JSON.parse(localStorage.getItem(LS.config) || '{}')); }
  catch (e) { return clone(DEFAULT_CONFIG); }
}
function saveConfig() { localStorage.setItem(LS.config, JSON.stringify(config)); }
function loadModes() {
  try { const m = JSON.parse(localStorage.getItem(LS.modes)); return (Array.isArray(m) && m.length) ? m : clone(DEFAULT_MODES); }
  catch (e) { return clone(DEFAULT_MODES); }
}
function saveModes() { localStorage.setItem(LS.modes, JSON.stringify(modes)); }

let config = loadConfig();
let modes = loadModes();

/* ---------------- Detección de plataforma ---------------- */
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/* ---------------- Atajos DOM ---------------- */
const $ = (id) => document.getElementById(id);
const body = document.body;
const video = $('video');

/* ---------------- Estado de cámara ---------------- */
let stream = null, videoTrack = null, currentDeviceId = null;
let lensList = [], lensIndex = 0;
let torchOn = false, torchSupported = false;
let cameraStarting = false;

/* ---------------- Geolocalización / brújula ---------------- */
let lastPos = null, geoWatch = null, lastHeading = null, headingBound = false;

/* ---------------- Modos / recordatorios ---------------- */
let activeModeId = (modes[0] && modes[0].id) || 'libre';
let stepIndex = 0;

/* =========================================================================
   PANTALLAS
   ========================================================================= */
function isScreen(name) { return body.dataset.screen === name; }
function showScreen(name) {
  body.dataset.screen = name;
  if (name === 'camera') { ensureCamera(); startBrightnessMonitor(); }
  else { stopBrightnessMonitor(); }
  if (name === 'settings') renderSettings();
}

/* =========================================================================
   CÁMARA
   ========================================================================= */
async function ensureCamera() {
  if (stream && video.srcObject && videoTrack && videoTrack.readyState === 'live') return;
  await startCamera(currentDeviceId);
}

function stopStream() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); }
  stream = null; videoTrack = null; torchOn = false;
}

async function startCamera(deviceId) {
  if (cameraStarting) return;
  cameraStarting = true;
  hideStartOverlay();
  stopStream();
  const base = { width: { ideal: 1920 }, height: { ideal: 1080 } };
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
  detectTorch();
  await enumerateCams();
  cameraStarting = false;
  updateLiveOverlay();
}

async function enumerateCams() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const vids = devices.filter(d => d.kind === 'videoinput');
    const backs = vids.filter(d => /back|rear|environment|trasera|posterior|wide|tele/i.test(d.label || ''));
    lensList = backs.length ? backs : vids;
    const idx = lensList.findIndex(d => d.deviceId === currentDeviceId);
    lensIndex = idx >= 0 ? idx : 0;
    $('btn-lens').classList.toggle('hidden', lensList.length < 2);
  } catch (e) {}
}

async function switchLens() {
  if (lensList.length < 2) { toast('Sin lentes adicionales en este equipo'); return; }
  lensIndex = (lensIndex + 1) % lensList.length;
  const label = (lensList[lensIndex].label || '').toLowerCase();
  await startCamera(lensList[lensIndex].deviceId);
  toast(/ultra|wide|gran/.test(label) ? 'Gran angular' : (/tele/.test(label) ? 'Teleobjetivo' : 'Cámara ' + (lensIndex + 1)));
}

/* ---- Linterna (torch) ---- */
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
  try {
    await videoTrack.applyConstraints({ advanced: [{ torch: torchOn }] });
    $('btn-torch').classList.toggle('on', torchOn);
  } catch (e) { torchOn = !torchOn; toast('No se pudo cambiar la linterna'); }
}

/* ---- Macro: enfoque cercano (best-effort) + captura ---- */
async function macroCapture() {
  let applied = false;
  try {
    const caps = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
    if (caps.focusDistance) {
      await videoTrack.applyConstraints({ advanced: [{ focusMode: 'manual', focusDistance: caps.focusDistance.min }] });
      applied = true; toast('Macro · enfoque cercano');
    }
  } catch (e) {}
  if (!applied) {
    const uw = lensList.find(d => /ultra|wide|gran/i.test(d.label || ''));
    if (uw && uw.deviceId !== currentDeviceId) {
      await startCamera(uw.deviceId);
      lensIndex = lensList.findIndex(d => d.deviceId === uw.deviceId);
      applied = true; toast('Macro · gran angular');
      await new Promise(r => setTimeout(r, 400));
    }
  }
  if (!applied) toast(isIOS ? 'Macro limitado en iPhone (web). Acerca el equipo' : 'Acerca el equipo al objeto');
  capturePhoto();
}

/* ---- Tocar para enfocar ---- */
function onViewfinderTap(e) {
  if (!isScreen('camera')) return;
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

/* ---- Monitor de luminosidad (badge de poca luz) ---- */
let brightTimer = null;
const bCanvas = document.createElement('canvas'); bCanvas.width = 16; bCanvas.height = 16;
const bCtx = bCanvas.getContext('2d', { willReadFrequently: true });
function startBrightnessMonitor() { stopBrightnessMonitor(); brightTimer = setInterval(sampleBrightness, 1600); }
function stopBrightnessMonitor() { if (brightTimer) clearInterval(brightTimer); brightTimer = null; }
function sampleBrightness() {
  if (document.hidden || !isScreen('camera') || !video.videoWidth) return;
  try {
    bCtx.drawImage(video, 0, 0, 16, 16);
    const d = bCtx.getImageData(0, 0, 16, 16).data;
    let s = 0; for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const avg = s / (d.length / 4);
    $('lowlight').classList.toggle('show', avg < 42);
  } catch (e) {}
}

/* =========================================================================
   GEOLOCALIZACIÓN
   ========================================================================= */
function startGeo() {
  if (!navigator.geolocation) { $('coords-readout').textContent = 'GPS no disponible'; return; }
  if (geoWatch != null) return;
  geoWatch = navigator.geolocation.watchPosition(
    (p) => { lastPos = p; $('coords-readout').classList.add('ok'); updateLiveOverlay(); },
    (e) => { $('coords-readout').classList.remove('ok'); if (!lastPos) $('coords-readout').textContent = 'Buscando GPS…'; },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
  );
}

async function startHeading() {
  if (!config.showHeading || headingBound) return;
  const handler = (ev) => {
    let h = null;
    if (typeof ev.webkitCompassHeading === 'number') h = ev.webkitCompassHeading;
    else if (ev.absolute && typeof ev.alpha === 'number') h = (360 - ev.alpha) % 360;
    if (h != null && !isNaN(h)) lastHeading = h;
  };
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try { const r = await DeviceOrientationEvent.requestPermission(); if (r !== 'granted') return; } catch (e) { return; }
  }
  window.addEventListener('deviceorientationabsolute', handler, true);
  window.addEventListener('deviceorientation', handler, true);
  headingBound = true;
}

/* =========================================================================
   OVERLAY (texto + coords + fecha)
   ========================================================================= */
function pad(n) { return String(n).padStart(2, '0'); }
function formatDate(d) {
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function buildLines(pos, heading, date) {
  date = date || new Date();
  const lines = [];
  (config.customText || '').split('\n').forEach(t => { if (t.trim() !== '') lines.push(t); });
  let coord;
  if (pos && pos.coords && typeof pos.coords.latitude === 'number') {
    const lat = pos.coords.latitude.toFixed(config.decimals);
    const lon = pos.coords.longitude.toFixed(config.decimals);
    coord = `${lat}, ${lon}`;
    if (config.showAltitude && pos.coords.altitude != null && !isNaN(pos.coords.altitude))
      coord += `, ${pos.coords.altitude.toFixed(1)}m`;
    if (config.showHeading && heading != null) coord += `, ${Math.round(heading)}°`;
  } else {
    coord = 'Sin señal GPS';
  }
  lines.push(coord);
  lines.push(formatDate(date));
  return lines;
}

function updateLiveOverlay() {
  const ov = $('overlay');
  const lines = buildLines(lastPos, lastHeading);
  ov.style.textAlign = config.align;
  ov.style.color = config.textColor;
  ov.innerHTML = '';
  lines.forEach(t => { const div = document.createElement('div'); div.textContent = t; ov.appendChild(div); });
  if (lastPos) $('coords-readout').textContent =
    lastPos.coords.latitude.toFixed(5) + ', ' + lastPos.coords.longitude.toFixed(5);
}

/* Dibuja líneas de texto en un canvas con sombra + contorno (legibilidad) */
function drawLines(ctx, lines, o) {
  const lh = Math.round(o.fontPx * 1.34);
  ctx.font = `600 ${o.fontPx}px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  ctx.textAlign = o.align; ctx.textBaseline = 'top';
  lines.forEach((t, i) => {
    const y = o.topY + i * lh;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.78)';
    ctx.shadowBlur = Math.max(2, o.fontPx * 0.14);
    ctx.shadowOffsetY = Math.max(1, o.fontPx * 0.05);
    ctx.lineWidth = Math.max(1, o.fontPx * 0.085);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.strokeText(t, o.x, y);
    ctx.restore();
    ctx.fillStyle = o.color; ctx.fillText(t, o.x, y);
  });
  return lh * lines.length;
}

function overlayAnchorX(w) {
  return config.align === 'left' ? Math.round(w * 0.028)
       : config.align === 'right' ? Math.round(w * 0.972)
       : Math.round(w / 2);
}

function drawOverlayBottom(ctx, w, h, pos, heading, date) {
  const lines = buildLines(pos, heading, date);
  const fontPx = Math.max(14, Math.round(Math.min(w, h) * 0.033));
  const lh = Math.round(fontPx * 1.34);
  const topY = h - Math.round(h * 0.03) - lh * lines.length;
  drawLines(ctx, lines, { fontPx, color: config.textColor, align: config.align, x: overlayAnchorX(w), topY });
}

/* =========================================================================
   CAPTURA Y GUARDADO
   ========================================================================= */
const shotCanvas = document.createElement('canvas');

function capturePhoto() {
  if (!video.videoWidth) { toast('La cámara aún no está lista'); return; }
  const vw = video.videoWidth, vh = video.videoHeight;
  shotCanvas.width = vw; shotCanvas.height = vh;
  const ctx = shotCanvas.getContext('2d');
  ctx.drawImage(video, 0, 0, vw, vh);
  drawOverlayBottom(ctx, vw, vh, lastPos, lastHeading, new Date());
  flashScreen();
  shotCanvas.toBlob((blob) => {
    setThumb(blob);
    saveBlob(blob);
    afterCaptureAdvance();
  }, 'image/jpeg', 0.95);
}

function tsName() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function saveBlob(blob) {
  const fname = `${config.filePrefix || 'foto'}_${tsName()}.jpg`;
  const file = new File([blob], fname, { type: 'image/jpeg' });
  const preferShare = config.saveMode === 'share' || (config.saveMode === 'auto' && isIOS);
  if (preferShare && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); toast('Listo · guarda con "Guardar imagen"'); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
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

/* =========================================================================
   MODOS + RECORDATORIOS (rueda estilo iPhone)
   ========================================================================= */
function activeMode() { return modes.find(m => m.id === activeModeId) || modes[0]; }

function renderWheel() {
  const wheel = $('wheel');
  wheel.innerHTML = '';
  modes.forEach(m => {
    const el = document.createElement('button');
    el.className = 'wheel-item';
    el.dataset.id = m.id;
    el.textContent = m.name;
    el.addEventListener('click', () => selectMode(m.id, true));
    wheel.appendChild(el);
  });
  if (!modes.find(m => m.id === activeModeId)) activeModeId = modes[0] ? modes[0].id : 'libre';
  updateWheelActive();
  updateReminder();
  requestAnimationFrame(() => scrollWheelTo(activeModeId, false));
}

function selectMode(id, doScroll) {
  if (id === activeModeId) { stepIndex = 0; } else { activeModeId = id; stepIndex = 0; }
  updateWheelActive();
  updateReminder();
  if (doScroll) scrollWheelTo(id, true);
}

function updateWheelActive() {
  [...$('wheel').children].forEach(c => c.classList.toggle('active', c.dataset.id === activeModeId));
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
function restartSeq() { stepIndex = 0; updateReminder(); }

/* =========================================================================
   CONFIGURACIÓN
   ========================================================================= */
function renderSettings() {
  $('cfg-text').value = config.customText;
  $('cfg-orientation').value = config.orientation;
  $('cfg-align').value = config.align;
  $('cfg-color').value = config.textColor;
  $('cfg-altitude').checked = config.showAltitude;
  $('cfg-heading').checked = config.showHeading;
  $('cfg-save').value = config.saveMode;
  $('cfg-decimals').value = String(config.decimals);
  $('cfg-prefix').value = config.filePrefix;
  renderModesEditor();
}

function bindSettings() {
  $('cfg-text').addEventListener('input', e => { config.customText = e.target.value; saveConfig(); });
  $('cfg-orientation').addEventListener('change', e => { config.orientation = e.target.value; saveConfig(); applyOrientation(); });
  $('cfg-align').addEventListener('change', e => { config.align = e.target.value; saveConfig(); updateLiveOverlay(); });
  $('cfg-color').addEventListener('input', e => { config.textColor = e.target.value; saveConfig(); updateLiveOverlay(); });
  $('cfg-altitude').addEventListener('change', e => { config.showAltitude = e.target.checked; saveConfig(); updateLiveOverlay(); });
  $('cfg-heading').addEventListener('change', e => {
    config.showHeading = e.target.checked; saveConfig();
    if (config.showHeading) startHeading();
    updateLiveOverlay();
  });
  $('cfg-save').addEventListener('change', e => { config.saveMode = e.target.value; saveConfig(); });
  $('cfg-decimals').addEventListener('change', e => { config.decimals = parseInt(e.target.value, 10); saveConfig(); updateLiveOverlay(); });
  $('cfg-prefix').addEventListener('input', e => { config.filePrefix = e.target.value.replace(/[^\w\-]/g, '') || 'foto'; saveConfig(); });
  $('btn-add-mode').addEventListener('click', addMode);
  $('btn-reset').addEventListener('click', () => {
    if (confirm('¿Restablecer textos y modos a los valores de fábrica? Solo afecta a este dispositivo.')) {
      config = clone(DEFAULT_CONFIG); modes = clone(DEFAULT_MODES);
      saveConfig(); saveModes(); renderSettings(); renderWheel(); updateLiveOverlay();
      toast('Restablecido');
    }
  });
}

/* --- Editor de modos --- */
function slug(s) { return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '') || ('m' + Date.now()); }

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
      if (confirm(`¿Eliminar el modo "${m.name}"?`)) { modes.splice(i, 1); if (!modes.length) modes.push(clone(DEFAULT_MODES[0])); saveModes(); renderModesEditor(); renderWheel(); }
    });
    tools.append(up, dn, del);
    head.append(name, tools);

    const hint = document.createElement('div');
    hint.className = 'mode-hint';
    hint.textContent = 'Una línea por imagen. Aparecen en orden sobre el botón de captura.';

    const steps = document.createElement('textarea');
    steps.className = 'mode-steps';
    steps.rows = Math.max(3, (m.steps || []).length + 1);
    steps.value = (m.steps || []).join('\n');
    steps.placeholder = 'Imagen panorámica\nImagen transformador\nNúmero de poste';
    steps.addEventListener('input', e => {
      m.steps = e.target.value.split('\n').map(s => s.trim()).filter(s => s !== '');
      saveModes();
    });

    card.append(head, hint, steps);
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
  modes.push({ id: slug(name) + '_' + Date.now().toString(36), name, steps: [] });
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
  try {
    if (screen.orientation && screen.orientation.lock) await screen.orientation.lock(config.orientation);
  } catch (e) {
    if (isIOS) toast('El bloqueo de orientación no está disponible en iPhone (web)');
  }
}

/* =========================================================================
   EDITOR DE GALERÍA (apartado oculto superior)
   ========================================================================= */
let editorImg = null;            // Image cargada
let editorPos = null;            // {coords:{latitude,longitude,altitude}}
let editorDate = new Date();
let editorDrag = { x: 0.028, y: 0.92 }; // posición relativa (ancla del bloque) 0..1
let leafletMap = null, leafletMarker = null;

function openEditor() { showScreen('editor'); }

function editorLinesNow() {
  return buildLines(editorPos, null, editorDate);
}

function editorRefreshOverlay() {
  const ov = $('editor-overlay');
  if (!editorImg) { ov.classList.remove('show'); return; }
  ov.classList.add('show');
  ov.style.color = config.textColor;
  ov.style.textAlign = config.align;
  ov.innerHTML = '';
  editorLinesNow().forEach(t => { const d = document.createElement('div'); d.textContent = t; ov.appendChild(d); });
  positionEditorOverlay();
}

function positionEditorOverlay() {
  const wrap = $('editor-canvas-wrap');
  const ov = $('editor-overlay');
  const r = wrap.getBoundingClientRect();
  // ancla: usamos esquina inferior-izquierda del bloque como punto de arrastre
  const x = editorDrag.x * r.width;
  const y = editorDrag.y * r.height;
  ov.style.left = x + 'px';
  ov.style.top = y + 'px';
  // ajustamos el transform según alineación
  ov.style.transform = config.align === 'center' ? 'translate(-50%, -100%)'
                    : config.align === 'right' ? 'translate(-100%, -100%)'
                    : 'translate(0, -100%)';
}

function loadEditorImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    editorImg = img;
    const wrap = $('editor-canvas-wrap');
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
  const v = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  $('editor-date').value = v;
}

function bindEditor() {
  $('editor-file').addEventListener('change', e => { if (e.target.files[0]) loadEditorImage(e.target.files[0]); });

  $('editor-lat').addEventListener('input', syncEditorManualCoords);
  $('editor-lon').addEventListener('input', syncEditorManualCoords);
  $('editor-alt').addEventListener('input', syncEditorManualCoords);
  $('editor-date').addEventListener('change', e => {
    const v = e.target.value; if (v) { editorDate = new Date(v); editorRefreshOverlay(); }
  });

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

  // arrastrar overlay
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
  ov.addEventListener('mousedown', start); ov.addEventListener('touchstart', start, { passive: false });
  window.addEventListener('mousemove', move); window.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('mouseup', end); window.addEventListener('touchend', end);
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
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
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
  const ctx = c.getContext('2d');
  ctx.drawImage(editorImg, 0, 0, w, h);

  const lines = editorLinesNow();
  const fontPx = Math.max(14, Math.round(Math.min(w, h) * 0.033));
  const lh = Math.round(fontPx * 1.34);
  // editorDrag es el ancla inferior-izquierda del bloque (en proporción del wrap == proporción de la imagen)
  const blockH = lh * lines.length;
  const topY = Math.round(editorDrag.y * h) - blockH;
  let x;
  if (config.align === 'left') x = Math.round(editorDrag.x * w);
  else if (config.align === 'right') x = Math.round(editorDrag.x * w);
  else x = Math.round(editorDrag.x * w);
  drawLines(ctx, lines, { fontPx, color: config.textColor, align: config.align, x, topY: Math.max(4, topY) });

  c.toBlob(b => { saveBlob(b); }, 'image/jpeg', 0.95);
}

/* =========================================================================
   UTILIDADES UI
   ========================================================================= */
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
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
  $('shutter').addEventListener('click', capturePhoto);
  $('btn-torch').addEventListener('click', toggleTorch);
  $('btn-macro').addEventListener('click', macroCapture);
  $('btn-lens').addEventListener('click', switchLens);
  $('btn-settings').addEventListener('click', () => showScreen('settings'));
  $('btn-settings-back').addEventListener('click', () => showScreen('camera'));
  $('btn-editor').addEventListener('click', openEditor);
  $('btn-editor-back').addEventListener('click', () => showScreen('camera'));
  $('reminder-skip').addEventListener('click', skipStep);
  $('reminder-restart').addEventListener('click', restartSeq);
  $('start-btn').addEventListener('click', () => startCamera(currentDeviceId));
  $('thumb').addEventListener('click', () => { if (lastThumbURL) window.open(lastThumbURL, '_blank'); });

  // tocar para enfocar (en el área del visor, no en controles)
  $('viewfinder-tap').addEventListener('click', onViewfinderTap);
}

function tickClock() {
  setInterval(() => { if (isScreen('camera')) updateLiveOverlay(); }, 1000);
}

function registerSW() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }
}

function init() {
  bindControls();
  bindSettings();
  bindEditor();
  bindWheelScroll();
  renderWheel();
  updateLiveOverlay();
  tickClock();
  startGeo();
  if (config.showHeading) startHeading();
  applyOrientation();
  registerSW();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isScreen('camera')) { ensureCamera(); startBrightnessMonitor(); }
    else { stopBrightnessMonitor(); }
  });

  // Intento de arranque de cámara (si el navegador exige gesto, se mostrará el overlay)
  showScreen('camera');
}

document.addEventListener('DOMContentLoaded', init);
