#!/usr/bin/env node
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  downloadMediaMessage,
  Browsers,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs'
import { mkdir, readFile, writeFile, readdir, rm, stat, rename } from 'node:fs/promises'
import path from 'node:path'
import v8 from 'node:v8'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTH_DIR = path.join(__dirname, 'auth')
const DL_DIR = path.join(__dirname, 'downloads')
const CONFIG_PATH = path.join(__dirname, 'config.json')
const COOKIES_PATH = path.join(__dirname, 'cookies.txt')
const LOCK_PATH = path.join(__dirname, '.bot.lock')
const PAIRING_PATH = path.join(__dirname, 'pairing-code.txt')
const MEDIA_CACHE_PATH = path.join(__dirname, 'media-cache.bin')
const MEDIA_CACHE_MAX = 600

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const MAX_IMAGE_BYTES = 15 * 1024 * 1024
const MAX_VIDEO_BYTES = 64 * 1024 * 1024
const MAX_AUDIO_BYTES = 15 * 1024 * 1024
const MAX_DOC_BYTES = 700 * 1024 * 1024
const PENDING_TTL = 10 * 60 * 1000

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif'])
const KNOWN_HOSTS =
  /(?:facebook\.com|fb\.watch|fb\.me|fb\.com|instagram\.com|instagr\.am|twitter\.com|x\.com|t\.co|tiktok\.com|youtube\.com|youtu\.be|threads\.net|threads\.com|reddit\.com|redd\.it|pinterest\.|pin\.it|tumblr\.com|vimeo\.com|dailymotion\.com|soundcloud\.com|flickr\.com|imgur\.com|twitch\.tv|kick\.com|rumble\.com|streamable\.com|snapchat\.com)/i

const TYPE_EMOJI = { video: '🎥', foto: '📷', gif: '🎞' }
const TYPE_LABEL = { video: 'Video', foto: 'Foto', gif: 'GIF' }

const MIME = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  pdf: 'application/pdf',
}

const norm = (s) =>
  (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

const YES = new Set([
  'si', 's', 'yes', 'y', '1', 'descargar', 'descarga', 'descargalo',
  'descargarlo', 'bajar', 'bajalo', 'bajarlo', 'ok', 'dale', 'dalo',
  'obvio', 'sip', 'claro', 'por supuesto', 'va',
])
const NO = new Set(['no', 'n', '2', 'cancelar', 'cancela', 'cancel', 'nope', 'nah', 'nop'])

const pending = new Map()
const inFlight = new Set()
const seenIds = new Set()
const botSentIds = new Set()
let paused = false
let netTimer = null

async function checkInternet() {
  try {
    const r = await fetch('https://www.gstatic.com/generate_204', {
      signal: AbortSignal.timeout(5000),
    })
    return r.ok || r.status === 204
  } catch {
    return false
  }
}

function isNetworkClose(code, reason) {
  if (code === 428) return true
  return /ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|Connection Closed|timed out|network|socket hang up|getaddrinfo/i.test(
    String(reason)
  )
}

function waitForInternet() {
  if (netTimer) return
  paused = true
  console.log('📴 Sin internet. Bot en pausa; se reactivará solo cuando vuelva la conexión.')
  netTimer = setInterval(async () => {
    if (await checkInternet()) {
      clearInterval(netTimer)
      netTimer = null
      paused = false
      console.log('🌐 Internet de vuelta. Reconectando…')
      startBot().catch((e) => {
        console.error('Error al reconectar:', e?.message || e)
      })
    }
  }, 5000)
}

function capSet(s, max = 2500) {
  if (s.size > max) {
    const arr = [...s]
    s.clear()
    for (const x of arr.slice(-Math.floor(max / 2))) s.add(x)
  }
}

function fmtBytes(bytes) {
  if (bytes == null || !isFinite(bytes)) return 'no disponible'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let i = -1
  let x = bytes
  do {
    x /= 1024
    i++
  } while (x >= 1024 && i < units.length - 1)
  const dec = x >= 100 ? 0 : x >= 10 ? 1 : 2
  return `${x.toFixed(dec)} ${units[i]}`
}

function fmtDur(sec) {
  if (sec == null || isNaN(sec)) return '—'
  sec = Math.round(Number(sec))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const p = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`
}

function cleanErr(m) {
  return String(m || 'error desconocido')
    .replace(/https?:\/\/\S+/g, '[enlace]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220)
}

function safeName(title, ext) {
  const base = String(title || 'descarga')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'descarga'
  return `${base}.${ext}`
}

function mimeFor(ext) {
  return MIME[String(ext).toLowerCase()] || 'application/octet-stream'
}

function run(cmd, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      stdout += d
      if (stdout.length > 80_000_000) {
        killed = true
        child.kill('SIGKILL')
      }
    })
    child.stderr.on('data', (d) => {
      stderr += d
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, code: -1, stdout, stderr: String(e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0 && !killed, code, stdout, stderr, killed })
    })
  })
}

function ytErr(r) {
  const lines = String(r.stderr || '')
    .split('\n')
    .filter(Boolean)
  const err = [...lines].reverse().find((l) => /error/i.test(l)) || lines[0]
  if (r.killed) return 'la operación tardó demasiado y fue cancelada'
  return (err || 'error desconocido de yt-dlp').replace(/^ERROR:\s*/i, '')
}

function ytDlpBase() {
  const a = ['--no-playlist', '--no-warnings', '--socket-timeout', '20']
  if (existsSync(COOKIES_PATH)) a.push('--cookies', COOKIES_PATH)
  return a
}

function extractUrls(text) {
  const raw = (text || '').match(/https?:\/\/[^\s<>"'`]+/gi) || []
  return [...new Set(raw.map((u) => u.replace(/[.,;:!?]+$/, '')))]
}

function getText(msg) {
  const m = msg?.message
  if (!m) return ''
  const ct = getContentType(m)
  if (!ct) return ''
  const body = m[ct]
  if (typeof body === 'string') return body
  return body?.text || body?.caption || body?.selectedDisplayText || body?.title || ''
}

function classify(j) {
  if (j._type === 'foto' || j._type === 'gif') return j._type
  const ext = String(j.ext || '').toLowerCase()
  if (ext === 'gif' || j.is_gif === true) return 'gif'
  const fmts = (j.formats || []).filter((f) => f.ext)
  if (fmts.length) {
    const allImages = fmts.every(
      (f) => IMAGE_EXTS.has(String(f.ext).toLowerCase()) || f.vcodec === 'none'
    )
    if (allImages) return 'foto'
  }
  if (IMAGE_EXTS.has(ext) && !j.duration) return 'foto'
  return 'video'
}

async function fetchJson(url, timeoutMs = 15000) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctl.signal,
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function isXUrl(url) {
  return /^https?:\/\/(www\.)?(x|twitter)\.com\/[^/]+\/status\/\d+/i.test(url)
}

function xStatusId(url) {
  const m = String(url).match(/\/status\/(\d+)/)
  return m ? m[1] : null
}

function xInfoFromTweet(tweet, id) {
  const media = tweet?.media?.all || []
  const photos = media.filter((m) => m.type === 'photo' && m.url)
  const anim = media.find((m) => (m.type === 'gif' || m.type === 'video') && m.url)
  const author = tweet?.author || {}
  const who = author.name
    ? `${author.name}${author.screen_name ? ` (@${author.screen_name})` : ''}`
    : author.screen_name
      ? `@${author.screen_name}`
      : 'X'
  const text = String(tweet?.text || '').replace(/\s+/g, ' ').trim()
  const title = `${who}${text ? `: ${text}` : ''}`.slice(0, 140)
  const base = {
    title: title || 'Publicación de X',
    extractor_key: 'Twitter',
    webpage_url: `https://x.com/i/status/${id}`,
  }
  if (anim) {
    const isGif = anim.type === 'gif'
    return {
      ...base,
      _type: isGif ? 'gif' : 'video',
      _xMediaUrl: anim.url,
      ext: isGif ? 'gif' : 'mp4',
      is_gif: isGif,
      duration: anim.duration || null,
      thumbnail: anim.thumbnail_url || photos[0]?.url,
      formats: [
        {
          url: anim.url,
          ext: 'mp4',
          protocol: 'https',
          vcodec: 'h264',
          acodec: isGif ? 'none' : 'aac',
          width: anim.width,
          height: anim.height,
        },
      ],
    }
  }
  if (photos.length) {
    return {
      ...base,
      _type: 'foto',
      _xPhotos: photos.map((p) => p.url),
      ext: 'jpg',
      thumbnail: photos[0].url,
      formats: photos.map((p) => ({
        url: p.url,
        ext: 'jpg',
        protocol: 'https',
        width: p.width,
        height: p.height,
      })),
    }
  }
  return null
}

async function fetchXFallback(url) {
  const id = xStatusId(url)
  if (!id) return null

  const fx = await fetchJson(`https://api.fxtwitter.com/status/${id}`)
  if (fx?.tweet) {
    const info = xInfoFromTweet(fx.tweet, id)
    if (info) return info
  }

  const vx = await fetchJson(`https://api.vxtwitter.com/i/status/${id}`)
  if (vx) {
    const ext = Array.isArray(vx.media_extended) ? vx.media_extended : []
    const photos = ext.filter((m) => m.type === 'image')
    const anim = ext.find((m) => m.type === 'gif' || m.type === 'video')
    const tweet = {
      text: vx.text,
      author: { name: vx.user_name, screen_name: vx.user_screen_name },
      media: {
        all: [
          ...photos.map((p) => ({ type: 'photo', url: p.url })),
          ...(anim
            ? [
                {
                  type: anim.type === 'gif' ? 'gif' : 'video',
                  url: anim.url,
                  thumbnail_url: anim.thumbnail_url,
                  duration: anim.duration_millis ? anim.duration_millis / 1000 : null,
                },
              ]
            : []),
        ],
      },
    }
    const info = xInfoFromTweet(tweet, id)
    if (info) return info
  }
  return null
}

