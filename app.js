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
  decimals: 5,
  saveMode: 'auto',        // auto | share | download
  filePrefix: 'foto',
  compass: true,           // brújula en pantalla (nunca en la foto)
  sound: false,            // sonido al capturar (por defecto silencio)
  flash: false,            // flash al capturar (usa linterna)
  torchStart: false,       // linterna encendida al abrir
  whatsapp: false,         // compartir por WhatsApp tras capturar
  whatsappTarget: ''       // número/grupo (referencia)
};

// Sin modos predeterminados: cada persona crea los suyos en Configuración.
const DEFAULT_MODES = [];

const clone = (o) => JSON.parse(JSON.stringify(o));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
let torchOn = false, torchSupported = false;
let cameraStarting = false;

/* ---------------- Geo / brújula ---------------- */
let lastPos = null, geoWatch = null, lastHeading = null, headingBound = false;

/* ---------------- Color automático (vista en vivo) ---------------- */
let liveAutoColor = null;

/* ---------------- Modos ---------------- */
let activeModeId = (modes[0] && modes[0].id) || 'libre';
let stepIndex = 0;

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
  // Linterna siempre encendida al abrir
  if (config.torchStart && torchSupported && !torchOn) {
    try { await videoTrack.applyConstraints({ advanced: [{ torch: true }] }); torchOn = true; $('btn-torch').classList.add('on'); } catch (e) {}
  }
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
  try {
    await videoTrack.applyConstraints({ advanced: [{ torch: torchOn }] });
    $('btn-torch').classList.toggle('on', torchOn);
  } catch (e) { torchOn = !torchOn; toast('No se pudo cambiar la linterna'); }
}

/* ---- Macro ---- */
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
      await sleep(400);
    }
  }
  if (!applied) toast(isIOS ? 'Macro limitado en iPhone (web). Acerca el equipo' : 'Acerca el equipo al objeto');
  capturePhoto();
}

/* ---- Tocar para enfocar ---- */
function onViewfinderTap(e) {
  if (!isScreen('camera')) return;
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
    (p) => { lastPos = p; $('coords-readout').classList.add('ok'); updateLiveOverlay(); },
    (e) => { $('coords-readout').classList.remove('ok'); if (!lastPos) $('coords-readout').textContent = 'Buscando GPS…'; },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
  );
}

/* =========================================================================
   BRÚJULA (solo pantalla, nunca en la foto)
   ========================================================================= */
