#!/usr/bin/env node
/**
 * Dump firmware from a connected Ulanzi D200.
 *
 * Switches the device to ADB mode (command 0xFF), waits for it to enumerate,
 * then dumps all MTD partitions and key files. Outputs to a timestamped
 * directory.
 *
 * Usage:
 *   node tools/dump-firmware.mjs                  # full dump
 *   node tools/dump-firmware.mjs --skip-adb       # already in ADB mode
 *   node tools/dump-firmware.mjs --partitions-only # just MTD dumps, no file pulls
 *   node tools/dump-firmware.mjs -o ./my-dump      # custom output directory
 */
import { execSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const VID = 0x2207
const PID = 0x0019
const INTERFACE = 0
const PACKET_SIZE = 1024

const MTD_PARTITIONS = [
  { name: 'BOOT0', mtd: 0, size: '320KB' },
  { name: 'KERNEL', mtd: 1, size: '1.7MB' },
  { name: 'rootfs', mtd: 2, size: '7.25MB' },
  { name: 'res', mtd: 3, size: '5MB' },
  { name: 'config', mtd: 4, size: '576KB' },
  { name: 'MISC', mtd: 5, size: '512KB' },
  { name: 'data', mtd: 6, size: '4MB' },
  { name: 'UDISK', mtd: 7, size: '12.7MB' },
]

const KEY_FILES = [
  '/res/lib/libzkgui.so',
  '/res/etc/EasyUI.cfg',
  '/res/ui/default/manifest0.json',
  '/res/ui/default/manifest1.json',
  '/res/ui/default/manifest2.json',
  '/res/ui/default/manifest3.json',
  '/res/ui/main.ftu',
  '/res/ui/icon/wallpaper.jpg',
  '/data/preferences.json',
  '/lib/libeasyui.so',
  '/lib/libinternalapp.so',
  '/bin/zkgui',
  '/etc/init.rc',
  '/etc/build.prop',
]

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function adb(...args) {
  const result = spawnSync('adb', args, { encoding: 'utf8', timeout: 30000 })
  if (result.error) throw result.error
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

function adbShell(cmd) {
  return adb('shell', cmd)
}

function adbPull(remote, local) {
  return adb('pull', remote, local)
}

function isAdbConnected() {
  const { stdout } = adb('devices')
  return stdout.includes('device') && !stdout.trim().endsWith('List of devices attached')
}

async function waitForAdb(timeoutSec = 30) {
  const deadline = Date.now() + timeoutSec * 1000
  process.stdout.write('  Waiting for ADB device')
  while (Date.now() < deadline) {
    if (isAdbConnected()) {
      console.log(' found!')
      return true
    }
    process.stdout.write('.')
    await sleep(1000)
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
  await sleep(500)
  try { await device.close() } catch {}

  console.log('  HID device released, waiting for ADB enumeration...')
}

async function main() {
  const args = process.argv.slice(2)
  const skipAdb = args.includes('--skip-adb')
  const partitionsOnly = args.includes('--partitions-only')
  const outIdx = args.indexOf('-o')
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

  let outDir
  if (outIdx !== -1 && args[outIdx + 1]) {
    outDir = path.resolve(args[outIdx + 1])
  } else {
    outDir = path.resolve(`d200-dump-${timestamp}`)
  }

  console.log('=== Ulanzi D200 Firmware Dump ===\n')

  // Step 1: Get into ADB mode
  if (!skipAdb) {
    if (isAdbConnected()) {
      console.log('[1/4] ADB already connected, skipping HID switch.')
    } else {
      console.log('[1/4] Switching to ADB mode...')
      await switchToAdb()
      const found = await waitForAdb(20)
      if (!found) {
        console.error('\nDevice did not appear as ADB. Try replugging and using --skip-adb.')
        process.exit(1)
      }
    }
  } else {
    console.log('[1/4] Skipping ADB switch (--skip-adb)')
    if (!isAdbConnected()) {
      console.error('No ADB device found. Connect the device first.')
      process.exit(1)
    }
  }

  // Step 2: Collect device info
  console.log('\n[2/4] Collecting device info...')
  fs.mkdirSync(outDir, { recursive: true })

  const infoCommands = {
    'proc_mtd.txt': 'cat /proc/mtd',
    'proc_cpuinfo.txt': 'cat /proc/cpuinfo',
    'proc_cmdline.txt': 'cat /proc/cmdline',
    'mount.txt': 'mount',
    'ps.txt': 'ps',
    'preferences.json': 'cat /data/preferences.json 2>/dev/null',
  }

  for (const [file, cmd] of Object.entries(infoCommands)) {
    const { stdout } = adbShell(cmd)
    fs.writeFileSync(path.join(outDir, file), stdout)
    console.log(`  ${file}`)
  }

  // Step 3: Dump MTD partitions
  console.log('\n[3/4] Dumping MTD partitions...')
  const mtdDir = path.join(outDir, 'partitions')
  fs.mkdirSync(mtdDir, { recursive: true })

  for (const part of MTD_PARTITIONS) {
    const remotePath = `/tmp/_dump_mtd${part.mtd}.img`
    const localPath = path.join(mtdDir, `mtd${part.mtd}_${part.name}.img`)

    process.stdout.write(`  mtd${part.mtd} ${part.name} (${part.size})...`)
    adbShell(`cat /dev/block/mtdblock${part.mtd} > ${remotePath}`)
    const { status } = adbPull(remotePath, localPath)
    adbShell(`rm ${remotePath}`)

    if (status === 0 && fs.existsSync(localPath)) {
      const size = fs.statSync(localPath).size
      console.log(` ${(size / 1024 / 1024).toFixed(2)} MB`)
    } else {
      console.log(' FAILED')
    }
  }

  // Step 4: Pull key files
  if (!partitionsOnly) {
    console.log('\n[4/4] Pulling key files...')
    const filesDir = path.join(outDir, 'files')

    for (const remotePath of KEY_FILES) {
      const localPath = path.join(filesDir, remotePath)
      fs.mkdirSync(path.dirname(localPath), { recursive: true })

      const { status } = adbPull(remotePath, localPath)
      if (status === 0) {
        console.log(`  ${remotePath}`)
      } else {
        console.log(`  ${remotePath} (not found)`)
      }
    }

    // Pull all default profile images
    const { stdout: iconList } = adbShell('ls /res/ui/default/Images/ 2>/dev/null')
    if (iconList.trim()) {
      const iconsDir = path.join(filesDir, 'res/ui/default/Images')
      fs.mkdirSync(iconsDir, { recursive: true })
      for (const icon of iconList.trim().split('\n')) {
        const name = icon.trim()
        if (name) {
          adbPull(`/res/ui/default/Images/${name}`, path.join(iconsDir, name))
        }
      }
      console.log(`  /res/ui/default/Images/ (${iconList.trim().split('\n').length} files)`)
    }
  } else {
    console.log('\n[4/4] Skipping file pulls (--partitions-only)')
  }

  // Summary
  const totalSize = spawnSync('du', ['-sh', outDir], { encoding: 'utf8' }).stdout.split('\t')[0]
  console.log('\n' + '='.repeat(50))
  console.log(`Dump complete: ${outDir}`)
  console.log(`Total size: ${totalSize}`)
  console.log('\nTo extract SquashFS partitions:')
  console.log(`  unsquashfs -d rootfs ${mtdDir}/mtd2_rootfs.img`)
  console.log(`  unsquashfs -d res ${mtdDir}/mtd3_res.img`)
  console.log(`  unsquashfs -d config ${mtdDir}/mtd4_config.img`)
  console.log('\nTo restore normal HID mode: replug the D200.')
}

main().catch((e) => {
  console.error('Fatal:', e.message)
  process.exit(1)
})
