# GeoCam 📸

Cámara web que **graba sobre la foto** tu texto personalizado, la fecha y hora completas y las **coordenadas GPS reales** (buscables en cualquier mapa), con el mismo estilo de las fotos de terreno.

Funciona como **PWA**: se instala en el teléfono como una app y arranca al instante. Todo se guarda **solo en tu dispositivo** (no hay cuentas ni servidor): cada instalación es un usuario independiente y tu configuración no se mezcla con la de nadie.

---

## 🚀 Publicar en GitHub Pages

1. Crea un repositorio nuevo en GitHub (por ejemplo `geocam`).
2. Sube **todos** estos archivos a la raíz del repo (no dentro de una carpeta):
   - `index.html`, `app.js`, `styles.css`, `manifest.json`, `sw.js`, `README.md` y la carpeta `icons/`.
3. En el repo ve a **Settings → Pages**.
4. En **Source** elige **Deploy from a branch**, rama `main` y carpeta `/ (root)`. Guarda.
5. Espera ~1 minuto. GitHub te dará una dirección como:
   `https://TU-USUARIO.github.io/geocam/`
6. Abre esa dirección **desde el teléfono**.

> ⚠️ **Debe ser `https://`** (GitHub Pages ya lo es). La cámara y el GPS **no funcionan** por `http://` ni abriendo el archivo directamente.

Para subir archivos desde el iPhone sin computador puedes usar la propia web de GitHub (botón **Add file → Upload files**) o la app de GitHub.

---

## 📲 Instalar la app en el teléfono

**iPhone (Safari):**
1. Abre la dirección de GitHub Pages en **Safari**.
2. Toca el botón **Compartir** (cuadrado con flecha).
3. **Añadir a pantalla de inicio** → **Añadir**.
4. Ábrela desde el ícono nuevo: se ve a pantalla completa, como una app.

**Android (Chrome):**
1. Abre la dirección en **Chrome**.
2. Menú **⋮ → Instalar app** (o "Añadir a pantalla de inicio").

La primera vez pedirá permiso de **cámara** y **ubicación**: acepta ambos.

---

## ⚙️ Cómo se usa

- **Botón blanco grande:** captura la foto (con el texto + coords + fecha ya grabados).
- **Rueda inferior:** desliza para cambiar de **modo** (igual que en la cámara del iPhone).
- **Recordatorio sobre el obturador:** te dice qué imagen tomar en cada paso. La **✕** salta el paso (si te falta una imagen) y el **↻** reinicia la secuencia.
- **Riel derecho:** linterna 🔦, macro 🌼 y cambio de lente (gran angular) cuando el equipo lo permite.
- **Tocar la pantalla:** intenta enfocar ese punto.
- **"Editar" (arriba, centro):** carga una imagen de la galería y añádele el texto, coordenadas (a mano o eligiendo el punto en un **mapa**) y la fecha; arrastra el texto donde quieras y guarda.
- **⚙️ Configuración:** tu texto, orientación (automática / vertical fija / horizontal fija), color, altitud, rumbo y tus **modos** propios (un paso por línea).

---

## ✅ Qué funciona en cada teléfono

La app pide al navegador todo lo posible. Algunas funciones dependen del sistema y **no las permite el navegador del iPhone** (son límites de Apple en webs, no errores de la app):

| Función | Android (Chrome) | iPhone (Safari / web) |
|---|---|---|
| Texto + fecha + coordenadas sobre la foto | ✅ | ✅ |
| Coordenadas reales (buscables en mapa) | ✅ | ✅ |
| Captura de foto | ✅ | ✅ |
| Detección de poca luz (aviso) | ✅ | ✅ |
| Editor de galería + mapa | ✅ | ✅ |
| Modos y recordatorios | ✅ | ✅ |
| **Linterna al capturar** | ✅ | ❌ (no permitido en web) |
| **Guardar directo en la galería** | ✅ (descarga directa) | ⚠️ se abre "Compartir" → *Guardar imagen* (un toque extra) |
| **Enfoque al tocar** | ✅ (si el equipo lo soporta) | ⚠️ visual; suele no cambiar el foco real |
| **Elegir gran angular** | ✅ (si el equipo lo expone) | ⚠️ poco fiable |
| **Bloquear orientación** | ✅ (instalada) | ❌ (no permitido en web) |

En el iPhone, las fotos se guardan a través de la hoja de **Compartir** (tocando **Guardar imagen** van a Fotos). Para tener **linterna**, **guardado directo** y **bloqueo de orientación** completos en iPhone haría falta una app nativa (envoltura), no una web.

---

## 🔒 Privacidad

- No hay servidor ni cuentas. Tu **texto, modos y ajustes** se guardan con `localStorage`, solo en tu teléfono.
- Las **fotos** nunca se suben: se quedan en tu dispositivo.
- El **mapa** del editor usa OpenStreetMap (se carga al abrirlo); requiere conexión solo en ese momento.

---

Hecho para uso en terreno. Si quieres ajustar el formato del texto, los modos por defecto o el estilo, edita `app.js` (constantes `DEFAULT_CONFIG` y `DEFAULT_MODES` al inicio).
