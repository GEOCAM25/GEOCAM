# GeoCam 📸

Cámara web que **graba sobre la foto** tu texto, la fecha y hora completas y las **coordenadas GPS reales** (buscables en cualquier mapa). Funciona como **PWA** instalable; en **Android** se puede empaquetar como **APK** (ver abajo). En iPhone se usa la misma dirección como app.

> ✍️ **Vacía de fábrica.** El **texto** y los **modos** **no vienen predeterminados**: cada persona escribe lo suyo en *Configuración*.

> 🔒 **Aislamiento total.** No hay servidor ni cuentas. Todo se guarda **solo en este dispositivo** (`localStorage`). **Nada se traspasa solo** entre teléfonos. Tu compañero **no verá** tu configuración salvo que se la **compartas a propósito** y él **confirme** importarla.

---

## Qué hace (resumen)

- **Sobre la foto:** texto + coordenadas + fecha/hora. Si activas **dirección**, también la calle exacta (orden: texto → dirección → coordenadas → fecha).
- **Arriba (solo visual, nunca en la foto):** el **nombre de la calle** y una **brújula en franja** que indica hacia dónde apuntas: Norte / Sur / Oriente / Poniente.
- **Macro** (al lado del obturador): interruptor que **solo enfoca de cerca** (no dispara). Tú tomas la foto y se apaga solo. Queda **amarillo** cuando está activo.
- **Linterna**, **flash al capturar**, **modo nocturno** (linterna automática con poca luz) y **cambio de cámara** (principal/gran angular/frontal). Abre siempre en la principal.
- **Relación de aspecto** ajustable (completa, 3:4, 9:16, 1:1, 4:3, 16:9).
- **Color** fijo (amarillo) o **automático según el fondo**, con **sombreado** opcional.
- **Modos**: listas de pasos sobre el obturador, con **✕** para saltar y **↻** para reiniciar.
- **Aviso "IMAGEN MOVIDA"** si la foto sale movida.
- **Sonido** opcional (silencio por defecto).
- **Compartir/importar** tu configuración por enlace o archivo.

---

## 📲 Convertir en app / APK

**Android, sin compilar:** abre la dirección en Chrome y toca **Instalar** → queda como app real (WebAPK).

**APK como archivo** (para repartir o subir a Play Store): usa **PWABuilder** o **Bubblewrap**.
👉 Guía paso a paso en **[`twa/README-APK.md`](twa/README-APK.md)** (incluye cómo quitar la barra del navegador con `assetlinks.json` y una plantilla en `twa/`).

> El APK por PWABuilder es una **TWA** (abre la web por dentro). **No** envía fotos solas a WhatsApp; usa el flujo de Compartir. El envío automático a un grupo solo existe con app nativa Kotlin o **WhatsApp Cloud API + servidor**.
>
> En iPhone **no** se hace APK: se instala como PWA (**Compartir → Añadir a pantalla de inicio**).

---

## 🚀 Publicar en GitHub Pages

1. Repo nuevo. Sube **todo** a la raíz: `index.html`, `app.js`, `styles.css`, `manifest.json`, `sw.js`, la carpeta `icons/` y (opcional) la carpeta `twa/`.
2. **Settings → Pages → Deploy from a branch → main → /(root)**.
3. Abre `https://TU-USUARIO.github.io/TU-REPO/` desde el teléfono (debe ser **https**).

> ¿El ícono no aparece al "Añadir a inicio"? Verifica que `…/icons/icon-180.png` abra en el navegador. **GitHub distingue mayúsculas**: si tu repo es `GEOCAM`, la ruta es `…/GEOCAM/icons/...`.

---

## 🔁 Compartir configuración

*Configuración → Compartir* → marca qué incluir (texto, color/sombra, modos) → **Compartir enlace** o **Exportar archivo**. La otra persona abre el enlace en GeoCam, revisa y toca **Importar**. Los modos se **suman** (no borra nada).

---

## 📦 WhatsApp por modo

Cada modo puede tener su **chat/grupo** y un **mensaje** propios. En *Configuración → Envío por WhatsApp* eliges:
- **Cada foto al tomarla**, o
- **Todas juntas al completar el modo** (el mensaje incluye la **hora de la 1ª y la última imagen**, útil para saber el horario de una falla).

En todos los casos se abre el menú de **Compartir** con la(s) imagen(es): eliges WhatsApp y el chat. WhatsApp no permite que una web (ni una TWA) las envíe solas a un chat fijo.

---

## ✅ Android vs iPhone

| Función | Android | iPhone (web) |
|---|---|---|
| Texto + fecha + coordenadas + dirección | ✅ | ✅ |
| Calle arriba + brújula | ✅ | ✅ (pide permiso de movimiento) |
| Relación de aspecto · Color auto · Modos | ✅ | ✅ |
| Macro (solo enfoque) | ✅ | ⚠️ limitado por el navegador |
| Cambio de cámara | ✅ | ✅ |
| **App / APK** | ✅ Instalar o PWABuilder | ❌ APK no existe en iOS; va como PWA |
| **Flash / linterna / modo nocturno** | ✅ | ❌ no permitido en web |
| **Guardar directo en galería** | ✅ | ⚠️ "Compartir" → Guardar imagen |
| **WhatsApp al capturar** | ✅ (eliges chat y envías) | ⚠️ igual, vía Compartir |

### Lo que una web/TWA **no puede** (solo app nativa o Cloud API + servidor)
- Enviar fotos a un chat fijo de WhatsApp **solo y sin confirmar**.
- Capturar **en segundo plano** (app cerrada). Al volver, la cámara se reactiva sola.

---

## 🎛️ Ajustes en `app.js`
- `DEFAULT_CONFIG` / `DEFAULT_MODES` (vacíos a propósito).
- `BLUR_THRESHOLD`: sensibilidad de "IMAGEN MOVIDA".
- La dirección usa OpenStreetMap (Nominatim); requiere conexión.

Hecho para uso en terreno.