async function fetchInfo(url) {
  if (isXUrl(url)) {
    const fallback = await fetchXFallback(url)
    if (fallback) return fallback
  }
  const r = await run('yt-dlp', [...ytDlpBase(), '-J', url], { timeoutMs: 60000 })
  if (!r.ok) {
    if (isXUrl(url)) {
      const fallback = await fetchXFallback(url)
      if (fallback) return fallback
    }
    const e = new Error(ytErr(r))
    e.unsupported = /unsupported url|no supported sites|unsupported website/i.test(r.stderr || '')
    throw e
  }
  try {
    return JSON.parse(r.stdout)
  } catch {
    throw new Error('yt-dlp devolvió una respuesta inválida')
  }
}

function isHttpFmt(f) {
  return /^(https?|http)$/.test(String(f.protocol || ''))
}

function buildSizePlans(j) {
  const fmts = (j.formats || []).filter((f) => f.url && isHttpFmt(f))
  const isV = (f) => f.vcodec && f.vcodec !== 'none'
  const isA = (f) => f.acodec && f.acodec !== 'none'
  const score = (f) => (f.height || 0) * 1000 + (f.tbr || f.abr || 0)
  const pick = (arr) => arr.slice().sort((a, b) => score(b) - score(a))[0]

  const vidOnly = fmts.filter((f) => isV(f) && !isA(f))
  const audOnly = fmts.filter((f) => !isV(f) && isA(f))
  const muxed = fmts.filter((f) => isV(f) && isA(f))

  const plans = []
  const v = pick(vidOnly.filter((f) => f.ext === 'mp4')) || pick(vidOnly)
  const a = pick(audOnly.filter((f) => ['m4a', 'mp4'].includes(f.ext))) || pick(audOnly)
  if (v && a) plans.push([v.url, a.url])
  const mux = pick(muxed.filter((f) => f.ext === 'mp4')) || pick(muxed)
  if (mux) plans.push([mux.url])
  if (!plans.length && fmts.length) plans.push([pick(fmts).url])
  return plans
}

async function headSize(url) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 15000)
  try {
    let res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA }, signal: ctl.signal })
    if (res.ok) {
      const len = Number(res.headers.get('content-length'))
      if (len > 0) return len
    }
    res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, Range: 'bytes=0-0' },
      signal: ctl.signal,
    })
    const cr = res.headers.get('content-range')
    if (cr && cr.includes('/')) {
      const total = Number(cr.split('/').pop())
      try {
        await res.body?.cancel()
      } catch {}
      if (total > 0) return total
    }
    if (res.status === 200) {
      const len = Number(res.headers.get('content-length'))
      try {
        await res.body?.cancel()
      } catch {}
      if (len > 0) return len
    }
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function estimateSize(j) {
  if (j.filesize) return { bytes: j.filesize, approx: false }
  if (j.filesize_approx) return { bytes: j.filesize_approx, approx: true }
  for (const plan of buildSizePlans(j)) {
    const sizes = await Promise.all(plan.map(headSize))
    if (sizes.length && sizes.every((s) => s > 0)) {
      return { bytes: sizes.reduce((x, y) => x + y, 0), approx: false }
    }
  }
  const known = (j.formats || []).map((f) => f.filesize ?? f.filesize_approx).filter(Boolean)
  if (known.length) return { bytes: Math.max(...known), approx: true }
  return { bytes: null, approx: true }
}

async function fetchBytes(url, timeoutMs = 15000) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://www.google.com/' },
      signal: ctl.signal,
    })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length || buf.length > 15_000_000) return null
    return buf
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function ensureSendableImage(buf) {
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8
  const isPng = buf[0] === 0x89 && buf[1] === 0x50
  if (isJpg) return { data: buf, ext: 'jpg' }
  if (isPng) return { data: buf, ext: 'png' }
  const tmp = path.join(DL_DIR, `img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`)
  const src = `${tmp}.src`
  const dst = `${tmp}.jpg`
  try {
    await writeFile(src, buf)
    const r = await run('ffmpeg', ['-y', '-i', src, dst], { timeoutMs: 30000 })
    if (r.ok) {
      const out = await readFile(dst)
      if (out.length) return { data: out, ext: 'jpg' }
    }
  } catch {}
  await rm(src, { force: true }).catch(() => {})
  await rm(dst, { force: true }).catch(() => {})
  return null
}

async function fetchThumbBuffer(info, url) {
  const candidates = []
  if (info.thumbnail) candidates.push(info.thumbnail)
  for (const t of info.thumbnails || []) if (t.url) candidates.push(t.url)
  for (const u of [...new Set(candidates)]) {
    const buf = await fetchBytes(u)
    if (!buf) continue
    const img = await ensureSendableImage(buf)
    if (img) return img
  }
  const stamp = `th_${Date.now()}${Math.random().toString(36).slice(2, 5)}`
  const outTpl = path.join(DL_DIR, stamp)
  await run('yt-dlp', [...ytDlpBase(), '--skip-download', '--write-thumbnail', '-o', outTpl, url], {
    timeoutMs: 45000,
  })
  let files = []
  try {
    files = (await readdir(DL_DIR)).filter((f) => f.startsWith(stamp))
    if (files.length) {
      const buf = await readFile(path.join(DL_DIR, files[0]))
      const img = await ensureSendableImage(buf)
      if (img) return img
    }
  } catch {}
  await Promise.all(files.map((f) => rm(path.join(DL_DIR, f), { force: true }).catch(() => {})))
  return null
}

async function cleanupStamp(stamp) {
  try {
    const files = (await readdir(DL_DIR)).filter((f) => f.startsWith(stamp))
    await Promise.all(files.map((f) => rm(path.join(DL_DIR, f), { force: true }).catch(() => {})))
  } catch {}
}

async function videoCodec(file) {
  const r = await run(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file],
    { timeoutMs: 30000 }
  )
  return r.ok ? r.stdout.trim().split('\n')[0] || null : null
}

async function videoInfo(file) {
  const r = await run(
    'ffprobe',
    [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,pix_fmt,width,height',
      '-of', 'json',
      file,
    ],
    { timeoutMs: 30000 }
  )
  if (!r.ok) return { codec: null, hasAudio: false, pixFmt: null, width: 0, height: 0 }
  let streams = []
  try {
    streams = JSON.parse(r.stdout).streams || []
  } catch {
    return { codec: null, hasAudio: false, pixFmt: null, width: 0, height: 0 }
  }
  const v = streams.find((s) => s.codec_type === 'video')
  return {
    codec: v?.codec_name || null,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    pixFmt: v?.pix_fmt || null,
    width: Number(v?.width) || 0,
    height: Number(v?.height) || 0,
  }
}

