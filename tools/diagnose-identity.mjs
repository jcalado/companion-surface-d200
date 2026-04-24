#!/usr/bin/env node
/**
 * Diagnose why a D200 is reporting itself as a different device type
 * (e.g. "Dial" instead of "D200") and/or losing its ADB interface
 * a few seconds after switching to ADB mode.
 *
 * Strategy:
 *   1. Send HID 0xFF to switch USB gadget to ADB.
 *   2. Poll `adb get-state` in a tight loop.
 *   3. The instant ADB enumerates, send SIGSTOP to zkgui so it cannot
 *      re-assert sys.usb.config back to "hid" via its supervisor.
 *   4. Capture identity-relevant files, the writable property store,
 *      and small partitions (config / MISC / data).
 *
 * Read-only on the device. No partitions are written.
 *
 * Usage:
 *   node tools/diagnose-identity.mjs                # full run
 *   node tools/diagnose-identity.mjs --skip-adb     # already in ADB mode
 *   node tools/diagnose-identity.mjs --no-freeze    # don't SIGSTOP zkgui
 *   node tools/diagnose-identity.mjs -o ./mydump    # custom output dir
 *
 * Windows: launch via `tools\\diagnose.bat` which just wraps `node`.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const VID = 0x2207
const PID = 0x0019
const INTERFACE = 0
const PACKET_SIZE = 1024

// Small partitions worth dumping for identity analysis (skip the big ones).
const PARTITIONS = [
  { name: 'config', mtd: 4 },
  { name: 'MISC', mtd: 5 },
  { name: 'data', mtd: 6 },
]

const FILES = [
  '/etc/build.prop',
  '/etc/init.rc',
  '/config/board.ini',
  '/config/mmap.ini',
  '/config/PQConfig.ini',
  '/config/model/Customer.ini',
  '/res/etc/EasyUI.cfg',
  '/data/preferences.json',
]

// Best-effort dirs to recursively pull (small, rw, may hold model overrides).
const DIRS = ['/data/property', '/data/local', '/config/model']

// Shell commands to capture into named text files.
const COMMANDS = {
  'proc_mtd.txt': 'cat /proc/mtd',
  'proc_cmdline.txt': 'cat /proc/cmdline',
  'proc_cpuinfo.txt': 'cat /proc/cpuinfo',
  'mount.txt': 'mount',
  'ps.txt': 'ps',
  'dmesg.txt': 'dmesg 2>/dev/null',
  'logcat.txt': 'logcat -d 2>/dev/null',
  'getprop.txt': 'getprop 2>/dev/null',
  'iSerial.txt': 'cat /sys/class/zkswe_usb/zkswe0/iSerial 2>/dev/null',
  'usb_state.txt':
    'for f in /sys/class/zkswe_usb/zkswe0/* ; do echo "=== $f ==="; cat "$f" 2>/dev/null; done',
  'res_libzkgui_md5.txt': 'md5sum /res/lib/libzkgui.so 2>/dev/null',
  'res_libzkgui_strings_models.txt':
    "strings /res/lib/libzkgui.so 2>/dev/null | grep -E '^(D100|D100H|D200|D200H|D200X|Dial|Deck)$' | sort -u",
  'res_lib_listing.txt': 'ls -lR /res/lib 2>/dev/null',
  'data_listing.txt': 'ls -lR /data 2>/dev/null',
  'config_listing.txt': 'ls -lR /config 2>/dev/null',
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

const ADB = process.env.ADB || 'adb'

function adb(...args) {
  const result = spawnSync(ADB, args, { encoding: 'utf8', timeout: 60000 })
  if (result.error) throw result.error
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status }
}
function adbShell(cmd) { return adb('shell', cmd) }
function adbPull(remote, local) { return adb('pull', remote, local) }

function isAdbConnected() {
  const { stdout } = adb('devices')
  // Lines after the header like "1234abcd\tdevice"
  return stdout.split('\n').slice(1).some((l) => /\bdevice\b/.test(l))
}

async function waitForAdbFast(timeoutSec = 15) {
  // Tight loop: poll quickly so we can SIGSTOP zkgui before it kills ADB.
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
    console.error('If already in ADB mode, use --skip-adb')
    process.exit(1)
  }

  console.log(`  Found D200 HID: ${info.path}`)
  console.log('  Sending command 0xFF (switch to ADB)...')

  const device = await HID.HIDAsync.open(info.path)
  const pkt = Buffer.alloc(PACKET_SIZE)
  pkt[0] = 0x7c
  pkt[1] = 0x7c
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
  // SIGSTOP all zkgui processes so they cannot re-set sys.usb.config back
  // to "hid" or restart adbd. Read-only side effect; SIGCONT or replug restores.
  const { stdout } = adbShell('pidof zkgui')
  const pids = stdout.trim().split(/\s+/).filter(Boolean)
  if (pids.length === 0) {
    console.log('  zkgui not running (already crashed?). Skipping freeze.')
    return false
  }
  for (const pid of pids) adbShell(`kill -STOP ${pid}`)
  console.log(`  SIGSTOPed zkgui pid(s): ${pids.join(', ')}`)
  return true
}

function dumpPartition(part, outDir) {
  const remote = `/tmp/_diag_mtd${part.mtd}.img`
  const local = path.join(outDir, 'partitions', `mtd${part.mtd}_${part.name}.img`)
  fs.mkdirSync(path.dirname(local), { recursive: true })
  process.stdout.write(`  mtd${part.mtd} ${part.name}...`)
  adbShell(`cat /dev/block/mtdblock${part.mtd} > ${remote}`)
  const { status } = adbPull(remote, local)
  adbShell(`rm -f ${remote}`)
  if (status === 0 && fs.existsSync(local)) {
    console.log(` ${(fs.statSync(local).size / 1024).toFixed(0)} KB`)
  } else {
    console.log(' FAILED')
  }
}

function pullDirRecursive(remoteDir, outDir) {
  const { stdout } = adbShell(`find ${remoteDir} -type f 2>/dev/null`)
  const files = stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  if (files.length === 0) {
    console.log(`  ${remoteDir} (empty or missing)`)
    return
  }
  for (const f of files) {
    const local = path.join(outDir, 'files', f)
    fs.mkdirSync(path.dirname(local), { recursive: true })
    adbPull(f, local)
  }
  console.log(`  ${remoteDir} (${files.length} file${files.length === 1 ? '' : 's'})`)
}

async function main() {
  const args = process.argv.slice(2)
  const skipAdb = args.includes('--skip-adb')
  const noFreeze = args.includes('--no-freeze')
  const outIdx = args.indexOf('-o')
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outDir = outIdx !== -1 && args[outIdx + 1]
    ? path.resolve(args[outIdx + 1])
    : path.resolve(`d200-diagnose-${ts}`)

  console.log('=== Ulanzi D200 Identity Diagnostic ===\n')

  if (!skipAdb) {
    if (isAdbConnected()) {
      console.log('[1/5] ADB already up.')
    } else {
      console.log('[1/5] Switching to ADB mode...')
      await switchToAdb()
      const ok = await waitForAdbFast(15)
      if (!ok) {
        console.error('\nADB never appeared. Try replugging the device, then re-run with --skip-adb after switching by hand.')
        process.exit(1)
      }
    }
  } else {
    console.log('[1/5] Skipping HID switch (--skip-adb).')
    if (!isAdbConnected()) {
      console.error('No ADB device. Plug in / switch first.')
      process.exit(1)
    }
  }

  fs.mkdirSync(outDir, { recursive: true })

  console.log('\n[2/5] Freezing zkgui to keep ADB alive...')
  if (noFreeze) console.log('  Skipped (--no-freeze).')
  else freezeZkgui()

  console.log('\n[3/5] Capturing shell command output...')
  for (const [file, cmd] of Object.entries(COMMANDS)) {
    const { stdout, stderr } = adbShell(cmd)
    fs.writeFileSync(path.join(outDir, file), stdout + (stderr ? `\n--stderr--\n${stderr}` : ''))
    console.log(`  ${file}`)
  }

  console.log('\n[4/5] Pulling identity files...')
  for (const remote of FILES) {
    const local = path.join(outDir, 'files', remote)
    fs.mkdirSync(path.dirname(local), { recursive: true })
    const { status } = adbPull(remote, local)
    console.log(`  ${remote}${status === 0 ? '' : ' (not found)'}`)
  }
  for (const dir of DIRS) pullDirRecursive(dir, outDir)
  // Pull the on-device libzkgui too for offline strings analysis.
  {
    const local = path.join(outDir, 'files', '/res/lib/libzkgui.so')
    fs.mkdirSync(path.dirname(local), { recursive: true })
    const { status } = adbPull('/res/lib/libzkgui.so', local)
    console.log(`  /res/lib/libzkgui.so${status === 0 ? '' : ' (not found)'}`)
  }

  console.log('\n[5/5] Dumping small partitions (config / MISC / data)...')
  for (const part of PARTITIONS) dumpPartition(part, outDir)

  console.log('\n' + '='.repeat(56))
  console.log(`Diagnostic dump: ${outDir}`)
  console.log('\nKey files to inspect first:')
  console.log('  res_libzkgui_md5.txt              (compare to stock D200: d1226791305669ede8f76764e917980b)')
  console.log('  res_libzkgui_strings_models.txt   (stock D200 prints only "D200")')
  console.log('  files/etc/build.prop              (look for ro.product.* / DeviceType)')
  console.log('  files/config/model/Customer.ini   (per-SKU model identity)')
  console.log('  files/data/property/*             (writable property store)')
  console.log('\nzkgui is SIGSTOPed on the device. Replug to restore normal operation.')
}

main().catch((e) => {
  console.error('Fatal:', e.message)
  process.exit(1)
})
