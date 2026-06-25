# GeoCam 📸

Cámara web que **graba sobre la foto** tu texto, la fecha y hora completas y las **coordenadas GPS reales** (buscables en cualquier mapa), con el estilo de las fotos de terreno.

Funciona como **PWA** instalable. Pensada para usarse sobre todo en **Android**.

> ✍️ **Vacía de fábrica.** El **texto personalizado** y los **modos** **no vienen predeterminados**: cada persona escribe su texto y crea sus propios modos en *Configuración*. Así nada queda fijado por defecto.

> 🔒 **Privacidad y aislamiento.** No hay servidor ni cuentas. Todo se guarda **solo en este dispositivo** (`localStorage`). Cada instalación es independiente: **nada se traspasa solo** entre teléfonos. Tu compañero **no verá** tu configuración salvo que se la **compartas a propósito** y él **confirme** importarla.

---

## 📲 Instalar / convertirla en app (APK)

Una PWA no es un archivo `.apk` en sí, pero **sí se convierte en una app de Android**. Tienes dos caminos:

### A) La forma fácil, sin computador (recomendada)
En **Android (Chrome)**: abre la dirección de la app y toca **Instalar** (en el banner que aparece) o menú **⋮ → Instalar app**.
➡️ Android crea una **app real** (un *WebAPK* firmado por Google) con el ícono en el cajón de aplicaciones. Para la mayoría de los usos, **eso es el "APK"**: se abre a pantalla completa y sin barra de navegador, como cualquier app. No requiere compilar nada.

### B) Generar un archivo `.apk` / `.aab` de verdad (para repartir o subir a Play Store)
Usa **https://www.pwabuilder.com** (funciona desde el navegador, incluso en el teléfono):
1. Publica la app en GitHub Pages (ver más abajo) y copia su dirección `https://...`.
2. Pégala en PWABuilder → **Package For Stores → Android**.
3. Descarga el paquete. Te entrega el `.apk`/`.aab` **firmado** y un archivo **`assetlinks.json`**.
4. Sube ese `assetlinks.json` a tu sitio en `/.well-known/assetlinks.json` para que la app abra **sin la barra de direcciones**.

> 📌 **Solo Android.** No se puede generar un APK para iPhone (iOS usa otro formato y exige Mac/Xcode/App Store). En iPhone la app se instala con **Compartir → Añadir a pantalla de inicio**.
>
> Si publicas en una *project page* (`usuario.github.io/geocam/`), el `assetlinks.json` debe ir en la raíz del dominio (`usuario.github.io/.well-known/`). Si no controlas esa raíz, la app igual funciona pero puede mostrar brevemente la barra de direcciones. Un dominio propio o una *user page* lo evita.

---

## 🚀 Publicar en GitHub Pages

1. Crea un repositorio nuevo (por ejemplo `geocam`).
2. Sube **todos** estos archivos a la raíz del repo (no dentro de una carpeta):
   `index.html`, `app.js`, `styles.css`, `manifest.json`, `sw.js`, `README.md` y la carpeta `icons/`.
3. **Settings → Pages → Source: Deploy from a branch**, rama `main`, carpeta `/ (root)`.
4. Espera ~1 minuto. Tu dirección será como `https://TU-USUARIO.github.io/geocam/`.
5. Ábrela **desde el teléfono**.

> ⚠️ **Debe ser `https://`** (GitHub Pages ya lo es). La cámara y el GPS **no funcionan** por `http://` ni abriendo el archivo directamente.

Al actualizar archivos, la app se refresca sola (el Service Worker sube de versión).

---

## ⚙️ Cómo se usa

- **Botón blanco:** captura (con texto + coords + fecha grabados).
- **Macro 🌼 (riel derecho):** enfoca y **captura objetos cercanos**.
- **Linterna 🔦** y **cambio de lente / gran angular** (cuando el equipo lo permite).
- **Rueda inferior:** desliza para cambiar de **modo** (los creas tú). Sobre el obturador aparece el paso a tomar; **✕** salta el paso y **↻** reinicia.
- **Tocar la pantalla:** intenta enfocar ese punto.
- **Brújula arriba:** Norte / Sur / Oriente / Poniente. Solo referencia; **nunca** se graba en la foto.
- **Ícono de imagen (arriba):** editor de galería — carga una foto y añádele texto, coordenadas (a mano o en **mapa**) y fecha; arrastra el texto y guarda.
- **⚙️ Configuración:** tu **texto**, orientación, color (fijo o **automático según el fondo**), sombreado, brújula, sonido, flash, linterna al abrir, WhatsApp y tus **modos**.

---

## 🔁 Compartir configuración con otra persona

*Configuración → Compartir* → marca qué incluir y elige modos → **Compartir enlace** (por WhatsApp) o **Exportar archivo**. La otra persona abre el enlace en GeoCam, revisa el resumen y toca **Importar**. Los modos se **suman** a los suyos; nada ocurre sin su confirmación.

---

## ✅ Qué funciona en cada teléfono

| Función | Android (Chrome) | iPhone (Safari / web) |
|---|---|---|
| Texto + fecha + coordenadas sobre la foto | ✅ | ✅ |
| Color automático según el fondo | ✅ | ✅ |
| Macro (objetos cercanos) | ✅ | ⚠️ limitado por el navegador |
| Aviso "IMAGEN MOVIDA" | ✅ | ✅ |
| Brújula en pantalla | ✅ | ✅ (pide permiso de movimiento) |
| Compartir/importar configuración | ✅ | ✅ |
| Editor de galería + mapa · Modos · Sonido | ✅ | ✅ |
| **Convertir en app/APK** | ✅ (Instalar = WebAPK, o PWABuilder) | ❌ APK no existe en iOS; se instala como PWA |
| **Flash / linterna al capturar** | ✅ | ❌ no permitido en web |
| **Linterna encendida al abrir** | ✅ | ❌ no permitido en web |
| **Guardar directo en la galería** | ✅ descarga directa | ⚠️ "Compartir" → *Guardar imagen* |
| **WhatsApp al capturar** | ✅ abre WhatsApp con la foto (eliges chat y envías) | ⚠️ igual, vía Compartir |
| **No permitir foto al revés** | ✅ | ⚠️ se bloquea la captura al revés (el bloqueo del sistema no está disponible) |

### Lo que **una web no puede** (solo con app nativa)
- **Enviar la foto por WhatsApp 100% automática y silenciosa** a un grupo fijo: WhatsApp/el navegador no lo permiten. Lo máximo es **abrir WhatsApp con la imagen lista** y tocar enviar.
- **Capturar en segundo plano** (app cerrada o pantalla bloqueada): el navegador suspende la cámara; al volver se reactiva sola.

---

## 🎛️ Ajustes en `app.js`
- `DEFAULT_CONFIG` / `DEFAULT_MODES`: valores de fábrica (texto y modos vienen vacíos a propósito).
- `BLUR_THRESHOLD`: sensibilidad del aviso "IMAGEN MOVIDA".

Hecho para uso en terreno.