async function downloadBytes(url, maxBytes = 80 * 1024 * 1024, timeoutMs = 180000) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal })
    if (!res.ok) return null
    const len = Number(res.headers.get('content-length'))
    if (len > maxBytes) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length || buf.length > maxBytes) return null
    return buf
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function downloadAndConvert(job) {
  const stamp = `dl_${Date.now()}${Math.random().toString(36).slice(2, 6)}`
  const outTpl = path.join(DL_DIR, `${stamp}.%(ext)s`)

  if (job.xPhotos?.length) {
    const files = []
    for (let i = 0; i < job.xPhotos.length; i++) {
      const buf = await downloadBytes(job.xPhotos[i], 15 * 1024 * 1024, 60000)
      if (!buf) continue
      const img = await ensureSendableImage(buf)
      if (!img) continue
      const f = path.join(DL_DIR, `${stamp}_${i}.${img.ext}`)
      await writeFile(f, img.data)
      files.push(f)
    }
    if (!files.length) throw new Error('No se pudo descargar la imagen de X')
    return { files, file: files[0], ext: 'jpg', origExt: 'jpg', stamp }
  }

  let file
  let origExt
  if (job.xMediaUrl) {
    const buf = await downloadBytes(job.xMediaUrl)
    if (!buf) throw new Error('No se pudo descargar el archivo de X')
    file = path.join(DL_DIR, `${stamp}.mp4`)
    await writeFile(file, buf)
    origExt = 'mp4'
  } else {
    const args = [
      ...ytDlpBase(),
      '-f',
      'bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/ba/b',
      '--merge-output-format',
      'mp4',
      '-o',
      outTpl,
      job.url,
    ]
    const r = await run('yt-dlp', args, { timeoutMs: 600000 })
    const entries = (await readdir(DL_DIR)).filter(
      (f) => f.startsWith(stamp) && !/\.(part|ytdl|temp)$/.test(f)
    )
    if (!r.ok || !entries.length) {
      await cleanupStamp(stamp)
      throw new Error(ytErr(r))
    }
    let biggest = entries[0]
    let best = -1
    for (const f of entries) {
      const s = (await stat(path.join(DL_DIR, f))).size
      if (s > best) {
        best = s
        biggest = f
      }
    }
    file = path.join(DL_DIR, biggest)
    origExt = path.extname(file).slice(1).toLowerCase()
  }

  let ext = origExt
  const base = file.slice(0, file.length - ext.length)

  if (ext === 'gif') {
    const dst = `${base}c.mp4`
    const c = await run(
      'ffmpeg',
      [
        '-y',
        '-stream_loop', '2',
        '-i', file,
        '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-r', '15',
        '-c:a', 'aac',
        '-b:a', '64k',
        '-shortest',
        '-movflags', '+faststart',
        dst,
      ],
      { timeoutMs: 300000 }
    )
    if (c.ok) {
      await rm(file, { force: true }).catch(() => {})
      file = dst
      ext = 'mp4'
    }
  } else if (['webp', 'avif'].includes(ext)) {
    const dst = `${base}c.jpg`
    const c = await run('ffmpeg', ['-y', '-i', file, dst], { timeoutMs: 60000 })
    if (c.ok) {
      await rm(file, { force: true }).catch(() => {})
      file = dst
      ext = 'jpg'
    }
  } else if (['webm', 'mkv', 'flv', 'avi', 'ts'].includes(ext)) {
    const dst = `${base}c.mp4`
    const c = await run(
      'ffmpeg',
      [
        '-y',
        '-i',
        file,
        '-c:v',
        'libx264',
        '-crf',
        '20',
        '-preset',
        'veryfast',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        dst,
      ],
      { timeoutMs: 600000 }
    )
    if (c.ok) {
      await rm(file, { force: true }).catch(() => {})
      file = dst
      ext = 'mp4'
    }
  } else if (['mp4', 'm4v', 'mov'].includes(ext)) {
    const info = await videoInfo(file)
    const forceReencode = job.kind === 'gif'
    const needVideo =
      forceReencode ||
      !info.codec ||
      info.codec !== 'h264' ||
      info.pixFmt !== 'yuv420p' ||
      (info.width > 0 && info.width % 2 !== 0) ||
      (info.height > 0 && info.height % 2 !== 0)
    const needAudio = !info.hasAudio
    if (needVideo || needAudio) {
      const dst = `${base}c.mp4`
      const args = ['-y']
      if (forceReencode) args.push('-stream_loop', '2')
      args.push('-i', file)
      if (needAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo')
      if (needVideo) {
        const fps = forceReencode ? '15' : '30'
        args.push('-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', fps)
      } else {
        args.push('-c:v', 'copy')
      }
      if (needAudio) args.push('-c:a', 'aac', '-b:a', '64k', '-shortest')
      else args.push('-c:a', 'copy')
      args.push('-movflags', '+faststart', dst)
      const c = await run('ffmpeg', args, { timeoutMs: 600000 })
      console.log(
        `🎬 Video ajustado (codec ${info.codec}, audio ${info.hasAudio ? 'sí' : 'no'}, reencode ${needVideo ? 'sí' : 'no'}) → ${c.ok ? 'ok' : 'falló'}`
      )
      if (c.ok) {
        await rm(file, { force: true }).catch(() => {})
        file = dst
        ext = 'mp4'
      }
    }
  }
  return { file, ext, origExt, stamp }
}

async function botSend(sock, jid, content, opts) {
  const isMedia = Boolean(content.image || content.video || content.document || content.audio || content.sticker)
  if (isMedia) opts = { ...(opts || {}), mediaUploadTimeoutMs: 300000 }
  let attempt = 0
  let m
  while (true) {
    try {
      m = await sock.sendMessage(jid, content, opts)
      break
    } catch (e) {
      const msg = String(e?.message || e)
      const retriable = /upload failed|timed out|timeout|ECONNRESET|ETIMEDOUT|socket hang up|Connection Closed/i.test(msg)
      if (!isMedia || !retriable || attempt >= 2) throw e
      attempt++
      console.error(`⚠️  Falló el envío (${msg}). Reintento ${attempt}/2…`)
      await new Promise((r) => setTimeout(r, 1500 * attempt))
    }
  }
  const dest = jid.endsWith('@lid') ? 'lid' : jid.endsWith('@s.whatsapp.net') ? 'pn' : jid
  const what = content.image
    ? `imagen ${content.image.length}b`
    : content.video
      ? `video ${content.video.length}b`
      : content.document
        ? `documento ${content.document.length}b`
        : content.text
          ? `texto "${String(content.text).slice(0, 40)}"`
          : 'otro'
  console.log(`📤 Enviado ${what} → ${dest} (id ${m?.key?.id || '?'})`)
  if (m?.key?.id) {
    botSentIds.add(m.key.id)
    capSet(botSentIds)
  }
  return m
}

async function processDownload(sock, jid, job) {
  if (inFlight.has(jid)) return
  inFlight.add(jid)
  let stamp = null
  let statusMsg = null
  try {
    statusMsg = await botSend(sock, jid, {
      text: '⬇️ Descargando el archivo… esto puede tardar unos segundos.',
    })
    const out = await downloadAndConvert(job)
    stamp = out.stamp
    const captionFor = (size) => `✅ *${job.title}*\n📱 ${job.platform} · 📦 ${fmtBytes(size)}`
    const quoted = job.originMsg

    if (out.files?.length) {
      for (let i = 0; i < out.files.length; i++) {
        const f = out.files[i]
        const { size } = await stat(f)
        const data = await readFile(f)
        await botSend(
          sock,
          jid,
          {
            image: data,
            caption: i === 0 ? captionFor(size) : undefined,
            mimetype: mimeFor(path.extname(f).slice(1)),
          },
          i === 0 ? { quoted } : undefined
        )
      }
      await deleteMsg(sock, jid, job.previewMsgKey)
      return
    }

    const { size } = await stat(out.file)
    if (size > MAX_DOC_BYTES) {
      throw new Error(
        `El archivo pesa ${fmtBytes(size)} y supera el límite seguro de envío de ${fmtBytes(MAX_DOC_BYTES)}.`
      )
    }
    let kind
    if (['jpg', 'jpeg', 'png', 'webp', 'avif'].includes(out.ext)) kind = 'image'
    else if (['mp4', 'm4v', 'mov'].includes(out.ext)) kind = 'video'
    else kind = 'document'
    if (kind === 'video' && size > MAX_VIDEO_BYTES) kind = 'document'
    if (kind === 'image' && size > MAX_IMAGE_BYTES) kind = 'document'

    const data = await readFile(out.file)
    const caption = captionFor(size)

    if (kind === 'image') {
      await botSend(sock, jid, { image: data, caption, mimetype: mimeFor(out.ext) }, { quoted })
    } else if (kind === 'video') {
      await botSend(
        sock,
        jid,
        {
          video: data,
          caption,
          mimetype: 'video/mp4',
          gifPlayback: false,
        },
        { quoted }
      )
    } else {
      await botSend(
        sock,
        jid,
        {
          document: data,
          fileName: safeName(job.title, out.ext),
          mimetype: mimeFor(out.ext),
          caption,
        },
        { quoted }
      )
    }
    await deleteMsg(sock, jid, job.previewMsgKey)
  } catch (e) {
    console.error('❌ Error en descarga:', e?.stack || e?.message || e)
    try {
      await botSend(sock, jid, { text: `❌ No se pudo descargar:\n_${cleanErr(e.message)}_` })
    } catch (e2) {
      console.error('❌ Tampoco se pudo enviar el aviso de error:', e2?.message || e2)
    }
  } finally {
    if (statusMsg) {
      try {
        await sock.sendMessage(jid, { delete: statusMsg.key })
      } catch {}
    }
    if (stamp) await cleanupStamp(stamp)
    inFlight.delete(jid)
  }
}

async function deleteMsg(sock, jid, key) {
  if (!key) return
  try {
    await sock.sendMessage(jid, { delete: key })
  } catch (e) {
    console.error('⚠️  No se pudo borrar un mensaje:', e?.message || e)
  }
}

async function showPreview(sock, jid, url, originMsg) {
  let statusMsg = null
  let previewMsg = null
  try {
    console.log('🔎 Analizando:', url.slice(0, 120))
    statusMsg = await botSend(sock, jid, { text: '⏳ Analizando el enlace…' })
    const info = await fetchInfo(url)
    const platform = info.extractor_key || info.extractor || 'Web'
    const kind = classify(info)
    console.log('🔎 Info obtenida:', platform, '| tipo:', kind, '| título:', String(info.title || '').slice(0, 80))
    const title = String(info.title || 'Sin título')
      .replace(/\s+/g, ' ')
      .slice(0, 140)
    const [thumb, size] = await Promise.all([fetchThumbBuffer(info, url), estimateSize(info)])

    const sizeTxt =
      size.bytes != null ? `${size.approx ? '≈ ' : ''}${fmtBytes(size.bytes)}` : 'no disponible'
    const caption = [
      '🔗 *¡Enlace detectado!*',
      '',
      `📌 *Título:* ${title}`,
      `📱 *Plataforma:* ${platform}`,
      `📁 *Tipo:* ${TYPE_EMOJI[kind]} ${TYPE_LABEL[kind]}`,
      `⏱️ *Duración:* ${fmtDur(info.duration)}`,
      `📦 *Peso:* ${sizeTxt}`,
      '',
      '✅ Responde *SI* para descargarlo',
      '❌ Responde *NO* para cancelar',
    ].join('\n')

    if (thumb) {
      previewMsg = await botSend(
        sock,
        jid,
        { image: thumb.data, caption, mimetype: mimeFor(thumb.ext) },
        { quoted: originMsg }
      )
    } else {
      previewMsg = await botSend(sock, jid, { text: caption }, { quoted: originMsg })
    }
    pending.set(jid, {
      url,
      title,
      platform,
      kind,
      originMsg,
      previewMsgKey: previewMsg?.key,
      xPhotos: info._xPhotos,
      xMediaUrl: info._xMediaUrl,
      expires: Date.now() + PENDING_TTL,
    })
  } catch (e) {
    console.error('❌ Error en preview:', e?.stack || e?.message || e)
    const reason = e.unsupported
      ? 'Ese enlace no es de una plataforma compatible.'
      : cleanErr(e.message)
    try {
      await botSend(
        sock,
        jid,
        { text: `❌ No pude analizar el enlace.\n_${reason}_` },
        { quoted: originMsg }
      )
    } catch (e2) {
      console.error('❌ Tampoco se pudo enviar el aviso de error:', e2?.message || e2)
    }
  } finally {
    if (statusMsg) {
      try {
        await sock.sendMessage(jid, { delete: statusMsg.key })
      } catch (e) {
        console.error('⚠️  No se pudo borrar el mensaje de estado:', e?.message || e)
      }
    }
  }
}

function getQuotedInfo(msg) {
  const m = msg?.message || {}
  const ct = getContentType(m)
  const body = ct ? m[ct] : null
  const ctx = body?.contextInfo
  if (!ctx?.stanzaId) return null
  return {
    // En mensajes "ver una sola vez" WhatsApp a veces manda el quote sin contenido.
    // Devolvemos igual el stanzaId para poder recuperarlo de la caché local.
    quoted: ctx.quotedMessage || null,
    stanzaId: ctx.stanzaId,
    participant: ctx.participant || ctx.remoteJid || msg.key.remoteJid,
  }
}

const SAVE_MEDIA_TYPES = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage']
const WRAPPER_TYPES = [
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'ephemeralMessage',
  'documentWithCaptionMessage',
  'editedMessage',
  'associatedChildMessage',
  'groupStatusMessage',
  'groupStatusMessageV2',
]

function unwrapMessage(m) {
  let cur = m
  for (let i = 0; i < 5 && cur; i++) {
    const ct = getContentType(cur)
    if (ct && WRAPPER_TYPES.includes(ct)) {
      cur = cur[ct]?.message
      continue
    }
    return cur
  }
  return cur
}

function quotedMediaType(quoted) {
  const ct = getContentType(quoted || {})
  if (!ct || !SAVE_MEDIA_TYPES.includes(ct)) return null
  if (ct === 'documentMessage') {
    const mt = quoted.documentMessage?.mimetype || ''
    if (!/^(image|video|audio)\//i.test(mt)) return null
  }
  return ct
}

function normalizeForKeyword(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\uFE0E\uFE0F]/g, '')
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '')
    .replace(/\u200D/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function textHasKeyword(text, keywords) {
  if (!text || !keywords?.length) return false
  const t = normalizeForKeyword(text)
  const compact = t.replace(/\s+/g, '')
  return keywords.some((k) => {
    const nk = normalizeForKeyword(k)
    if (!nk) return false
    // Coincide en cualquier parte del texto, con o sin espacios,
    // sin distinguir mayúsculas, tildes ni emojis con/sin selector.
    return t.includes(nk) || compact.includes(nk.replace(/\s+/g, ''))
  })
}

const KEYWORD_CMD_RE = /^[.!/](claves?|keywords?|palabras?)\b/i

const KEYWORD_HELP =
  'Comandos:\n' +
  '• *.clave palabra* → añadir\n' +
  '• *.clave palabra1, palabra2* → añadir varias\n' +
  '• *.clave borrar palabra* → quitar\n' +
  '• *.claves* → ver la lista'

async function keywordSettings(sock, text) {
  const cfg = await loadConfig()
  const list = Array.isArray(cfg.saveKeywords) ? cfg.saveKeywords : []
  const rest = text.replace(KEYWORD_CMD_RE, '').trim()
  const sub = rest.split(/\s+/).filter(Boolean)
  const action = norm(sub[0] || '')

  const reply = async (t) => {
    try {
      await sendToSelf(sock, { text: t })
    } catch (e) {
      console.error('❌ No pude responder al chat privado:', e?.message || e)
    }
  }

  if (!rest || ['lista', 'list', 'ver'].includes(action)) {
    await reply(
      (list.length
        ? `🔑 *Palabras clave guardadas:*\n${list.map((k) => `• ${k}`).join('\n')}\n\n`
        : '🔑 No hay palabras clave configuradas.\n\n') +
        'Responde a una foto, video o audio (también de *ver una sola vez*) con una de esas palabras ' +
        'y te lo enviaré únicamente a tu chat privado, sin escribir nada en el chat original.\n\n' +
        KEYWORD_HELP
    )
    return
  }

  if (['borrar', 'quitar', 'eliminar', 'del', 'remove'].includes(action)) {
    const word = norm(sub.slice(1).join(' '))
    if (!word) {
      await reply('Uso: *.clave borrar palabra*')
      return
    }
    const next = list.filter((k) => norm(k) !== word)
    if (next.length === list.length) {
      await reply(`⚠️ No encontré la palabra *${word}*.`)
      return
    }
    cfg.saveKeywords = next
    await saveConfig(cfg)
    await reply(`✅ Palabra quitada: *${word}*`)
    return
  }

  const joined = rest.replace(/^(a[nñ]adir|agregar|add)\s+/i, '').trim()
  const words = joined
    .split(/[,\n]+/)
    .map((w) => w.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  if (!words.length) {
    await reply('Uso: *.clave palabra* (máx. 40 caracteres)')
    return
  }
  const tooLong = words.filter((w) => w.length > 40)
  if (tooLong.length) {
    await reply(`⚠️ Estas palabras superan los 40 caracteres: ${tooLong.map((w) => `*${w}*`).join(', ')}`)
    return
  }

  const added = []
  const existed = []
  for (const w of words) {
    if (list.some((k) => norm(k) === norm(w))) existed.push(w)
    else {
      list.push(w)
      added.push(w)
    }
  }
  if (added.length) {
    cfg.saveKeywords = list
    await saveConfig(cfg)
  }
  const lines = []
  if (added.length) {
    lines.push(
      `✅ ${added.length === 1 ? 'Palabra añadida' : 'Palabras añadidas'}: ${added.map((w) => `*${w}*`).join(', ')}`
    )
  }
  if (existed.length) {
    lines.push(
      `ℹ️ Ya estaba${existed.length === 1 ? '' : 'n'}: ${existed.map((w) => `*${w}*`).join(', ')}`
    )
  }
  lines.push(
    'Responde a una foto, video o audio (también de *ver una sola vez*) con la palabra y te llegará solo a este chat privado.'
  )
  await reply(lines.join('\n'))
}

let lastPrivateMeJid = null
const mediaCache = new Map()
let mediaCacheLoadPromise = null
let mediaCacheReady = false
let mediaCacheSaveTimer = null

function normJid(j) {
  return j ? String(j).replace(/:\d+@/, '@') : null
}

async function ensureMediaCacheLoaded() {
  if (!mediaCacheLoadPromise) {
    mediaCacheLoadPromise = (async () => {
      try {
        const arr = v8.deserialize(await readFile(MEDIA_CACHE_PATH))
        if (Array.isArray(arr)) {
          for (const item of arr) {
            const id = item?.key?.id || item?.id
            if (!id || !item?.message) continue
            mediaCache.set(id, {
              message: item.message,
              key: item.key || { id },
              ts: Number(item.ts) || Date.now(),
            })
          }
          while (mediaCache.size > MEDIA_CACHE_MAX) mediaCache.delete(mediaCache.keys().next().value)
        }
      } catch {}
      mediaCacheReady = true
    })()
  }
  return mediaCacheLoadPromise
}

function normalizeMediaKey(message) {
  try {
    const ct = getContentType(message)
    const media = ct ? message[ct] : null
    if (media && typeof media.mediaKey === 'string') {
      media.mediaKey = Buffer.from(media.mediaKey.replace(/^data:[^;]+;base64,/, ''), 'base64')
    }
  } catch {}
  return message
}

function mediaEntryFromMessage(msg) {
  if (!msg?.message || !msg?.key?.id) return null
  try {
    const unwrapped = unwrapMessage(msg.message)
    const mct = unwrapped ? getContentType(unwrapped) : null
    if (!mct || !SAVE_MEDIA_TYPES.includes(mct)) return null
    const message = mct === getContentType(msg.message) ? msg.message : unwrapped
    return {
      message: normalizeMediaKey(message),
      key: msg.key,
      ts: Number(msg.messageTimestamp) * 1000 || Date.now(),
    }
  } catch {
    return null
  }
}

function rememberMediaMessage(msg) {
  const entry = mediaEntryFromMessage(msg)
  if (!entry) return null
  mediaCache.set(msg.key.id, entry)
  while (mediaCache.size > MEDIA_CACHE_MAX) mediaCache.delete(mediaCache.keys().next().value)
  if (mediaCacheReady) scheduleMediaCacheSave()
  return entry
}

function scheduleMediaCacheSave() {
  if (mediaCacheSaveTimer) return
  mediaCacheSaveTimer = setTimeout(() => {
    mediaCacheSaveTimer = null
    flushMediaCache().catch(() => {})
  }, 1200)
  mediaCacheSaveTimer.unref?.()
}

function mediaCacheArray() {
  const arr = []
  for (const [id, item] of mediaCache) {
    if (!item?.message) continue
    arr.push({ id, key: item.key, message: item.message, ts: item.ts || 0 })
  }
  return arr
}

async function flushMediaCache() {
  if (!mediaCacheReady) return
  const tmp = `${MEDIA_CACHE_PATH}.tmp`
  try {
    await writeFile(tmp, v8.serialize(mediaCacheArray()))
    await rename(tmp, MEDIA_CACHE_PATH)
  } catch (e) {
    console.error('⚠️ No pude guardar media-cache.bin:', e?.message || e)
  }
}

function flushMediaCacheSync() {
  if (mediaCacheSaveTimer) {
    clearTimeout(mediaCacheSaveTimer)
    mediaCacheSaveTimer = null
  }
  if (!mediaCacheReady) return
  const tmp = `${MEDIA_CACHE_PATH}.tmp`
  try {
    writeFileSync(tmp, v8.serialize(mediaCacheArray()))
    renameSync(tmp, MEDIA_CACHE_PATH)
  } catch {}
}

function quotedHasSource(quoted) {
  const ct = quotedMediaType(quoted)
  if (!ct) return false
  const media = quoted[ct] || {}
  return Boolean(media.url || media.directPath)
}

function selfJidCandidates(sock) {
  const me = sock?.authState?.creds?.me || {}
  const out = []
  for (const j of [lastPrivateMeJid, me.id, me.lid]) {
    const cj = normJid(j)
    if (cj && !cj.endsWith('@g.us') && !out.includes(cj)) out.push(cj)
  }
  return out
}

async function sendToSelf(sock, content, opts) {
  const candidates = selfJidCandidates(sock)
  if (!candidates.length) throw new Error('no se pudo determinar tu chat privado')
  let lastErr = null
  for (const jid of candidates) {
    try {
      const sent = await botSend(sock, jid, content, opts)
      lastPrivateMeJid = jid
      return sent
    } catch (e) {
      lastErr = e
      console.error('⚠️ No pude enviar a tu chat privado:', e?.message || e)
    }
  }
  throw lastErr || new Error('no se pudo enviar a tu chat privado')
}

function extFromMime(mime, fallback = 'bin') {
  const m = String(mime || '').toLowerCase().split(';')[0].trim()
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'video/3gpp': '3gp',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/amr': 'amr',
    'audio/wav': 'wav',
    'application/pdf': 'pdf',
  }
  return map[m] || fallback
}

async function senderLabel(sock, raw) {
  const jid = normJid(raw)
  if (!jid || jid.endsWith('@g.us')) return ''
  let pn = null
  try {
    pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(jid)
  } catch {}
  if (!pn && jid.endsWith('@lid')) return ''
  const num = String(normJid(pn) || jid).split('@')[0].replace(/\D/g, '')
  return num ? `+${num}` : ''
}

function quotedKeyCandidates(sock, chat, stanzaId, participant) {
  const me = sock?.authState?.creds?.me || {}
  const selfIds = new Set([normJid(me.id), normJid(me.lid)].filter(Boolean))
  const p = normJid(participant)
  const mine =
    (p && selfIds.has(p)) ||
    (!chat.endsWith('@g.us') && selfIds.has(normJid(chat)))
  const order = mine ? [true, false] : [false, true]
  return order.map((fromMe) => {
    const key = { remoteJid: chat, fromMe, id: stanzaId }
    if (!fromMe && participant && chat.endsWith('@g.us')) key.participant = participant
    return key
  })
}

function markSeen(id) {
  if (!id) return
  seenIds.add(id)
  capSet(seenIds)
}

async function waitForMediaEntry(sock, id, timeoutMs) {
  const existing = mediaCache.get(id)
  if (existing?.message) return existing
  return new Promise((resolve) => {
    let settled = false
    const finish = (v) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        sock.ev.off('messages.upsert', onUpsert)
      } catch {}
      resolve(v || null)
    }
    const onUpsert = (ev) => {
      for (const m of ev?.messages || []) {
        if (m?.key?.id !== id) continue
        const entry = rememberMediaMessage(m)
        if (entry) {
          // Ya lo recuperamos aquí: que el manejador normal no lo vuelva a
          // procesar como si fuera un mensaje nuevo (evita respuestas al chat).
          markSeen(id)
          finish(entry)
        }
      }
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    try {
      if (typeof sock.ev.prependListener === 'function') {
        sock.ev.prependListener('messages.upsert', onUpsert)
      } else {
        sock.ev.on('messages.upsert', onUpsert)
      }
    } catch {
      finish(null)
    }
  })
}

