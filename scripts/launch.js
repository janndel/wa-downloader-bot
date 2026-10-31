#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  unlinkSync,
  openSync,
  closeSync,
  statSync,
  mkdirSync,
  chmodSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const INDEX_PATH = path.join(ROOT, 'index.js')
const LOG_PATH = path.join(ROOT, 'bot.log')
const LOCK_PATH = path.join(ROOT, '.bot.lock')
const CONFIG_PATH = path.join(ROOT, 'config.json')
const PAIRING_PATH = path.join(ROOT, 'pairing-code.txt')
const AUTH_DIR = path.join(ROOT, 'auth')
const CREDS_PATH = path.join(AUTH_DIR, 'creds.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fail(msg) {
  console.error(`\n❌ ${msg}\n`)
  process.exit(1)
}

function hasCommand(cmd) {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0
}

function run(cmd, args, { cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { cwd, stdio: 'inherit', env: process.env })
    } catch (e) {
      resolve({ ok: false, error: e })
      return
    }
    child.on('error', (e) => resolve({ ok: false, error: e }))
    child.on('close', (code) => resolve({ ok: code === 0, code }))
  })
}

function isTermux() {
  return Boolean(process.env.PREFIX?.includes('com.termux')) || existsSync('/data/data/com.termux/files/usr/bin/pkg')
}

async function runRoot(cmd, args) {
  if (process.getuid?.() === 0) return run(cmd, args)
  if (hasCommand('sudo')) return run('sudo', [cmd, ...args])
  return { ok: false }
}

async function installSystem(pkgs) {
  if (isTermux() && hasCommand('pkg')) {
    return (await run('pkg', ['install', '-y', ...pkgs])).ok
  }
  if (hasCommand('apt-get')) {
    let r = await runRoot('apt-get', ['install', '-y', ...pkgs])
    if (!r.ok) {
      await runRoot('apt-get', ['update'])
      r = await runRoot('apt-get', ['install', '-y', ...pkgs])
    }
    return r.ok
  }
  if (hasCommand('dnf')) return (await runRoot('dnf', ['install', '-y', ...pkgs])).ok
  if (hasCommand('pacman')) return (await runRoot('pacman', ['-S', '--noconfirm', ...pkgs])).ok
  if (hasCommand('brew')) return (await run('brew', ['install', ...pkgs])).ok
  return false
}

async function ensureNodeVersion() {
  const major = Number(String(process.versions.node).split('.')[0])
  if (major >= 20) return
  console.error(`\n❌ Node.js ${process.versions.node} es demasiado antiguo (se requiere 20 o superior).`)
  if (isTermux() && hasCommand('pkg')) {
    console.log('⬆️  Actualizando Node.js con pkg...')
    const r = await run('pkg', ['install', '-y', 'nodejs'])
    if (r.ok) {
      console.log('\n✅ Node.js actualizado. Vuelve a ejecutar: npm start\n')
      process.exit(0)
    }
  }
  fail('Actualiza Node.js a la versión 20 o superior y vuelve a intentarlo.')
}

function npmDepsMissing() {
  const nm = path.join(ROOT, 'node_modules')
  const baileys = path.join(nm, '@whiskeysockets', 'baileys')
  if (!existsSync(baileys)) return true
  const stamp = path.join(nm, '.package-lock.json')
  try {
    return statSync(path.join(ROOT, 'package-lock.json')).mtimeMs > statSync(stamp).mtimeMs
  } catch {
    return false
  }
}

async function ensureNpmDeps() {
  if (!npmDepsMissing()) return
  console.log('\n📦 Instalando dependencias de Node (npm install)...')
  const r = await run('npm', ['install', '--no-audit', '--no-fund'])
  if (!r.ok) fail('No se pudieron instalar las dependencias de Node. Revisa tu conexión y ejecuta: npm install')
  console.log('✅ Dependencias de Node listas.')
}

async function ensureFfmpeg() {
  if (hasCommand('ffmpeg')) return
  console.log('\n⬇️  ffmpeg no está instalado. Instalando automáticamente...')
  const ok = await installSystem(['ffmpeg'])
  if (ok && hasCommand('ffmpeg')) {
    console.log('✅ ffmpeg instalado.')
    return
  }
  fail(
    'No se pudo instalar ffmpeg automáticamente.\n' +
      '   Termux: pkg install ffmpeg\n' +
      '   Debian/Ubuntu: sudo apt install ffmpeg\n' +
      '   Fedora: sudo dnf install ffmpeg\n' +
      '   Arch: sudo pacman -S ffmpeg'
  )
}

