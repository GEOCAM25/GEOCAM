# Generar el APK de GeoCam (Android)

GeoCam es una PWA. Para Android se **empaqueta** en un APK que carga la misma app publicada en GitHub Pages. El iPhone usa la misma dirección como PWA (no se hace APK para iPhone).

> ⚠️ Importante: un APK por PWABuilder o Bubblewrap es una **TWA** (la app abre la web por dentro). **No** habilita el envío automático de fotos a WhatsApp: sigue el mismo flujo de "Compartir". El envío 100% automático a un grupo solo se logra con app nativa Kotlin o con la **WhatsApp Cloud API + un servidor**.

---

## Opción A — PWABuilder (sin computador, recomendada)

1. Publica la app en GitHub Pages (queda en `https://geocam25.github.io/GEOCAM/`).
2. Entra a **https://www.pwabuilder.com**, pega esa dirección y toca **Start**.
3. **Package For Stores → Android → Generate Package**.
4. Deja el **Package ID** sugerido la primera vez (ej. `io.github.geocam25.geocam`), pon **App name** y **Launcher name** = `GeoCam`.
5. Descarga el ZIP. Trae:
   - `app-release-signed.apk` → para instalar/probar en Android.
   - `app-release-bundle.aab` → para subir a Google Play.
   - `assetlinks.json`, `signing.keystore`, `signing-key-info.txt`.
6. **Guarda el `signing.keystore`** (lo necesitas para futuras actualizaciones).
7. Instala el `.apk` en un Android (activa "instalar apps de orígenes desconocidos").

### Quitar la barra del navegador (Digital Asset Links)
Sube el `assetlinks.json` que te dio PWABuilder a:
`https://geocam25.github.io/.well-known/assetlinks.json`

Como tu app está en una *project page* (`/GEOCAM/`), ese archivo debe ir en la **raíz del dominio** (`geocam25.github.io/.well-known/`), no dentro de `/GEOCAM/`. Para eso necesitas un repo llamado **`geocam25.github.io`** y poner ahí la carpeta `.well-known`. Si no, la app funciona igual pero puede mostrar la barra de direcciones.

En este proyecto tienes una plantilla en `twa/assetlinks.example.json` (reemplaza el `package_name` y la **huella SHA256** que aparece en `signing-key-info.txt`).

---

## Opción B — Bubblewrap (con computador)

Requiere Node.js + JDK + Android SDK.

```bash
npm i -g @bubblewrap/cli
bubblewrap init --manifest https://geocam25.github.io/GEOCAM/manifest.json
bubblewrap build
```

Puedes partir del archivo `twa/twa-manifest.example.json` de este proyecto (ajusta `packageId`, rutas y versión). Al terminar, `bubblewrap` te entrega el `.apk`/`.aab`, el keystore y la huella SHA256 para el `assetlinks.json`.

---

## Actualizaciones automáticas (importante)

El APK es una **TWA**: por dentro carga la web publicada en GitHub Pages. Por eso **la app se actualiza sola** cada vez que publicas cambios en el repositorio; **no hace falta reinstalar el APK ni volver a firmarlo**.

Cómo funciona:
- El **service worker** (`sw.js`) sirve el código de la app con estrategia *red primero*: al abrir (y al volver a primer plano) busca la versión nueva y la descarga.
- Cuando hay una versión nueva lista, la app muestra un aviso **“Nueva versión disponible — toca para actualizar”**. Al tocarlo se aplica al instante. Si no, se aplica sola la próxima vez que se abre.
- Sin conexión, la app sigue funcionando con la última versión guardada en caché.
- La versión instalada se ve al final de **Configuración** (“GeoCam · versión …”).

Solo necesitas **generar un APK nuevo** si cambias el *envoltorio* (nombre, icono, `packageId`, permisos nativos). En ese caso sube `appVersionCode`/`appVersionName` en `twa-manifest.example.json`. Los cambios de la **web** (brújula, GPS, diseño, etc.) llegan solos.

---

## Subir a Google Play (opcional)
Solo si quieres publicarla en la tienda: necesitas una **cuenta de desarrollador de Google** (pago único de ~US$25) y subir el `.aab`. Para instalar el `.apk` directo o compartirlo, no pagas nada.