function requestHistoryPage(sock, key, ts, stanzaId) {
  return new Promise((resolve) => {
    let settled = false
    let oldest = null
    let quietTimer = null
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(hardTimer)
      clearTimeout(quietTimer)
      try {
        sock.ev.off('messaging-history.set', onHistory)
      } catch {}
      resolve({ entry: mediaCache.get(stanzaId) || null, oldest })
    }
    const onHistory = (ev) => {
      for (const m of ev?.messages || []) {
        if (!m?.key?.id) continue
        rememberMediaMessage(m)
        if (!oldest || (Number(m.messageTimestamp) || 0) < (Number(oldest.messageTimestamp) || 0)) {
          oldest = m
        }
        if (m.key.id === stanzaId) {
          markSeen(stanzaId)
          finish()
          return
        }
      }
      clearTimeout(quietTimer)
      quietTimer = setTimeout(finish, 2000)
    }
    const hardTimer = setTimeout(finish, 15000)
    try {
      sock.ev.on('messaging-history.set', onHistory)
    } catch {
      finish()
      return
    }
    Promise.resolve()
      .then(() => sock.fetchMessageHistory(100, key, ts))
      .catch((e) => {
        console.error('⚠️ No pude pedir historial:', e?.message || e)
        finish()
      })
  })
}

