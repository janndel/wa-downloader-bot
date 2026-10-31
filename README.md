# WA Downloader Bot

Bot de WhatsApp que previsualiza y descarga **videos, fotos, GIF y audio** de Facebook, Instagram, X/Twitter, TikTok, YouTube, Reddit, Pinterest y otras plataformas, directo en el chat.

Usa vinculación por **código de 8 dígitos** (sin QR). En el primer arranque te pide tu número de WhatsApp, instala lo que falta y deja el bot corriendo en segundo plano automáticamente.

## Inicio rápido

```bash
git clone https://github.com/janndel/wa-downloader-bot.git
cd wa-downloader-bot
npm start
```

`npm start` hace todo esto por ti:

1. Instala las dependencias de Node (`npm install`).
2. Instala `ffmpeg` y `yt-dlp` si no están disponibles.
3. En el primer arranque, te pide tu número de WhatsApp.
4. Inicia el bot en segundo plano (sin dejar la terminal ocupada).
5. Te muestra el código de 8 dígitos para vincular WhatsApp.

Solo necesitas tener **Node.js 20 o superior** y **git** instalados.

## Primer arranque (configuración guiada)

1. Ejecuta `npm start`.
2. Escribe tu número de WhatsApp: solo dígitos, con código de país, sin `+`, espacios ni guiones. Ejemplo: `5491122334455`.
3. El bot arranca en segundo plano y muestra un código como `ABCD-1234`.
4. En tu celular: WhatsApp → `⋮` → **Ajustes** → **Dispositivos vinculados** → **Vincular dispositivo** → confirma tu huella/PIN → **Vincular con el número de teléfono**.
5. Escribe el código de 8 dígitos.

El código vence en 1–2 minutos. Si expira, ejecuta `npm run code` para pedir uno nuevo. Una vez vinculado, el bot queda funcionando en segundo plano y puedes cerrar la terminal.

## Instalación de requisitos

### Termux (Android)

```bash
pkg update -y
pkg install -y nodejs git
git clone https://github.com/janndel/wa-downloader-bot.git
cd wa-downloader-bot
npm start
```

`npm start` instala automáticamente `ffmpeg` y `yt-dlp`. También activa el wake lock de Termux para que Android no duerma el bot. Se recomienda desactivar la optimización de batería para Termux.

### Linux

```bash
# Debian / Ubuntu
sudo apt update
sudo apt install -y nodejs npm git

# Fedora
sudo dnf install -y nodejs npm git

# Arch
sudo pacman -S --noconfirm nodejs npm git
```

Luego:

```bash
git clone https://github.com/janndel/wa-downloader-bot.git
cd wa-downloader-bot
npm start
```

`npm start` intenta instalar `ffmpeg` y `yt-dlp` con `apt`, `dnf`, `pacman` o `brew`. Si no tiene permisos de administrador, intenta instalar `yt-dlp` con `pip` o descargarlo en `./bin`. Si `ffmpeg` no se puede instalar automáticamente, te muestra el comando exacto.

## Comandos

| Comando | Qué hace |
| --- | --- |
| `npm start` | Instala lo que falte, configura el número si es la primera vez y deja el bot en segundo plano. |
| `npm stop` | Detiene el bot. |
| `npm run status` | Muestra si está corriendo, el número, si está vinculado y el código pendiente. |
| `npm run code` | Pide un código de vinculación nuevo (si aún no está vinculado). |
| `npm run logs` | Muestra el log en vivo (`Ctrl+C` para salir). |
| `npm run setup` | Vuelve a pedir el número de WhatsApp y lo guarda. |
| `npm run start:fg` | Ejecuta el bot en primer plano (para depurar). |

## Uso del bot

| Acción | Cómo |
| --- | --- |
| Descargar un video/foto/GIF | Pega el enlace en el chat. El bot muestra la vista previa y responde `sí` para descargar. |
| Descargar música | `.m nombre de la canción` |
| Crear sticker | Responde a una foto/video/GIF con `.s` |
| Activar/desactivar en un chat | `.bot on` / `.bot off` (en grupos, solo administradores) |
| Añadir palabra clave | `.clave palabra` (o varias separadas por coma) |
| Ver palabras clave | `.claves` |
| Quitar palabra clave | `.clave borrar palabra` |
| Cambiar nombre/autor del sticker | `.packname Nuevo nombre` / `.author Tu nombre` |

## Configuración

El bot crea `config.json` automáticamente con tu número. Si quieres personalizarlo, copia el ejemplo:

```bash
cp config.example.json config.json
```

| Campo | Descripción |
| --- | --- |
| `phoneNumber` | Número de WhatsApp del bot (solo dígitos). Se pide en el primer arranque. |
| `stickerPackName` | Nombre del paquete de stickers. |
| `stickerAuthor` | Autor que aparece en los stickers. |
| `saveKeywords` | Lista de palabras clave para guardar medios. |
| `enabledChats` | Chats/grupos donde el bot está activo (se gestiona con `.bot on/off`). |

Para plataformas que requieren sesión (por ejemplo, contenido privado de Instagram), puedes colocar un archivo `cookies.txt` en la raíz del proyecto. Ese archivo **no** se sube al repo.

También puedes saltar la pregunta del número con la variable de entorno:

```bash
WA_PHONE=5491122334455 npm start
```

## Inicio automático al encender el teléfono (opcional, Termux)

Instala **Termux:Boot** desde F-Droid y crea el script:

```bash
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/wa-downloader.sh <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
cd ~/wa-downloader-bot
npm start
EOF
chmod +x ~/.termux/boot/wa-downloader.sh
```

## Seguridad

- La carpeta `auth/` contiene las credenciales de tu sesión de WhatsApp. **Nunca la compartas ni la subas a GitHub.**
- `config.json` contiene tu número de teléfono. Está excluido por `.gitignore`.
- No ejecutes dos instancias del bot a la vez: WhatsApp las desconecta con error `440`.
- Usa el bot solo con contenido que tengas derecho a descargar y respeta los términos de servicio de cada plataforma.

## Solución de problemas

- **Error 440 / el bot se desconecta**: hay otra instancia corriendo. Usa `npm run status` y `npm stop` antes de volver a iniciar.
- **Sesión cerrada / logout**: elimina la carpeta `auth/` y ejecuta `npm start` para vincular de nuevo.
- **No aparece el código**: ejecuta `npm run code` o revisa `npm run logs`.
- **Errores de descarga**: actualiza `yt-dlp` con `pip install -U yt-dlp`.
- **No pide el número**: ejecuta `npm run setup` o borra `config.json`.
- **Sin terminal interactiva**: define `WA_PHONE` antes de iniciar.
- **El bot se detiene al cerrar Termux**: activa el wake lock (`termux-wake-lock`), desactiva la optimización de batería para Termux y considera usar Termux:Boot.

## Licencia

ISC. Consulta el archivo `LICENSE`.
