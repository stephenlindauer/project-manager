#!/usr/bin/env node
/**
 * Generate a self-signed TLS certificate for local/LAN use.
 *
 * The cert lists localhost, 127.0.0.1, ::1, this machine's hostname and every
 * non-internal IPv4/IPv6 address as Subject Alternative Names, so it validates
 * whether you reach the app at localhost or over the network. Browsers will
 * still warn (it is self-signed) — that is expected; accept it once per device.
 *
 * Output: certs/pm-cert.pem and certs/pm-key.pem. Re-run to regenerate.
 */
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const certDir = path.join(root, 'certs')
const certPath = path.join(certDir, 'pm-cert.pem')
const keyPath = path.join(certDir, 'pm-key.pem')

function localAddresses() {
  const v4 = new Set()
  const v6 = new Set()
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.internal) continue
      // Skip IPv6 link-local (fe80::…) — you don't browse to those, and there
      // are often a dozen of them, which just clutters the certificate.
      if (a.family === 'IPv6' && a.address.toLowerCase().startsWith('fe80')) continue
      ;(a.family === 'IPv4' ? v4 : v6).add(a.address)
    }
  }
  return { v4: [...v4], v6: [...v6] }
}

function main() {
  fs.mkdirSync(certDir, { recursive: true })

  const { v4, v6 } = localAddresses()
  const dns = ['localhost', os.hostname(), `${os.hostname()}.local`]
  const ips = ['127.0.0.1', '::1', ...v4, ...v6]

  const san = [
    ...dns.map((d, i) => `DNS.${i + 1} = ${d}`),
    ...ips.map((ip, i) => `IP.${i + 1} = ${ip}`),
  ].join('\n')

  // A config file (rather than -addext) keeps this working on both OpenSSL and
  // the LibreSSL that ships with macOS.
  const cnf = `
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = ProjectManager
[v3]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @san
[san]
${san}
`.trimStart()

  const cnfPath = path.join(certDir, 'openssl.cnf')
  fs.writeFileSync(cnfPath, cnf)

  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256',
      '-days', '825', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-config', cnfPath,
    ], { stdio: ['ignore', 'ignore', 'inherit'] })
  } catch (err) {
    console.error('\nFailed to run openssl. Is it installed and on PATH?')
    process.exit(1)
  } finally {
    fs.rmSync(cnfPath, { force: true })
  }

  fs.chmodSync(keyPath, 0o600)

  console.log('Generated self-signed certificate:')
  console.log(`  cert  ${certPath}`)
  console.log(`  key   ${keyPath}`)
  console.log('\nValid for these names/addresses:')
  for (const d of dns) console.log(`  ${d}`)
  for (const ip of ips) console.log(`  ${ip}`)
  console.log('\nEnable HTTPS by setting "https": { "enabled": true } in pm.config.json (or PM_HTTPS=1).')
}

main()