async function fetchHistoryForQuoted(sock, msg, stanzaId) {
  const chat = msg.key.remoteJid
  let key = {
    remoteJid: chat,
    fromMe: Boolean(msg.key.fromMe),
    id: msg.key.id,
    participant: msg.key.participant,
  }
  let ts = Number(msg.messageTimestamp) * 1000
  if (!Number.isFinite(ts) || ts <= 0) ts = Date.now()

  for (let page = 0; page < 3; page++) {
    const result = await requestHistoryPage(sock, key, ts, stanzaId)
    if (result.entry?.message) return result.entry
    if (!result.oldest?.key?.id) break
    key = {
      remoteJid: chat,
      fromMe: Boolean(result.oldest.key.fromMe),
      id: result.oldest.key.id,
      participant: result.oldest.key.participant,
    }
    ts = Number(result.oldest.messageTimestamp) * 1000
    if (!Number.isFinite(ts) || ts <= 0) break
  }
  return mediaCache.get(stanzaId) || null
}

async function recoverQuotedEntry(sock, msg, info) {
  await ensureMediaCacheLoaded()
  const cached = mediaCache.get(info.stanzaId)
  if (cached?.message) return cached

  const chat = msg.key.remoteJid
  const participant =
    info.participant && !String(info.participant).endsWith('@g.us') ? info.participant : null

  // 1) El teléfono puede reenviar el mensaje original exacto (aunque el bot
  //    estuviera apagado cuando llegó). Es el método más preciso.
  if (typeof sock.requestPlaceholderResend === 'function') {
    for (const key of quotedKeyCandidates(sock, chat, info.stanzaId, participant)) {
      const waiter = waitForMediaEntry(sock, info.stanzaId, 11000)
      try {
        console.log('🕘 Pidiendo al teléfono el mensaje original…')
        await sock.requestPlaceholderResend(key)
      } catch (e) {
        console.error('⚠️ Falló la petición de reenvío:', e?.message || e)
      }
      const got = await waiter
      if (got?.message) return got
    }
  }

  // 2) Si el reenvío no llegó, pedir el historial del chat bajo demanda.
  if (typeof sock.fetchMessageHistory === 'function') {
    console.log('🗂️ Buscando el contenido en el historial del chat…')
    const got = await fetchHistoryForQuoted(sock, msg, info.stanzaId)
    if (got?.message) return got
  }

  return mediaCache.get(info.stanzaId) || null
}

async function saveQuotedToSelf(sock, msg, info) {
  await ensureMediaCacheLoaded()
  const chat = msg.key.remoteJid
  let cached = mediaCache.get(info.stanzaId) || null
  let quoted = unwrapMessage(info.quoted || cached?.message)
  const initialCt = quotedMediaType(quoted)
  const needsRecovery = !quoted || (initialCt && !quotedHasSource(quoted))

  if (needsRecovery) {
    const recovered = await recoverQuotedEntry(sock, msg, info)
    if (recovered?.message) {
      const recoveredQuoted = unwrapMessage(recovered.message)
      if (quotedMediaType(recoveredQuoted)) {
        cached = recovered
        quoted = recoveredQuoted
      }
    }
  }

  const ct = quotedMediaType(quoted)
  if (!ct) {
    if (!quoted) {
      try {
        await sendToSelf(sock, {
          text: '❌ No pude recuperar ese contenido. Puede que ya no esté disponible en WhatsApp.',
        })
      } catch {}
    }
    return false
  }
  const media = quoted[ct] || {}

  const sources = []
  if (cached?.message) {
    sources.push({
      key: {
        remoteJid: chat,
        fromMe: Boolean(cached.key?.fromMe),
        id: info.stanzaId,
        participant: cached.key?.participant || info.participant,
      },
      message: cached.message,
    })
  }
  for (const fromMe of [false, true]) {
    sources.push({
      key: {
        remoteJid: chat,
        fromMe,
        id: info.stanzaId,
        participant: info.participant,
      },
      message: quoted,
    })
  }

  let buf = null
  let lastErr = null
  for (const src of sources) {
    try {
      buf = await downloadMediaMessage(src, 'buffer', {}, {
        logger: pino({ level: 'silent' }),
        reuploadRequest: sock.updateMediaMessage,
      })
      if (buf?.length) break
      lastErr = new Error('archivo vacío')
    } catch (e) {
      lastErr = e
    }
  }

  if (!buf?.length) {
    console.error('❌ No pude descargar el archivo de la palabra clave:', lastErr?.message || lastErr)
    try {
      await sendToSelf(sock, {
        text: `❌ No pude guardar ese archivo. _(${cleanErr(lastErr?.message || 'error desconocido')})_`,
      })
    } catch {}
    return true
  }

  const origin = chat.endsWith('@g.us') ? 'grupo' : 'chat privado'
  const sender = await senderLabel(
    sock,
    info.participant && !String(info.participant).endsWith('@g.us')
      ? info.participant
      : chat.endsWith('@g.us')
        ? null
        : chat
  )
  const kind =
    {
      imageMessage: 'Foto',
      videoMessage: 'Video',
      audioMessage: 'Audio',
      stickerMessage: 'Sticker',
      documentMessage: 'Archivo',
    }[ct] || 'Archivo'
  const caption = [
    `📥 *${kind} guardado desde ${origin}*`,
    sender ? `👤 ${sender}` : '',
    media.viewOnce ? '🔒 Ver una sola vez' : '',
    `🕒 ${new Date().toLocaleString('es-VE')}`,
  ]
    .filter(Boolean)
    .join('\n')

  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const baseName = `wa_${kind.toLowerCase()}_${stamp}`
  const mimetype = media.mimetype || ''

  try {
    if (ct === 'imageMessage') {
      if (buf.length <= MAX_IMAGE_BYTES) {
        await sendToSelf(sock, { image: buf, caption })
      } else {
        await sendToSelf(sock, {
          document: buf,
          mimetype: mimetype || 'image/jpeg',
          fileName: `${baseName}.${extFromMime(mimetype, 'jpg')}`,
          caption,
        })
      }
    } else if (ct === 'videoMessage') {
      if (buf.length <= MAX_VIDEO_BYTES) {
        await sendToSelf(sock, {
          video: buf,
          caption,
          mimetype: mimetype || 'video/mp4',
          gifPlayback: Boolean(media.gifPlayback),
        })
      } else {
        await sendToSelf(sock, {
          document: buf,
          mimetype: mimetype || 'video/mp4',
          fileName: `${baseName}.${extFromMime(mimetype, 'mp4')}`,
          caption,
        })
      }
    } else if (ct === 'audioMessage') {
      if (buf.length <= MAX_AUDIO_BYTES) {
        await sendToSelf(sock, {
          audio: buf,
          mimetype: mimetype || 'audio/ogg; codecs=opus',
          ptt: Boolean(media.ptt),
        })
        await sendToSelf(sock, { text: caption })
      } else {
        await sendToSelf(sock, {
          document: buf,
          mimetype: mimetype || 'audio/ogg',
          fileName: `${baseName}.${extFromMime(mimetype, 'ogg')}`,
          caption,
        })
      }
    } else if (ct === 'stickerMessage') {
      await sendToSelf(sock, { sticker: buf })
      await sendToSelf(sock, { text: caption })
    } else {
      await sendToSelf(sock, {
        document: buf,
        mimetype: mimetype || 'application/octet-stream',
        fileName: media.fileName || `${baseName}.${extFromMime(mimetype)}`,
        caption,
      })
    }
    console.log(`📥 Guardado solo en tu chat privado: ${kind} (${buf.length}b) desde ${origin}`)
    return true
  } catch (e) {
    console.error('❌ No pude guardar el archivo:', e?.stack || e?.message || e)
    try {
      await sendToSelf(sock, {
        text: `❌ No pude guardar ese archivo. _(${cleanErr(e.message)})_`,
      })
    } catch {}
    return true
  }
}

