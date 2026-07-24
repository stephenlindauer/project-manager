#!/usr/bin/env node
/**
 * Create (or replace) the single login credential for ProjectManager.
 *
 * Writes .pm-auth.json (mode 0600, gitignored) containing:
 *   { username, salt, hash, secret }
 * where hash = scrypt(password, salt) and secret is a random key used to sign
 * session cookies. Regenerating the secret invalidates existing sessions.
 *
 * Interactive by default; for scripting, set PM_USER and PM_PASS in the env.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const authFile = process.env.PM_AUTH_FILE || path.join(root, '.pm-auth.json')

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }

function ask(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  return new Promise((resolve) => {
    if (hidden) {
      // Mute echo: intercept the output so typed characters aren't shown.
      const mutableOut = rl.output
      rl._writeToOutput = (str) => {
        if (str.includes(question)) mutableOut.write(str)
        // otherwise swallow the keystroke echo
      }
    }
    rl.question(question, (answer) => {
      if (hidden) rl.output.write('\n')
      rl.close()
      resolve(answer)
    })
  })
}

function hash(password, saltHex) {
  return crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  }).toString('hex')
}

async function main() {
  let username = process.env.PM_USER
  let password = process.env.PM_PASS

  if (!username) username = (await ask('Username: ')).trim()
  if (!username) { console.error('Username is required.'); process.exit(1) }

  if (!password) {
    password = await ask('Password: ', { hidden: true })
    const confirm = await ask('Confirm password: ', { hidden: true })
    if (password !== confirm) { console.error('Passwords do not match.'); process.exit(1) }
  }
  if (!password || password.length < 8) {
    console.error('Password must be at least 8 characters.'); process.exit(1)
  }

  // Preserve the cookie-signing secret across credential changes unless it is
  // missing, so changing a password does not log you out on other devices.
  let secret
  try { secret = JSON.parse(fs.readFileSync(authFile, 'utf8')).secret } catch { /* new */ }
  if (!secret) secret = crypto.randomBytes(32).toString('hex')

  const salt = crypto.randomBytes(16).toString('hex')
  const record = { username, salt, hash: hash(password, salt), secret }

  fs.writeFileSync(authFile, JSON.stringify(record, null, 2), { mode: 0o600 })
  fs.chmodSync(authFile, 0o600) // enforce even if the file pre-existed

  console.log(`\nSaved credential for "${username}" to ${authFile}`)
  console.log('Enable auth by setting "auth": true in pm.config.json (or PM_AUTH=1), then restart.')
}

main().catch((e) => { console.error(e); process.exit(1) })