async function ensureYtDlp() {
  if (hasCommand('yt-dlp')) return
  console.log('\n⬇️  yt-dlp no está instalado. Instalando automáticamente...')

  if (isTermux()) {
    if (!hasCommand('python3')) await run('pkg', ['install', '-y', 'python'])
    const r = await run('pip3', ['install', '--upgrade', 'yt-dlp'])
    if (r.ok && hasCommand('yt-dlp')) {
      console.log('✅ yt-dlp instalado.')
      return
    }
  } else {
    if (await installSystem(['yt-dlp'])) {
      if (hasCommand('yt-dlp')) {
        console.log('✅ yt-dlp instalado.')
        return
      }
    }
    let r = await run('python3', ['-m', 'pip', 'install', '--user', '--upgrade', 'yt-dlp'])
    if (!r.ok) {
      r = await run('python3', [
        '-m',
        'pip',
        'install',
        '--user',
        '--break-system-packages',
        '--upgrade',
        'yt-dlp',
      ])
    }
    const userBin = path.join(process.env.HOME || '', '.local', 'bin')
    if (existsSync(path.join(userBin, 'yt-dlp'))) {
      process.env.PATH = `${userBin}:${process.env.PATH}`
    }
    if (hasCommand('yt-dlp')) {
      console.log('✅ yt-dlp instalado.')
      return
    }
  }

  console.log('   Descargando yt-dlp a ./bin ...')
  const binDir = path.join(ROOT, 'bin')
  mkdirSync(binDir, { recursive: true })
  const target = path.join(binDir, 'yt-dlp')
  const asset = hasCommand('python3')
    ? 'yt-dlp'
    : process.arch === 'x64'
      ? 'yt-dlp_linux'
      : process.arch === 'arm64'
        ? 'yt-dlp_linux_aarch64'
        : process.arch === 'arm'
          ? 'yt-dlp_linux_armv7l'
          : 'yt-dlp'
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`
  let r = await run('curl', ['-L', '--fail', '-o', target, url])
  if (!r.ok) r = await run('wget', ['-O', target, url])
  if (r.ok) {
    chmodSync(target, 0o755)
    process.env.PATH = `${binDir}:${process.env.PATH}`
    if (hasCommand('yt-dlp')) {
      console.log('✅ yt-dlp instalado en ./bin.')
      return
    }
  }

  fail('No se pudo instalar yt-dlp. Instálalo manualmente: pip install -U yt-dlp')
}

function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function isRegistered() {
  try {
    return JSON.parse(readFileSync(CREDS_PATH, 'utf8')).registered === true
  } catch {
    return false
  }
}

function readLock() {
  try {
    return JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
  } catch {
    return null
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function runningPid() {
  const lock = readLock()
  if (!lock?.pid || !pidAlive(lock.pid)) return null
  try {
    const cmd = readFileSync(`/proc/${lock.pid}/cmdline`, 'utf8').replace(/\0/g, ' ')
    if (!/index\.js/.test(cmd)) return null
  } catch {}
  return lock.pid
}

function readPairing() {
  try {
    return JSON.parse(readFileSync(PAIRING_PATH, 'utf8'))
  } catch {
    return null
  }
}

async function waitFor(fn, timeoutMs, intervalMs = 250) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const value = fn()
    if (value) return value
    await sleep(intervalMs)
  }
  return null
}

function wakeLock() {
  if (hasCommand('termux-wake-lock')) spawnSync('termux-wake-lock', [], { stdio: 'ignore' })
}

function wakeUnlock() {
  if (hasCommand('termux-wake-unlock')) spawnSync('termux-wake-unlock', [], { stdio: 'ignore' })
}

function printPairingBanner(phone, code) {
  const raw = String(code).replace(/[^A-Za-z0-9]/g, '')
  const g = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw
  const line = '═'.repeat(48)
  console.log(`\n${line}`)
  console.log('   🔗  VINCULAR BOT CON WHATSAPP')
  console.log(line)
  console.log(`   📱 Número: +${phone}`)
  console.log(`   🔑 CÓDIGO:  ${g}`)
  console.log('')
  console.log('   En tu celular (NO esperes notificación):')
  console.log('   1. Abre WhatsApp → ⋮ (tres puntos) → Ajustes')
  console.log('   2. Dispositivos vinculados → Vincular dispositivo')
  console.log('   3. Confirma tu huella/PIN')
  console.log('   4. Toca "Vincular con el número de teléfono"')
  console.log('      (abajo o en ⋮ de la cámara, según tu versión)')
  console.log('   5. Si te lo pide, escribe tu número y luego')
  console.log(`      ingresa el código:  ${g}`)
  console.log('')
  console.log('   ⏱  El código vence en ~1-2 minutos.')
  console.log('   🔌 El bot seguirá encendido en segundo plano.')
  console.log(`${line}\n`)
}

async function setup() {
  await ensureNodeVersion()
  await ensureNpmDeps()
  const r = await run(process.execPath, [INDEX_PATH, '--setup'])
  if (!r.ok) fail('La configuración inicial no se completó.')
}

async function start() {
  await ensureNodeVersion()

  const already = runningPid()
  if (already) {
    console.log(`\n✅ El bot ya está corriendo en segundo plano (PID ${already}).`)
    const pairing = readPairing()
    if (!isRegistered() && pairing?.code) printPairingBanner(pairing.phone, pairing.code)
    else console.log('   Comandos: npm run status | npm run logs | npm stop\n')
    return
  }

  await ensureNpmDeps()
  await ensureFfmpeg()
  await ensureYtDlp()

  try {
    unlinkSync(LOCK_PATH)
  } catch {}

  const registered = isRegistered()
  if (!registered) {
    try {
      unlinkSync(PAIRING_PATH)
    } catch {}
  }
  if (!registered && !existsSync(CREDS_PATH)) {
    console.log('\n🔧 Primera ejecución: configurando el bot...')
    const r = await run(process.execPath, [INDEX_PATH, '--setup'])
    if (!r.ok) fail('La configuración inicial no se completó.')
  } else if (!readConfig().phoneNumber) {
    const r = await run(process.execPath, [INDEX_PATH, '--setup'])
    if (!r.ok) fail('La configuración inicial no se completó.')
  }

  const logFd = openSync(LOG_PATH, 'a')
  const child = spawn(process.execPath, [INDEX_PATH], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  })
  closeSync(logFd)
  child.unref()
  wakeLock()

  const pid = await waitFor(() => runningPid(), 15000)
  if (!pid) {
    console.error('\n❌ El bot no arrancó. Revisa el error con: npm run logs\n')
    process.exit(1)
  }
  await sleep(1000)
  if (!pidAlive(pid)) {
    console.error('\n❌ El bot se cerró al iniciar. Revisa el error con: npm run logs\n')
    process.exit(1)
  }

  console.log(`\n✅ Bot iniciado en segundo plano (PID ${pid}).`)
  if (registered) {
    console.log('📱 La sesión ya está vinculada. Puedes cerrar esta terminal.\n')
    return
  }

  console.log('⏳ Esperando el código de vinculación...')
  const pairing = await waitFor(() => readPairing(), 30000)
  if (pairing?.code) {
    printPairingBanner(pairing.phone, pairing.code)
    console.log('💡 Si el código vence, ejecuta: npm run code\n')
  } else {
    console.log('⚠️  Aún no hay código. Revisa el progreso con: npm run logs')
    console.log('💡 Para pedir un código nuevo: npm run code\n')
  }
  console.log('📌 El bot sigue en segundo plano. Comandos: npm run status | npm run logs | npm stop\n')
}

async function stop() {
  const pid = runningPid()
  if (!pid) {
    console.log('ℹ️  El bot no está corriendo.')
    try {
      unlinkSync(LOCK_PATH)
    } catch {}
    try {
      unlinkSync(PAIRING_PATH)
    } catch {}
    wakeUnlock()
    return
  }
  console.log(`🛑 Deteniendo el bot (PID ${pid})...`)
  try {
    process.kill(pid, 'SIGTERM')
  } catch {}
  const stopped = await waitFor(() => !pidAlive(pid), 8000)
  if (!stopped) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  try {
    unlinkSync(LOCK_PATH)
  } catch {}
  try {
    unlinkSync(PAIRING_PATH)
  } catch {}
  wakeUnlock()
  console.log('✅ Bot detenido.')
}

function status() {
  const pid = runningPid()
  const cfg = readConfig()
  const pairing = readPairing()
  console.log('\n🤖 WA Downloader Bot')
  console.log(`   Estado:    ${pid ? `corriendo (PID ${pid})` : 'detenido'}`)
  console.log(`   Número:    ${cfg.phoneNumber ? `+${cfg.phoneNumber}` : '(sin configurar)'}`)
  console.log(`   Vinculado: ${isRegistered() ? 'sí' : 'no'}`)
  if (!isRegistered() && pairing?.code) console.log(`   Código:    ${pairing.code}`)
  console.log(`   Log:       ${LOG_PATH}\n`)
}

async function code() {
  const pid = runningPid()
  if (!pid) fail('El bot no está corriendo. Inícialo con: npm start')
  if (isRegistered()) {
    console.log('✅ El bot ya está vinculado a WhatsApp.')
    return
  }
  const before = readPairing()?.createdAt || ''
  console.log('🔄 Solicitando un código nuevo...')
  try {
    process.kill(pid, 'SIGUSR1')
  } catch (e) {
    fail(`No se pudo solicitar el código: ${e?.message || e}`)
  }
  const pairing = await waitFor(() => {
    const p = readPairing()
    return p && p.createdAt !== before ? p : null
  }, 20000)
  if (pairing?.code) {
    printPairingBanner(pairing.phone, pairing.code)
  } else {
    console.log('⚠️  No se generó un código nuevo. Revisa: npm run logs')
  }
}

async function logs() {
  if (!existsSync(LOG_PATH)) {
    console.log('ℹ️  Todavía no hay log. Inicia el bot con: npm start')
    return
  }
  if (hasCommand('tail')) {
    const child = spawn('tail', ['-n', '100', '-f', LOG_PATH], { stdio: 'inherit' })
    child.on('close', (c) => process.exit(c || 0))
    return
  }
  const lines = readFileSync(LOG_PATH, 'utf8').split('\n')
  console.log(lines.slice(-100).join('\n'))
}

const commands = { start, stop, status, code, logs, setup }
const cmd = (process.argv[2] || 'start').toLowerCase()

if (!commands[cmd]) {
  console.log('Uso: node scripts/launch.js [start|stop|status|code|logs|setup]')
  process.exit(1)
}

Promise.resolve(commands[cmd]()).catch((e) => {
  console.error('Error:', e?.message || e)
  process.exit(1)
})