function buildExifPayload(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8')
  const h = Buffer.alloc(22)
  h.writeUInt16BE(0x4d4d, 0)
  h.writeUInt16BE(0x002a, 2)
  h.writeUInt32BE(8, 4)
  h.writeUInt16BE(1, 8)
  h.writeUInt16BE(0x5741, 10)
  h.writeUInt16BE(7, 12)
  h.writeUInt32BE(json.length, 14)
  h.writeUInt32BE(26, 18)
  return Buffer.concat([h, Buffer.alloc(4), json])
}

function fixWebpFlags(out, orig) {
  try {
    if (out.length < 21 || out.toString('latin1', 0, 4) !== 'RIFF') return out
    if (out.toString('latin1', 12, 16) !== 'VP8X') return out
    const origFlags = orig.length >= 21 && orig.toString('latin1', 12, 16) === 'VP8X' ? orig[20] : 0
    const buf = Buffer.from(out)
    buf[20] = buf[20] | 0x08 | (origFlags & 0x10) | (origFlags & 0x20) | (origFlags & 0x04)
    return buf
  } catch {
    return out
  }
}

async function stickerExif(webp, packName, author) {
  try {
    const payload = buildExifPayload({
      'sticker-pack-id': 'com.termux.wadl',
      'sticker-pack-name': String(packName || '').slice(0, 128),
      'sticker-pack-publisher': String(author || '').slice(0, 128),
      emojis: ['🙂'],
    })
    const stamp = `ex_${Date.now()}${Math.random().toString(36).slice(2, 6)}`
    const inF = path.join(DL_DIR, `${stamp}.webp`)
    const exF = path.join(DL_DIR, `${stamp}.exif`)
    const outF = path.join(DL_DIR, `${stamp}_x.webp`)
    await writeFile(inF, webp)
    await writeFile(exF, payload)
    const r = await run('webpmux', ['-set', 'exif', exF, inF, '-o', outF], { timeoutMs: 60000 })
    let out = webp
    if (r.ok) {
      const b = await readFile(outF)
      if (b.length) out = fixWebpFlags(b, webp)
    } else {
      console.error('⚠️ No se pudo añadir la firma al sticker:', ytErr(r))
    }
    await Promise.all([inF, exF, outF].map((f) => rm(f, { force: true }).catch(() => {})))
    return out
  } catch (e) {
    console.error('⚠️ Error añadiendo firma al sticker:', e?.message || e)
    return webp
  }
}

async function mediaDuration(file) {
  const r = await run(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { timeoutMs: 30000 }
  )
  const d = r.ok ? Number(r.stdout.trim().split('\n')[0]) : NaN
  return isFinite(d) && d > 0 ? d : null
}

async function stickerSettings(sock, jid, msg, text) {
  const cmd = text.match(/^[.!/](packname|pack|author|firma|packinfo|firmainfo)\b/i)
  const name = (cmd?.[1] || '').toLowerCase()
  let value = text.replace(/^[.!/]\S+\s*/, '').trim()
  if (!value) {
    const q = getQuotedInfo(msg)
    if (q?.quoted) value = getText({ message: q.quoted }).trim()
  }
  const cfg = await loadConfig()
  const pack = cfg.stickerPackName || 'Mis stickers'
  const author = cfg.stickerAuthor || ''

  if (name === 'packinfo' || name === 'firmainfo') {
    await botSend(sock, jid, {
      text:
        `🏷️ *Firma de tus stickers*\n\n` +
        `• *Pack:* ${pack}\n` +
        `• *Autor:* ${author || '(sin definir)'}\n\n` +
        `Cámbialos con:\n• *.packname Tu texto*\n• *.author Tu nombre*`,
    })
    return
  }
  if (!value) {
    await botSend(sock, jid, {
      text:
        `Uso: *${name === 'pack' ? '.packname' : name === 'firma' ? '.author' : '.' + name}* <texto>\n` +
        `Actual: *${name === 'author' || name === 'firma' ? author || '(sin definir)' : pack}*\n\n` +
        `También puedes responder a un mensaje de texto con el comando para usar ese texto.`,
    })
    return
  }
  if (value.length > 128) value = value.slice(0, 128)
  if (name === 'author' || name === 'firma') {
    cfg.stickerAuthor = value
    await saveConfig(cfg)
    await botSend(sock, jid, { text: `✅ Autor de stickers actualizado: *${value}*` })
  } else {
    cfg.stickerPackName = value
    await saveConfig(cfg)
    await botSend(sock, jid, { text: `✅ Nombre del pack actualizado: *${value}*` })
  }
}

