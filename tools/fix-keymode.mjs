#!/usr/bin/env node
/**
 * Reset /data/preferences.json on a Ulanzi D200 so that DefKeyMode = 0.
 *
 * Hypothesis (from diagnose-identity dump): the device is being mis-classified
 * as "Dial" in Ulanzi Studio because /data/preferences.json has DefKeyMode: 2,
 * while a stock D200 ships with DefKeyMode: 0. /data is JFFS2 (rw) on mtd6, so
 * this is a fully reversible edit.
 *
 * Steps:
 *   1. (Optional) Send HID 0xFF to switch USB gadget to ADB mode.
 *   2. Tight-poll until ADB enumerates, then SIGSTOP zkgui to keep it alive.
 *   3. Pull /data/preferences.json to ./preferences.backup-<ts>.json
 *   4. Read the existing JSON, change DefKeyMode to 0 (preserving other keys).
 *   5. Push it back to /data/preferences.json and `sync`.
 *   6. Reboot the device.
 *
 * Flags:
 *   --skip-adb        already in ADB mode, don't send 0xFF
 *   --no-reboot       leave the device running (zkgui will stay frozen)
 *   --dry-run         do everything except writing/rebooting
 *   --mode <n>        set DefKeyMode to <n> (default 0)
 *
 * Windows: `tools\\fix-keymode.bat` wraps this and points ADB at the local copy.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const VID = 0x2207
const PID = 0x0019
const INTERFACE = 0
const PACKET_SIZE = 1024

const ADB = process.env.ADB || 'adb'
const SHELL_PRELUDE = 'export PATH=/bin:/sbin:/usr/bin:/usr/sbin:$PATH; '

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function adb(...args) {
  const result = spawnSync(ADB, args, { encoding: 'utf8', timeout: 60000 })
  if (result.error) throw result.error
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status }
}
function adbShell(cmd) { return adb('shell', SHELL_PRELUDE + cmd) }
function adbPull(remote, local) { return adb('pull', remote, local) }
function adbPush(local, remote) { return adb('push', local, remote) }

function isAdbConnected() {
  const { stdout } = adb('devices')
  return stdout.split('\n').slice(1).some((l) => /\bdevice\b/.test(l))
}

async function waitForAdbFast(timeoutSec = 15) {
  const deadline = Date.now() + timeoutSec * 1000
  process.stdout.write('  Waiting for ADB')
  while (Date.now() < deadline) {
    if (isAdbConnected()) {
      console.log(' up!')
      return true
    }
    process.stdout.write('.')
    await sleep(150)
  }
  console.log(' timeout!')
  return false
}

async function switchToAdb() {
  let HID
  try {
    HID = (await import('node-hid')).default
  } catch {
    console.error('node-hid not available. Install deps with: yarn install')
    console.error('Or use --skip-adb if the device is already in ADB mode.')
    process.exit(1)
  }
  const devices = await HID.devicesAsync()
  const info = devices.find(
    (d) => d.vendorId === VID && d.productId === PID && d.interface === INTERFACE,
  )
  if (!info) {
    console.error('D200 HID device not found. Is it plugged in?')
    process.exit(1)
  }
  console.log(`  Found D200 HID: ${info.path}`)
  const device = await HID.HIDAsync.open(info.path)
  const pkt = Buffer.alloc(PACKET_SIZE)
  pkt[0] = 0x7c; pkt[1] = 0x7c
  pkt.writeUInt16BE(0x00ff, 2)
  pkt.writeUInt32LE(0, 4)
  const buf = Buffer.alloc(PACKET_SIZE + 1)
  buf[0] = 0x00
  pkt.copy(buf, 1)
  await device.write(buf)
  await sleep(200)
  try { await device.close() } catch {}
  console.log('  HID released, racing for ADB...')
}

function freezeZkgui() {
  const { stdout } = adbShell(
    `ps 2>/dev/null | awk '$NF ~ "/zkgui$" {print $1}'`,
  )
  const pids = stdout
    .split(/\s+/).map((s) => s.trim())
    .filter((s) => /^[0-9]+$/.test(s))
  if (pids.length === 0) {
    console.log('  zkgui not running. Continuing anyway.')
    return
  }
  for (const pid of pids) adbShell(`kill -STOP ${pid}`)
  console.log(`  SIGSTOPed zkgui pid(s): ${pids.join(', ')}`)
}

async function main() {
  const args = process.argv.slice(2)
  const skipAdb = args.includes('--skip-adb')
  const noReboot = args.includes('--no-reboot')
  const dryRun = args.includes('--dry-run')
  const modeIdx = args.indexOf('--mode')
  const targetMode = modeIdx !== -1 && args[modeIdx + 1] != null
    ? Number(args[modeIdx + 1])
    : 0
  if (!Number.isInteger(targetMode)) {
    console.error('--mode must be an integer')
    process.exit(2)
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const backupPath = path.resolve(`preferences.backup-${ts}.json`)
  const stagedPath = path.resolve(`preferences.staged-${ts}.json`)

  console.log('=== Ulanzi D200: Reset DefKeyMode ===\n')

  if (!skipAdb) {
    if (isAdbConnected()) {
      console.log('[1/6] ADB already up.')
    } else {
      console.log('[1/6] Switching to ADB mode...')
      await switchToAdb()
      const ok = await waitForAdbFast(15)
      if (!ok) {
        console.error('\nADB never appeared. Try replugging, then re-run with --skip-adb.')
        process.exit(1)
      }
    }
  } else {
    console.log('[1/6] Skipping HID switch (--skip-adb).')
    if (!isAdbConnected()) {
      console.error('No ADB device. Plug in / switch first.')
      process.exit(1)
    }
  }

  console.log('\n[2/6] Freezing zkgui...')
  freezeZkgui()

  console.log('\n[3/6] Pulling current /data/preferences.json...')
  const pullRes = adbPull('/data/preferences.json', backupPath)
  if (pullRes.status !== 0 || !fs.existsSync(backupPath)) {
    console.error('  Failed to pull preferences.json:', pullRes.stderr.trim())
    process.exit(1)
  }
  console.log(`  Saved backup: ${backupPath}`)

  const before = fs.readFileSync(backupPath, 'utf8')
  console.log('  Current contents:\n' + before.split('\n').map((l) => '    ' + l).join('\n'))

  let parsed
  try {
    parsed = JSON.parse(before)
  } catch (e) {
    console.error('  Existing preferences.json is not valid JSON:', e.message)
    console.error('  Aborting; nothing changed.')
    process.exit(1)
  }
  const previous = parsed.DefKeyMode
  if (previous === targetMode) {
    console.log(`\n  DefKeyMode is already ${targetMode}. Nothing to do.`)
    if (!noReboot && !dryRun) {
      console.log('  Rebooting anyway to clear any in-memory state.')
      adbShell('reboot')
    }
    return
  }

  parsed.DefKeyMode = targetMode
  const after = JSON.stringify(parsed, null, 3) + '\n'
  fs.writeFileSync(stagedPath, after)
  console.log(`\n[4/6] New contents staged at ${stagedPath} (DefKeyMode: ${previous} -> ${targetMode}):`)
  console.log(after.split('\n').map((l) => '    ' + l).join('\n'))

  if (dryRun) {
    console.log('\nDry run requested; not pushing or rebooting.')
    return
  }

  console.log('[5/6] Pushing replacement and syncing...')
  const pushRes = adbPush(stagedPath, '/data/preferences.json')
  if (pushRes.status !== 0) {
    console.error('  Push failed:', pushRes.stderr.trim())
    console.error('  Backup is still safe at:', backupPath)
    process.exit(1)
  }
  adbShell('sync')
  // Verify by re-pulling.
  const verifyPath = path.resolve(`preferences.verify-${ts}.json`)
  adbPull('/data/preferences.json', verifyPath)
  const verified = fs.readFileSync(verifyPath, 'utf8')
  if (verified.trim() !== after.trim()) {
    console.error('  Verification failed. Read-back differs from staged content.')
    console.error('  Backup at:', backupPath)
    process.exit(1)
  }
  fs.unlinkSync(verifyPath)
  console.log('  Verified read-back matches.')

  if (noReboot) {
    console.log('\n[6/6] Skipping reboot (--no-reboot). zkgui is still SIGSTOPed.')
    console.log('       Replug the device when ready.')
  } else {
    console.log('\n[6/6] Rebooting device...')
    adbShell('reboot')
  }

  console.log('\nDone. To revert:')
  console.log(`  ${ADB} push "${backupPath}" /data/preferences.json && ${ADB} shell sync && ${ADB} shell reboot`)
}

main().catch((e) => {
  console.error('Fatal:', e.message)
  process.exit(1)
})