async function ensureHeading() {
  if (headingBound) return;
  const handler = (ev) => {
    let h = null;
    if (typeof ev.webkitCompassHeading === 'number') h = ev.webkitCompassHeading;
    else if (ev.absolute && typeof ev.alpha === 'number') h = (360 - ev.alpha) % 360;
    if (h != null && !isNaN(h)) { lastHeading = h; updateCompass(); }
  };
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try { const r = await DeviceOrientationEvent.requestPermission(); if (r !== 'granted') return; } catch (e) { return; }
  }
  window.addEventListener('deviceorientationabsolute', handler, true);
  window.addEventListener('deviceorientation', handler, true);
  headingBound = true;
}
function cardinalES(h) {
  h = ((h % 360) + 360) % 360;
  if (h >= 315 || h < 45) return 'Norte';
  if (h < 135) return 'Oriente';
  if (h < 225) return 'Sur';
  return 'Poniente';
}
function updateCompass() {
  const wrap = $('compass');
  if (!config.compass) { wrap.classList.remove('show'); return; }
  wrap.classList.add('show');
  const rose = $('compass-rose'), label = $('compass-label');
  if (lastHeading == null) { label.textContent = '—'; rose.style.transform = 'rotate(0deg)'; return; }
  rose.style.transform = `rotate(${-lastHeading}deg)`;
  label.textContent = cardinalES(lastHeading);
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
  const lines = buildLines(lastPos);
  ov.style.textAlign = config.align;
  ov.style.color = (config.colorMode === 'auto' && liveAutoColor) ? liveAutoColor : (config.textColor || '#C9D646');
  ov.style.textShadow = config.shadow ? '0 1px 3px rgba(0,0,0,.85),0 0 1px rgba(0,0,0,.9)' : 'none';
  ov.innerHTML = '';
  lines.forEach(t => { const div = document.createElement('div'); div.textContent = t; ov.appendChild(div); });
  if (lastPos) $('coords-readout').textContent =
    lastPos.coords.latitude.toFixed(5) + ', ' + lastPos.coords.longitude.toFixed(5);
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
  const fontPx = Math.max(14, Math.round(Math.min(w, h) * 0.033));
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

async function capturePhoto() {
  if (!video.videoWidth) { toast('La cámara aún no está lista'); return; }
  const gate = captureAllowed();
  if (!gate.ok) { toast(gate.msg); return; }

  // Flash (pseudo): pulso de linterna alrededor de la captura
  let turnedOn = false;
  if (config.flash && torchSupported && !torchOn) {
    try { await videoTrack.applyConstraints({ advanced: [{ torch: true }] }); turnedOn = true; await sleep(130); } catch (e) {}
  } else if (config.flash && !torchSupported && isIOS) {
    // sin linterna en iPhone web; se captura igual
  }

  const vw = video.videoWidth, vh = video.videoHeight;
  shotCanvas.width = vw; shotCanvas.height = vh;
  const ctx = shotCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, vw, vh);
  const blurry = isBlurry(shotCanvas);
  drawOverlayBottom(ctx, vw, vh, lastPos, new Date());
  flashScreen();
  shutterSound();

  shotCanvas.toBlob((blob) => {
    setThumb(blob);
    saveBlob(blob);
    if (blurry) toast('IMAGEN MOVIDA', 1000);
    afterCaptureAdvance();
  }, 'image/jpeg', 0.95);

  if (turnedOn) { try { await videoTrack.applyConstraints({ advanced: [{ torch: false }] }); } catch (e) {} }
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

function tsName() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function waCaption() { return buildLines(lastPos).join('\n'); }

async function saveBlob(blob) {
  const fname = `${config.filePrefix || 'foto'}_${tsName()}.jpg`;
  const file = new File([blob], fname, { type: 'image/jpeg' });
  const wantShare = config.whatsapp || config.saveMode === 'share' || (config.saveMode === 'auto' && isIOS);

  if (wantShare && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      const data = { files: [file] };
      if (config.whatsapp) data.text = waCaption();
      await navigator.share(data);
      toast(config.whatsapp ? 'Elige WhatsApp y el chat, luego envía' : 'Listo · guarda con "Guardar imagen"');
      return;
    } catch (e) { if (e && e.name === 'AbortError') return; }
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
  $('cfg-color-mode').value = config.colorMode;
  $('cfg-color').value = config.textColor;
  $('cfg-shadow').checked = config.shadow;
  $('cfg-altitude').checked = config.showAltitude;
  $('cfg-decimals').value = String(config.decimals);
  $('cfg-save').value = config.saveMode;
  $('cfg-prefix').value = config.filePrefix;
  $('cfg-compass').checked = config.compass;
  $('cfg-sound').checked = config.sound;
  $('cfg-flash').checked = config.flash;
  $('cfg-torch-start').checked = config.torchStart;
  $('cfg-whatsapp').checked = config.whatsapp;
  $('cfg-whatsapp-target').value = config.whatsappTarget || '';
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
  $('cfg-whatsapp').addEventListener('change', e => { config.whatsapp = e.target.checked; saveConfig(); });
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
function renderShareScreen() {
  $('chk-share-text').checked = true;
  $('chk-share-color').checked = true;
  const list = $('share-modes-list');
  list.innerHTML = '';
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
  const b = { v: 2 };
  if ($('chk-share-text').checked) b.text = config.customText;
  if ($('chk-share-color').checked) { b.colorMode = config.colorMode; b.textColor = config.textColor; b.shadow = config.shadow; }
  const sel = modes.filter(m => {
    const el = document.querySelector(`input[data-share-mode="${m.id}"]`);
    return el && el.checked;
  }).map(m => ({ name: m.name, steps: m.steps || [] }));
  if (sel.length) b.modes = sel;
  return b;
}
function bundleIsEmpty(b) { return b.text == null && !b.colorMode && !Array.isArray(b.modes); }

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
  if (bundleIsEmpty(b)) { toast('Selecciona algo para compartir'); return; }
  const url = shareLink(b);
  if (navigator.share) {
    try { await navigator.share({ title: 'Configuración GeoCam', text: 'Abre este enlace en GeoCam para importar mi configuración:', url }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  copyText(url); toast('Enlace copiado al portapapeles');
}
function doShareCopy() {
  const b = currentBundle();
  if (bundleIsEmpty(b)) { toast('Selecciona algo para compartir'); return; }
  copyText(shareLink(b)); toast('Enlace copiado');
}
function doShareFile() {
  const b = currentBundle();
  if (bundleIsEmpty(b)) { toast('Selecciona algo para exportar'); return; }
  const blob = new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'geocam-config.json'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('Archivo exportado');
}

function openImportModal(b) {
  if (!b || bundleIsEmpty(b)) { toast('No hay nada que importar'); return; }
  pendingImport = b;
  const parts = [];
  if (b.text != null) parts.push('• Texto personalizado');
  if (b.colorMode) parts.push('• Color y sombreado del texto');
  if (Array.isArray(b.modes) && b.modes.length) parts.push(`• ${b.modes.length} modo(s): ${b.modes.map(m => m.name).join(', ')}`);
  $('import-summary').textContent = parts.join('\n');
  $('import-modal').classList.add('show');
}
function applyImport(b) {
  if (b.text != null) config.customText = b.text;
  if (b.colorMode) {
    config.colorMode = b.colorMode;
    if (b.textColor) config.textColor = b.textColor;
    if (typeof b.shadow === 'boolean') config.shadow = b.shadow;
  }
  if (Array.isArray(b.modes) && b.modes.length) {
    b.modes.forEach(mm => {
      if (!mm || !mm.name) return;
      modes.push({ id: slug(mm.name) + '_' + uid(), name: String(mm.name), steps: (mm.steps || []).map(s => String(s).trim()).filter(Boolean) });
    });
  }
  saveConfig(); saveModes();
  renderSettings(); renderWheel(); updateLiveOverlay(); updateCompass();
  toast('Configuración importada');
}

function bindShare() {
  $('btn-share-back').addEventListener('click', () => showScreen('settings'));
  $('btn-share-send').addEventListener('click', doShareSend);
  $('btn-share-copy').addEventListener('click', doShareCopy);
  $('btn-share-file').addEventListener('click', doShareFile);
  $('share-import-file').addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { try { openImportModal(decodeMaybe(rd.result)); } catch (err) { toast('Archivo no válido'); } };
    rd.readAsText(f);
    e.target.value = '';
  });
  $('btn-import-confirm').addEventListener('click', () => { if (pendingImport) { applyImport(pendingImport); pendingImport = null; } $('import-modal').classList.remove('show'); });
  $('btn-import-cancel').addEventListener('click', () => { pendingImport = null; $('import-modal').classList.remove('show'); });
}
function decodeMaybe(text) {
  const s = text.trim();
  if (s[0] === '{') return JSON.parse(s);          // archivo JSON
  return decodeBundle(s.replace(/^.*#cfg=/, ''));  // por si pegan un enlace
}

/* Detecta enlace entrante #cfg= al abrir */
function checkIncomingConfig() {
  const m = location.hash.match(/[#&]cfg=([^&]+)/);
  if (!m) return;
  let b = null;
  try { b = decodeBundle(m[1]); } catch (e) { b = null; }
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  if (b) openImportModal(b);
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
  $('btn-macro').addEventListener('click', macroCapture);
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
  renderWheel();
  updateLiveOverlay();
  updateCompass();
  tickClock();
  startGeo();
  ensureHeading();
  applyOrientation();
  registerSW();
  maybeShowInstall();
  checkIncomingConfig();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isScreen('camera')) { ensureCamera(); startBrightnessMonitor(); }
    else { stopBrightnessMonitor(); }
  });

  showScreen('camera');
}

document.addEventListener('DOMContentLoaded', init);