async function makeSticker(sock, jid, msg) {
  const info = getQuotedInfo(msg)
  if (info) info.quoted = unwrapMessage(info.quoted)
  if (!info) {
    await botSend(sock, jid, {
      text: '🖼️ Responde a una *foto*, *video*, *GIF* o *sticker* con *.s* para convertirlo en sticker.',
    })
    return
  }
  const quotedCt = getContentType(info.quoted)
  const mediaTypes = ['imageMessage', 'videoMessage', 'stickerMessage', 'documentMessage']
  if (!quotedCt || !mediaTypes.includes(quotedCt)) {
    await botSend(sock, jid, { text: '⚠️ Ese mensaje no tiene imagen, video o sticker.' })
    return
  }
  const media = info.quoted[quotedCt]
  if (quotedCt === 'videoMessage' && media.fileLength > 60 * 1024 * 1024) {
    await botSend(sock, jid, { text: '⚠️ El video es demasiado grande para hacer sticker (máx. 60 MB).' })
    return
  }
  let statusMsg = null
  try {
    statusMsg = await botSend(sock, jid, { text: '🎨 Creando sticker…' })
    const me = sock.authState.creds.me || {}
    const fromMe =
      info.participant === me.id ||
      info.participant === me.lid ||
      info.participant === jid
    const buffer = await downloadMediaMessage(
      {
        key: {
          remoteJid: jid,
          fromMe,
          id: info.stanzaId,
        },
        message: info.quoted,
      },
      'buffer',
      {},
      { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
    )
    if (!buffer?.length) throw new Error('no se pudo descargar el archivo')
    if (buffer.length > 40 * 1024 * 1024) throw new Error('el archivo es demasiado grande')

    const stamp = `st_${Date.now()}${Math.random().toString(36).slice(2, 6)}`
    const src = path.join(DL_DIR, `${stamp}.bin`)
    const dst = path.join(DL_DIR, `${stamp}.webp`)
    await writeFile(src, buffer)

    let sticker = buffer
    if (quotedCt === 'stickerMessage') {
      sticker = buffer
    } else {
      const isVideo =
        quotedCt === 'videoMessage' ||
        (quotedCt === 'documentMessage' && /video/i.test(media.mimetype || ''))
      const isGif = (quotedCt === 'videoMessage' && media.gifPlayback) || /gif/i.test(media.mimetype || '')
      const animated = isVideo || isGif
      const vf =
        'scale=512:512:force_original_aspect_ratio=decrease,' +
        'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000'
      if (animated) {
        const dur = await mediaDuration(src)
        const maxDur = Math.min(30, dur || 30)
        const tries = [
          { t: maxDur, fps: 15, q: 60 },
          { t: maxDur, fps: 12, q: 50 },
          { t: maxDur, fps: 10, q: 40 },
          { t: maxDur, fps: 8, q: 30 },
          { t: maxDur, fps: 7, q: 25 },
          { t: maxDur, fps: 6, q: 20 },
          { t: Math.min(10, maxDur), fps: 12, q: 45 },
        ]
        let start = 0
        if (maxDur > 20) start = 4
        else if (maxDur > 12) start = 2
        else if (maxDur > 8) start = 1
        for (const a of tries.slice(start)) {
          const r = await run(
            'ffmpeg',
            [
              '-y', '-t', String(a.t), '-i', src,
              '-vf', `fps=${a.fps},${vf}`,
              '-c:v', 'libwebp', '-lossless', '0', '-q:v', String(a.q),
              '-loop', '0', '-an', dst,
            ],
            { timeoutMs: 300000 }
          )
          if (!r.ok) throw new Error(ytErr(r))
          sticker = await readFile(dst)
          if (sticker.length <= 1024 * 1024) break
        }
      } else {
        const args = ['-y', '-i', src, '-vf', vf, '-c:v', 'libwebp', '-lossless', '0', '-q:v', '80', '-loop', '0', '-an', dst]
        const r = await run('ffmpeg', args, { timeoutMs: 120000 })
        if (!r.ok) throw new Error(ytErr(r))
        sticker = await readFile(dst)
      }
    }
    if (sticker.length > 1024 * 1024) throw new Error('el sticker supera 1 MB')
    const cfg = await loadConfig()
    sticker = await stickerExif(sticker, cfg.stickerPackName, cfg.stickerAuthor)
    if (sticker.length > 1024 * 1024) throw new Error('el sticker supera 1 MB')
    await botSend(sock, jid, { sticker })
  } catch (e) {
    console.error('❌ Error creando sticker:', e?.stack || e?.message || e)
    await botSend(sock, jid, { text: `❌ No pude crear el sticker.\n_${cleanErr(e.message)}_` })
  } finally {
    try {
      const files = (await readdir(DL_DIR)).filter((f) => f.startsWith('st_'))
      await Promise.all(files.map((f) => rm(path.join(DL_DIR, f), { force: true }).catch(() => {})))
    } catch {}
    if (statusMsg) await deleteMsg(sock, jid, statusMsg.key)
  }
}


async function botToggle(sock, jid, msg, text) {
  const m = text.match(/^[.!/]bot(?:\s+(on|off))?$/i)
  const accion = (m?.[1] || '').toLowerCase()
  const isGroup = jid.endsWith('@g.us')

  if (isGroup && !msg.key.fromMe) {
    const sender = msg.key.participant || msg.participant
    const meta = await sock.groupMetadata(jid).catch(() => null)
    const p = meta?.participants?.find((x) => normJid(x.id) === normJid(sender))
    const admin = p?.admin === 'admin' || p?.admin === 'superadmin'
    if (!admin) {
      await botSend(sock, jid, {
        text: '🔒 Solo un *administrador* del grupo puede activar o desactivar el bot.',
      })
      return
    }
  }

  const cfg = await loadConfig()
  const list = Array.isArray(cfg.enabledChats) ? cfg.enabledChats : []
  const activo = list.includes(jid)

  if (!accion) {
    await botSend(sock, jid, {
      text: activo
        ? '✅ El bot está *activado* en este chat.\nUsa *.bot off* para desactivarlo.'
        : '💤 El bot está *desactivado* en este chat.\nUsa *.bot on* para activarlo.',
    })
    return
  }

  if (accion === 'on') {
    if (!activo) {
      list.push(jid)
      cfg.enabledChats = list
      await saveConfig(cfg)
    }
    await botSend(sock, jid, {
      text: '✅ *Bot activado* en este chat.\nYa puedo descargar enlaces y música con *.m*.',
    })
    return
  }

  if (activo) {
    cfg.enabledChats = list.filter((x) => x !== jid)
    await saveConfig(cfg)
  }
  await botSend(sock, jid, { text: '💤 *Bot desactivado* en este chat.' })
}

async function musicCmd(sock, jid, msg, text) {
  const query = text.replace(/^[.!/](m|musica|música|play|audio)\b/i, '').trim()
  if (!query) {
    await botSend(sock, jid, {
      text: '🎵 Uso: *.m nombre de la canción*\nEj: *.m bad bunny monaco*',
    })
    return
  }

  const status = await botSend(sock, jid, { text: `🔎 Buscando «${query}»…` })
  const stamp = `mus_${Date.now()}${Math.random().toString(36).slice(2, 6)}`
  const outTpl = path.join(DL_DIR, `${stamp}.%(ext)s`)

  try {
    const args = [
      ...ytDlpBase(),
      '-f', 'bestaudio/best',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '5',
      '--no-simulate',
      '--print', 'META:%(title)s\t%(uploader)s\t%(duration)s',
      '-o', outTpl,
      `ytsearch1:${query}`,
    ]
    const r = await run('yt-dlp', args, { timeoutMs: 300000 })
    const entries = (await readdir(DL_DIR)).filter(
      (f) => f.startsWith(stamp) && !/\.(part|ytdl|temp)$/.test(f)
    )
    if (!r.ok || !entries.length) {
      await cleanupStamp(stamp)
      if (status?.key) await deleteMsg(sock, jid, status.key)
      await botSend(sock, jid, {
        text: `❌ No pude descargar esa canción. _( ${cleanErr(ytErr(r))} )_`,
      })
      return
    }

    let meta = { title: query, uploader: '', duration: 0 }
    const line = String(r.stdout || '')
      .split('\n')
      .find((l) => l.startsWith('META:'))
    if (line) {
      const [t, u, d] = line.slice(5).split('\t')
      meta = { title: t || query, uploader: u || '', duration: Number(d) || 0 }
    }

    const file = path.join(DL_DIR, entries[0])
    const buf = await readFile(file)
    if (status?.key) await deleteMsg(sock, jid, status.key)

    const info = [
      `🎵 *${meta.title}*`,
      meta.uploader ? `👤 ${meta.uploader}` : '',
      meta.duration ? `⏱ ${fmtDur(meta.duration)}` : '',
      `📦 ${fmtBytes(buf.length)}`,
    ].filter(Boolean).join('\n')
    await botSend(sock, jid, { text: info })

    if (buf.length > 15 * 1024 * 1024) {
      await botSend(sock, jid, {
        document: buf,
        mimetype: 'audio/mpeg',
        fileName: `${safeName(meta.title, 'mp3')}.mp3`,
      })
    } else {
      await botSend(sock, jid, {
        audio: buf,
        mimetype: 'audio/mpeg',
        fileName: `${safeName(meta.title, 'mp3')}.mp3`,
      })
    }
    console.log(`🎵 Enviado audio: ${meta.title} (${buf.length}b)`)
  } catch (e) {
    console.error('❌ Error en .m:', e?.stack || e?.message || e)
    if (status?.key) await deleteMsg(sock, jid, status.key).catch(() => {})
    await botSend(sock, jid, {
      text: `❌ No pude descargar esa canción. _( ${cleanErr(e.message)} )_`,
    }).catch(() => {})
  } finally {
    await cleanupStamp(stamp)
  }
}

async function processMessage(sock, msg) {
  if (paused) return
  if (!msg?.message || !msg.key?.remoteJid) return
  const jid = msg.key.remoteJid
  if (jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return
  const id = msg.key.id
  if (id) {
    if (seenIds.has(id)) return
    seenIds.add(id)
    capSet(seenIds)
    if (botSentIds.has(id)) return
  }

  const text = getText(msg).trim()

  // Guarda metadatos de los medios (aunque el bot se reinicie luego) para poder
  // recuperarlos cuando respondas con una palabra clave más adelante.
  await ensureMediaCacheLoaded()
  rememberMediaMessage(msg)

  if (msg.key.fromMe && !jid.endsWith('@g.us')) {
    const cj = normJid(jid)
    const me = sock.authState.creds.me || {}
    if (cj && (cj === normJid(me.lid) || cj === normJid(me.id))) lastPrivateMeJid = cj
  }

  const cfg = await loadConfig()
  const keywords = Array.isArray(cfg.saveKeywords) ? cfg.saveKeywords : []
  const enabledChats = Array.isArray(cfg.enabledChats) ? cfg.enabledChats : []

  if (KEYWORD_CMD_RE.test(text)) {
    if (msg.key.fromMe) await keywordSettings(sock, text)
    return
  }

  if (msg.key.fromMe && keywords.length) {
    const info = getQuotedInfo(msg)
    if (info && textHasKeyword(text, keywords)) {
      // El quote puede venir vacío (típico en "ver una sola vez"). Si no hay
      // copia local, saveQuotedToSelf intenta recuperar el mensaje original.
      const quoted = unwrapMessage(info.quoted || mediaCache.get(info.stanzaId)?.message)
      if (quotedMediaType(quoted) || !quoted) {
        info.quoted = quoted
        await saveQuotedToSelf(sock, msg, info)
        return
      }
    }
  }

  if (/^[.!/]bot(?:\s+(on|off))?$/i.test(text)) {
    await botToggle(sock, jid, msg, text)
    return
  }

  if (jid.endsWith('@g.us') && !enabledChats.includes(jid)) return

  if (/^[.!/](m|musica|música|play|audio)\b/i.test(text)) {
    await musicCmd(sock, jid, msg, text)
    return
  }

  if (/^[.!/](packname|pack|author|firma|packinfo|firmainfo)\b/i.test(text)) {
    await stickerSettings(sock, jid, msg, text)
    return
  }
  if (/^[.!/](s|sticker|stiker)$/i.test(text)) {
    await makeSticker(sock, jid, msg)
    return
  }
  const urls = extractUrls(text)
  const job = pending.get(jid)

  if (job && urls.length === 0) {
    const ans = norm(text)
    if (YES.has(ans)) {
      pending.delete(jid)
      if (job.expires < Date.now()) {
        await botSend(sock, jid, {
          text: '⏰ La solicitud expiró. Pega el enlace de nuevo para verla otra vez.',
        })
        return
      }
      await processDownload(sock, jid, job)
      return
    }
    if (NO.has(ans)) {
      pending.delete(jid)
      await botSend(sock, jid, { text: '❌ Descarga cancelada.' })
      return
    }
    return
  }

  if (!urls.length) return
  const url = urls.find((u) => KNOWN_HOSTS.test(u)) || urls[0]
  await showPreview(sock, jid, url, msg)
}

async function loadConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
  } catch {
    return { phoneNumber: '' }
  }
}

async function saveConfig(cfg) {
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2))
}

function printSetupBanner() {
  const line = '═'.repeat(48)
  console.log(`\n${line}`)
  console.log('   🤖  WA DOWNLOADER BOT — CONFIGURACIÓN INICIAL')
  console.log(line)
  console.log('   Este bot descarga videos, fotos y GIF de Facebook,')
  console.log('   Instagram, X/Twitter, TikTok, YouTube y más.')
  console.log('')
  console.log('   Para empezar necesitas:')
  console.log('   1. El número de WhatsApp que usará el bot')
  console.log('      (con código de país, sin +, espacios ni guiones).')
  console.log('   2. Tu celular con WhatsApp para vincularlo.')
  console.log('   3. El código de vinculación que aparecerá después.')
  console.log('')
  console.log('   Escríbelo aquí abajo para continuar.')
  console.log(`${line}\n`)
}

