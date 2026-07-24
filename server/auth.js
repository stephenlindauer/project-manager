import crypto from 'node:crypto'
import fs from 'node:fs'
import { config } from './config.js'

/**
 * Optional single-user authentication.
 *
 * Everything sensitive lives behind /api, /events and the /pty WebSocket, so
 * guarding those three is enough — the static client bundle carries no secrets
 * and simply shows a login form when the API answers 401.
 *
 * Credentials live in an auth file created by `scripts/create-user.js`:
 *   { username, salt, hash, secret }   (all hex except username)
 * `hash` is scrypt(password, salt); `secret` is the HMAC key that signs session
 * cookies. The file never leaves disk and is gitignored.
 */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }
const COOKIE = 'pm_session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

let store = null // { username, salt, hash, secret } or null when unconfigured

/** (Re)load the auth file. Returns true if a usable credential is present. */
export function loadAuth() {
  store = null
  if (!config.auth.enabled) return false
  try {
    const raw = JSON.parse(fs.readFileSync(config.auth.file, 'utf8'))
    if (raw?.username && raw?.salt && raw?.hash && raw?.secret) store = raw
  } catch { /* missing or malformed — treated as unconfigured below */ }
  return Boolean(store)
}

export const isEnabled = () => config.auth.enabled
export const isConfigured = () => Boolean(store)

function scrypt(password, saltHex) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, Buffer.from(saltHex, 'hex'), SCRYPT.keylen,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
      (err, dk) => (err ? reject(err) : resolve(dk.toString('hex'))))
  })
}

/** Timing-safe equality that tolerates length differences. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) {
    // Still run a comparison to keep timing flat, then fail.
    crypto.timingSafeEqual(ba, ba)
    return false
  }
  return crypto.timingSafeEqual(ba, bb)
}

export async function verifyCredentials(username, password) {
  if (!store) return false
  const derived = await scrypt(String(password ?? ''), store.salt)
  // Compare both fields; evaluate both to avoid short-circuit timing leaks.
  const okUser = safeEqual(username ?? '', store.username)
  const okPass = safeEqual(derived, store.hash)
  return okUser && okPass
}

// ---- session cookies: base64url(payload).hmac ------------------------------

function sign(payloadB64) {
  return crypto.createHmac('sha256', Buffer.from(store.secret, 'hex'))
    .update(payloadB64).digest('base64url')
}

export function issueToken(username) {
  const payload = Buffer.from(JSON.stringify({ u: username, iat: Date.now() }))
    .toString('base64url')
  return `${payload}.${sign(payload)}`
}

function verifyToken(token) {
  if (!store || typeof token !== 'string' || !token.includes('.')) return null
  const [payloadB64, mac] = token.split('.')
  if (!safeEqual(mac, sign(payloadB64))) return null
  try {
    const { u, iat } = JSON.parse(Buffer.from(payloadB64, 'base64url').toString())
    if (!iat || Date.now() - iat > SESSION_TTL_MS) return null
    if (!safeEqual(u, store.username)) return null
    return { username: u }
  } catch { return null }
}

function parseCookies(header = '') {
  const out = {}
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

/** True if the request carries a valid session cookie. */
export function isRequestAuthed(req) {
  const token = parseCookies(req.headers?.cookie)[COOKIE]
  return Boolean(verifyToken(token))
}

export function sessionCookie(username, { secure }) {
  const attrs = [
    `${COOKIE}=${issueToken(username)}`,
    'HttpOnly', 'Path=/', 'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ]
  if (secure) attrs.push('Secure')
  return attrs.join('; ')
}

export const clearCookie = () =>
  `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`

/**
 * Express middleware guarding the API. A no-op when auth is disabled; returns
 * 401 (never a redirect) so the SPA can render its own login screen.
 */
export function requireAuth(req, res, next) {
  if (!config.auth.enabled) return next()
  if (!store) {
    return res.status(503).json({ error: 'auth is enabled but no user is configured' })
  }
  if (isRequestAuthed(req)) return next()
  res.status(401).json({ error: 'authentication required' })
}