async function ensurePhone(cfg) {
  const envPhone = String(process.env.WA_PHONE || '').replace(/\D/g, '')
  if (envPhone.length >= 8 && envPhone.length <= 15) {
    if (cfg.phoneNumber !== envPhone) {
      cfg.phoneNumber = envPhone
      await saveConfig(cfg)
    }
    return envPhone
  }

  if (cfg.phoneNumber && /^\d{8,15}$/.test(cfg.phoneNumber)) return cfg.phoneNumber

  if (!process.stdin.isTTY) {
    console.error(
      '❌ No hay una terminal interactiva para pedir el número.\n' +
        '   Ejecuta el bot en una terminal o define WA_PHONE con tu número.'
    )
    process.exit(1)
  }

  printSetupBanner()
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (;;) {
      const answer = await new Promise((res) =>
        rl.question('📱 Tu número de WhatsApp (ej. 5491122334455)\n> ', res)
      )
      const clean = String(answer).replace(/\D/g, '')
      if (clean.length >= 8 && clean.length <= 15) {
        cfg.phoneNumber = clean
        await saveConfig(cfg)
        console.log(`\n✅ Número guardado: +${clean}`)
        console.log('   Ahora aparecerá el código para vincular WhatsApp.\n')
        return clean
      }
      console.log('❌ Número inválido. Escribe solo dígitos, con código de país (8 a 15 dígitos).\n')
    }
  } finally {
    rl.close()
  }
}

async function writePairingCode(phone, code) {
  try {
    await writeFile(
      PAIRING_PATH,
      JSON.stringify({ phone, code, createdAt: new Date().toISOString() }, null, 2)
    )
  } catch {}
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
  console.log('   ⏱  Usa SOLO el código más reciente de la terminal')
  console.log('      (vence en ~1-2 min. Enter = código nuevo).')
  console.log('   🔌 Mantén el bot encendido mientras vinculas.')
  console.log(`${line}\n`)
}

async function requestNewPairingCode() {
  const sock = currentSock
  if (!sock) {
    console.error('❌ El bot no está conectado. Inícialo con: npm start')
    return false
  }
  if (sock.authState.creds.registered) {
    console.log('✅ El bot ya está vinculado a WhatsApp.')
    return false
  }
  pairingRequested = false
  if (requestPairingExternal) {
    await requestPairingExternal()
    return true
  }
  const cfg = await loadConfig()
  if (!cfg.phoneNumber) {
    console.error('❌ No hay número configurado. Ejecuta: npm run setup')
    return false
  }
  try {
    const code = await sock.requestPairingCode(cfg.phoneNumber)
    await writePairingCode(cfg.phoneNumber, code)
    printPairingBanner(cfg.phoneNumber, code)
    return true
  } catch (e) {
    console.error('⚠️', e?.message || e)
    return false
  }
}

let currentSock = null
let pairingRequested = false
let requestPairingExternal = null
let reconnectTries = 0
let lastOpenAt = 0

async function startBot() {
  await ensureMediaCacheLoaded()
  const cfg = await loadConfig()
  const phoneNumber = cfg.phoneNumber
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: process.env.LOG_LEVEL || 'silent' }),
    browser: Browsers.macOS('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    emitOwnEvents: false,
  })
  currentSock = sock
  pairingRequested = false
  let closed = false

  sock.ev.on('creds.update', saveCreds)

  const requestPairing = async () => {
    if (pairingRequested || sock.authState.creds.registered || !phoneNumber) return
    pairingRequested = true
    try {
      const code = await sock.requestPairingCode(phoneNumber)
      await writePairingCode(phoneNumber, code)
      printPairingBanner(phoneNumber, code)
    } catch (err) {
      pairingRequested = false
      console.error('⚠️  No se pudo generar el código de vinculación:', err?.message || err)
    }
  }
  requestPairingExternal = requestPairing

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u
    if (qr && !sock.authState.creds.registered) {
      requestPairing()
    }
    if (connection === 'open') {
      lastOpenAt = Date.now()
      try {
        unlinkSync(PAIRING_PATH)
      } catch {}
      console.log('✅ Conectado a WhatsApp.')
      console.log(
        '📩 Pega un enlace de Facebook, Instagram o X en cualquier chat privado y el bot responderá con la vista previa.\n'
      )
      console.log(
        '🔑 Palabras clave: *.clave palabra* → responde a una foto/video/audio (incl. ver una sola vez) ' +
          'con la palabra y te llegará solo a tu chat privado. Lista: *.claves*\n'
      )
    }
    if (connection === 'close') {
      if (sock !== currentSock || closed) return
      closed = true
      const code = lastDisconnect?.error?.output?.statusCode
      const reason = lastDisconnect?.error?.message || ''
      if (code === DisconnectReason.loggedOut && sock.authState.creds.registered) {
        console.error('❌ Sesión cerrada (logout). Elimina la carpeta auth/ y vuelve a vincular.')
        process.exit(1)
      }
      currentSock = null
      sock.ev.removeAllListeners('connection.update')
      sock.ev.removeAllListeners('messages.upsert')
      sock.ev.removeAllListeners('messaging-history.set')
      try {
        sock.end(undefined)
      } catch {}
      if (isNetworkClose(code, reason) && !netTimer) {
        waitForInternet()
        return
      }
      if (lastOpenAt && Date.now() - lastOpenAt > 20000) reconnectTries = 0
      if (!sock.authState.creds.registered && reconnectTries >= 8) {
        console.error('❌ No se pudo vincular tras varios intentos (cierre:', code, reason, ')')
        process.exit(1)
      }
      reconnectTries++
      if (reconnectTries > 8) {
        console.error(
          `❌ Demasiados intentos de reconexión (cierre: ${code ?? 'desconocido'} ${reason}). Revisa tu conexión o que no haya otra instancia del bot abierta.`
        )
        process.exit(1)
      }
      if (code === DisconnectReason.connectionReplaced) {
        console.error(
          '⚠️  WhatsApp reemplazó esta conexión: hay OTRA instancia del bot usando la misma sesión. Cierra las demás.'
        )
      }
      const delay = code === DisconnectReason.connectionReplaced
        ? Math.min(30000, 10000 * reconnectTries)
        : Math.min(30000, 2000 * reconnectTries)
      console.log(
        `🔁 Conexión cerrada (código ${code ?? 'desconocido'}). Reconectando en ${delay / 1000}s…`
      )
      setTimeout(() => {
        startBot().catch((e) => {
          console.error('Error al reconectar:', e?.message || e)
          process.exit(1)
        })
      }, delay)
    }
  })

  sock.ev.on('messaging-history.set', ({ messages }) => {
    let count = 0
    for (const m of messages || []) {
      if (rememberMediaMessage(m)) count++
    }
    if (count) console.log(`🗂️ ${count} medio(s) recordado(s) desde el historial.`)
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' || sock !== currentSock) return
    console.log(`📨 Mensaje entrante (${messages.length}, tipo ${getContentType(messages[0]?.message) || 'desconocido'})`)
    for (const msg of messages) {
      try {
        await processMessage(sock, msg)
      } catch (err) {
        console.error('Error procesando mensaje:', err?.message || err)
      }
    }
    console.log('✔️  Mensaje procesado.')
  })

  return sock
}

function acquireLock() {
  try {
    const data = JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
    if (data.pid && data.pid !== process.pid) {
      let alive = false
      try {
        process.kill(data.pid, 0)
        alive = true
      } catch {}
      if (alive) {
        let cmd = ''
        try {
          cmd = readFileSync(`/proc/${data.pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
        } catch {}
        if (/index\.js|node/.test(cmd)) {
          console.error(`❌ Ya hay otra instancia del bot corriendo (PID ${data.pid}).`)
          console.error('   Ciérrala antes de iniciar otra: dos instancias provocan el error 440 de WhatsApp.')
          process.exit(1)
        }
      }
    }
  } catch {}
  writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
}

function releaseLock() {
  flushMediaCacheSync()
  try {
    const data = JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
    if (data.pid === process.pid) unlinkSync(LOCK_PATH)
  } catch {}
}

async function main() {
  if (process.argv.includes('--setup')) {
    const cfg = await loadConfig()
    cfg.phoneNumber = ''
    await ensurePhone(cfg)
    console.log('\n✅ Número guardado. Ahora inicia el bot con: npm start\n')
    return
  }

  process.on('SIGUSR1', () => {
    requestNewPairingCode().catch((e) => console.error('⚠️', e?.message || e))
  })

  acquireLock()
  process.on('exit', releaseLock)
  process.on('SIGINT', () => {
    console.error('\n🛑 SIGINT recibido, cerrando…')
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    console.error('\n🛑 SIGTERM recibido, cerrando…')
    process.exit(0)
  })
  process.on('SIGHUP', () => {
    console.error('\n🛑 SIGHUP recibido, cerrando…')
    process.exit(0)
  })
  process.on('beforeExit', (code) => {
    console.error('⚠️  El proceso se quedó sin tareas activas (beforeExit, código', code, ')')
  })
  process.on('uncaughtException', (err) => {
    console.error('💥 Excepción no capturada:', err)
    process.exit(1)
  })
  process.on('unhandledRejection', (err) => {
    console.error('💥 Promesa rechazada sin manejar:', err)
  })

  await mkdir(DL_DIR, { recursive: true })
  await mkdir(AUTH_DIR, { recursive: true })

  const cfg = await loadConfig()
  await ensurePhone(cfg)

  console.log('\n🚀 Iniciando bot de WhatsApp…')
  if (existsSync(COOKIES_PATH)) {
    console.log('🍪 Se usarán cookies de cookies.txt para plataformas que lo requieren.')
  }

  await startBot()

  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  rl.on('line', (line) => {
    const cmd = line.trim().toLowerCase()
    if (cmd === 'exit' || cmd === 'salir') {
      console.log('👋 Saliendo…')
      process.exit(0)
    }
    const sock = currentSock
    if (sock && !sock.authState.creds.registered) {
      requestNewPairingCode().catch((e) => console.error('⚠️', e?.message || e))
    }
  })

  console.log('⌨️  Escribe "exit" para salir, o Enter para pedir un código nuevo si aún no vinculas.')
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  main().catch((e) => {
    console.error('Error fatal:', e)
    process.exit(1)
  })
}

export {
  fmtBytes,
  fmtDur,
  classify,
  extractUrls,
  getText,
  estimateSize,
  fetchInfo,
  buildSizePlans,
  downloadAndConvert,
  videoCodec,
  processMessage,
  buildExifPayload,
  textHasKeyword,
  quotedMediaType,
  norm,
  cleanErr,
  YES,
  NO,
}
