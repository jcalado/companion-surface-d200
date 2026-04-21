#!/usr/bin/env node
/**
 * Patch the D200 res partition (mtd3) with modified assets.
 *
 * Workflow:
 *   1. extract   — Dump and extract the current res partition via ADB
 *   2. (manual)  — Edit files in the extracted directory
 *   3. build     — Repack to SquashFS
 *   4. flash     — Back up current partition and write the new image
 *
 * Usage:
 *   node tools/patch-res.mjs extract                    # step 1
 *   node tools/patch-res.mjs extract --skip-adb         # already in ADB mode
 *   # ... edit files in ./res-workspace/modified/ ...
 *   node tools/patch-res.mjs build                      # step 3
 *   node tools/patch-res.mjs flash                      # step 4 (needs ADB)
 *   node tools/patch-res.mjs flash --skip-adb           # already in ADB mode
 *
 *   node tools/patch-res.mjs all                        # extract + build + flash in one go
 *                                                       #  (opens $EDITOR or pauses for edits)
 *
 *   -w ./my-workspace    custom workspace directory (default: ./res-workspace)
 */
import { execSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const VID = 0x2207
const PID = 0x0019
const INTERFACE = 0
const PACKET_SIZE = 1024
const MTD_RES = 3
const MTD_RES_MAX_BYTES = 5 * 1024 * 1024 // 5MB partition limit
const SQFS_BLOCK_SIZE = 131072 // 128KB, matches original

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function run(cmd, opts = {}) {
  return spawnSync('sh', ['-c', cmd], { encoding: 'utf8', timeout: 60000, ...opts })
}

function adb(...args) {
  const result = spawnSync('adb', args, { encoding: 'utf8', timeout: 30000 })
  if (result.error) throw result.error
  return result
}

function adbShell(cmd) {
  return adb('shell', cmd)
}

function isAdbConnected() {
  const { stdout } = adb('devices')
  const lines = stdout.trim().split('\n').slice(1)
  return lines.some((l) => l.includes('device'))
}

async function waitForAdb(timeoutSec = 20) {
  const deadline = Date.now() + timeoutSec * 1000
  process.stdout.write('  Waiting for ADB')
  while (Date.now() < deadline) {
    if (isAdbConnected()) {
      console.log(' connected!')
      return true
    }
    process.stdout.write('.')
    await sleep(1000)
  }
  console.log(' timeout!')
  return false
}

async function ensureAdb(skipAdb) {
  if (isAdbConnected()) return

  if (skipAdb) {
    console.error('No ADB device found. Connect the device or remove --skip-adb.')
    process.exit(1)
  }

  console.log('  Switching to ADB mode...')
  let HID
  try {
    HID = (await import('node-hid')).default
  } catch {
    console.error('node-hid not available. Use --skip-adb if device is already in ADB mode.')
    process.exit(1)
  }

  const devices = await HID.devicesAsync()
  const info = devices.find(
    (d) => d.vendorId === VID && d.productId === PID && d.interface === INTERFACE,
  )
  if (!info) {
    console.error('D200 HID device not found.')
    process.exit(1)
  }

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

  const found = await waitForAdb()
  if (!found) {
    console.error('Device did not appear as ADB.')
    process.exit(1)
  }
}

async function cmdExtract(workspace, skipAdb) {
  console.log('=== Extract res partition ===\n')

  await ensureAdb(skipAdb)

  const originalDir = path.join(workspace, 'original')
  const modifiedDir = path.join(workspace, 'modified')
  const backupImg = path.join(workspace, 'backup_mtd3_res.img')

  fs.mkdirSync(workspace, { recursive: true })

  // Dump partition
  console.log('  Dumping mtd3 (res)...')
  adbShell(`cat /dev/block/mtdblock${MTD_RES} > /tmp/_res_dump.img`)
  adb('pull', '/tmp/_res_dump.img', backupImg)
  adbShell('rm /tmp/_res_dump.img')

  const imgSize = fs.statSync(backupImg).size
  console.log(`  Backed up: ${backupImg} (${(imgSize / 1024 / 1024).toFixed(2)} MB)`)

  // Verify it's SquashFS
  const { stdout: fileType } = run(`file "${backupImg}"`)
  if (!fileType.includes('Squashfs')) {
    console.error(`  ERROR: Dump does not look like SquashFS: ${fileType.trim()}`)
    process.exit(1)
  }

  // Extract original
  console.log('  Extracting to original/...')
  if (fs.existsSync(originalDir)) fs.rmSync(originalDir, { recursive: true })
  run(`unsquashfs -d "${originalDir}" -f "${backupImg}"`)

  // Create working copy
  console.log('  Creating working copy in modified/...')
  if (fs.existsSync(modifiedDir)) fs.rmSync(modifiedDir, { recursive: true })
  run(`cp -a "${originalDir}" "${modifiedDir}"`)

  console.log(`
Done. Edit files in:
  ${modifiedDir}/

Examples:
  # Replace the idle wallpaper
  cp my-wallpaper.jpg ${modifiedDir}/ui/icon/wallpaper.jpg

  # Replace a default button icon (196x196 PNG)
  cp my-icon.png ${modifiedDir}/ui/default/Images/calc.png

  # Replace the app library (advanced)
  cp patched-libzkgui.so ${modifiedDir}/lib/libzkgui.so

Then run:
  node tools/patch-res.mjs build
  node tools/patch-res.mjs flash
`)
}

function cmdBuild(workspace) {
  console.log('=== Build patched res image ===\n')

  const modifiedDir = path.join(workspace, 'modified')
  const outputImg = path.join(workspace, 'patched_res.img')
  const backupImg = path.join(workspace, 'backup_mtd3_res.img')

  if (!fs.existsSync(modifiedDir)) {
    console.error(`  Modified directory not found: ${modifiedDir}`)
    console.error('  Run "extract" first.')
    process.exit(1)
  }

  // Get original image params for reference
  if (fs.existsSync(backupImg)) {
    const { stdout } = run(`unsquashfs -s "${backupImg}" 2>&1`)
    console.log('  Original image stats:')
    for (const line of stdout.split('\n')) {
      if (line.match(/size|block|compress|inode/i)) {
        console.log(`    ${line.trim()}`)
      }
    }
    console.log()
  }

  // Build new SquashFS
  console.log('  Building SquashFS...')
  if (fs.existsSync(outputImg)) fs.unlinkSync(outputImg)

  const { status, stderr } = run(
    `mksquashfs "${modifiedDir}" "${outputImg}" ` +
    `-comp xz -b ${SQFS_BLOCK_SIZE} -no-xattrs -all-root -noappend`,
  )

  if (status !== 0) {
    console.error(`  mksquashfs failed:\n${stderr}`)
    process.exit(1)
  }

  const newSize = fs.statSync(outputImg).size
  const origSize = fs.existsSync(backupImg) ? fs.statSync(backupImg).size : 0

  console.log(`  Output: ${outputImg}`)
  console.log(`  Size: ${(newSize / 1024 / 1024).toFixed(2)} MB`)

  if (origSize > 0) {
    const delta = newSize - origSize
    const sign = delta >= 0 ? '+' : ''
    console.log(`  Delta: ${sign}${(delta / 1024).toFixed(1)} KB vs original`)
  }

  if (newSize > MTD_RES_MAX_BYTES) {
    console.error(`\n  ERROR: Image too large! ${newSize} > ${MTD_RES_MAX_BYTES} (5MB partition limit)`)
    console.error('  Remove files or use smaller assets to fit.')
    process.exit(1)
  }

  // Pad to partition size (mtd writes need exact size or the device pads with 0xFF)
  // Actually, SquashFS doesn't need padding; the device reads only bytes_used.
  // But we need to make sure it's not too big.

  console.log('\n  Image is within partition limits. Ready to flash.')
  console.log(`  Run: node tools/patch-res.mjs flash`)
}

async function cmdFlash(workspace, skipAdb) {
  console.log('=== Flash patched res image ===\n')

  const patchedImg = path.join(workspace, 'patched_res.img')
  const backupImg = path.join(workspace, 'backup_mtd3_res.img')

  if (!fs.existsSync(patchedImg)) {
    console.error(`  Patched image not found: ${patchedImg}`)
    console.error('  Run "build" first.')
    process.exit(1)
  }

  if (!fs.existsSync(backupImg)) {
    console.error('  WARNING: No backup image found. Run "extract" first to create one.')
    process.exit(1)
  }

  const patchedSize = fs.statSync(patchedImg).size
  if (patchedSize > MTD_RES_MAX_BYTES) {
    console.error(`  Image too large: ${patchedSize} bytes > ${MTD_RES_MAX_BYTES}`)
    process.exit(1)
  }

  await ensureAdb(skipAdb)

  // Verify device is a D200
  const { stdout: devInfo } = adbShell('cat /proc/mtd')
  if (!devInfo.includes('"res"')) {
    console.error('  Device does not have expected MTD layout.')
    process.exit(1)
  }

  // Take a fresh backup before flashing
  console.log('  Taking pre-flash backup...')
  const preFlashBackup = path.join(workspace, `pre-flash-backup-${Date.now()}.img`)
  adbShell(`cat /dev/block/mtdblock${MTD_RES} > /tmp/_res_preflash.img`)
  adb('pull', '/tmp/_res_preflash.img', preFlashBackup)
  adbShell('rm /tmp/_res_preflash.img')
  console.log(`  Saved: ${preFlashBackup}`)

  // Push the patched image
  console.log(`  Pushing patched image (${(patchedSize / 1024 / 1024).toFixed(2)} MB)...`)
  adb('push', patchedImg, '/tmp/_patched_res.img')

  // Erase and write mtd3
  // The device has flash_erase in /res/bin/ but /res is what we're writing...
  // Check if mtd-utils are available
  const { stdout: flashTools } = adbShell('ls /sbin/flash_erase /res/bin/flash_erase 2>/dev/null')

  console.log('  Erasing mtd3...')
  let eraseCmd
  if (flashTools.includes('flash_erase')) {
    eraseCmd = `${flashTools.trim().split('\n')[0]} /dev/mtd${MTD_RES} 0 0`
  } else {
    // Fallback: write zeros then write image. Less clean but works.
    // Actually, we can write the block device directly on NOR flash.
    console.log('  (no flash_erase found, writing directly to block device)')
    eraseCmd = null
  }

  if (eraseCmd) {
    const { stdout: eraseOut, stderr: eraseErr } = adbShell(eraseCmd)
    if (eraseErr && eraseErr.includes('error')) {
      console.error(`  Erase failed: ${eraseErr}`)
      console.error('  Aborting. Your backup is safe at:', preFlashBackup)
      process.exit(1)
    }
    console.log('  Erased.')
  }

  console.log('  Writing patched image to mtd3...')
  // Use cat to write to the mtd char device (supports partial writes)
  const { stderr: writeErr } = adbShell(
    `cat /tmp/_patched_res.img > /dev/mtd${MTD_RES}`
  )

  // Verify by reading back
  console.log('  Verifying...')
  adbShell(`cat /dev/block/mtdblock${MTD_RES} > /tmp/_res_verify.img`)
  adb('pull', '/tmp/_res_verify.img', path.join(workspace, '_verify.img'))

  const verifyBuf = fs.readFileSync(path.join(workspace, '_verify.img'))
  const patchedBuf = fs.readFileSync(patchedImg)

  // Compare only the bytes we wrote (partition may be larger)
  const match = verifyBuf.subarray(0, patchedBuf.length).equals(patchedBuf)

  adbShell('rm /tmp/_patched_res.img /tmp/_res_verify.img /tmp/_res_preflash.img 2>/dev/null')
  fs.unlinkSync(path.join(workspace, '_verify.img'))

  if (match) {
    console.log('  Verification PASSED.')
    console.log('\n  Flash complete! Replug the D200 to boot with the new assets.')
    console.log(`  To restore the original: node tools/patch-res.mjs restore -w "${workspace}"`)
  } else {
    console.error('  Verification FAILED! Written data does not match.')
    console.error(`  Your backup is at: ${preFlashBackup}`)
    console.error('  To restore: node tools/patch-res.mjs restore')
    process.exit(1)
  }
}

async function cmdRestore(workspace, skipAdb) {
  console.log('=== Restore original res partition ===\n')

  const backupImg = path.join(workspace, 'backup_mtd3_res.img')
  if (!fs.existsSync(backupImg)) {
    console.error(`  Backup not found: ${backupImg}`)
    process.exit(1)
  }

  await ensureAdb(skipAdb)

  console.log(`  Pushing backup (${(fs.statSync(backupImg).size / 1024 / 1024).toFixed(2)} MB)...`)
  adb('push', backupImg, '/tmp/_res_restore.img')

  const { stdout: flashTools } = adbShell('ls /sbin/flash_erase /res/bin/flash_erase 2>/dev/null')
  if (flashTools.includes('flash_erase')) {
    console.log('  Erasing mtd3...')
    adbShell(`${flashTools.trim().split('\n')[0]} /dev/mtd${MTD_RES} 0 0`)
  }

  console.log('  Writing backup to mtd3...')
  adbShell(`cat /tmp/_res_restore.img > /dev/mtd${MTD_RES}`)
  adbShell('rm /tmp/_res_restore.img')

  console.log('  Restored. Replug the D200 to boot with original firmware.')
}

async function main() {
  const args = process.argv.slice(2)
  const command = args.find((a) => !a.startsWith('-'))
  const skipAdb = args.includes('--skip-adb')
  const wIdx = args.indexOf('-w')
  const workspace = wIdx !== -1 && args[wIdx + 1]
    ? path.resolve(args[wIdx + 1])
    : path.resolve('res-workspace')

  switch (command) {
    case 'extract':
      await cmdExtract(workspace, skipAdb)
      break

    case 'build':
      cmdBuild(workspace)
      break

    case 'flash':
      await cmdFlash(workspace, skipAdb)
      break

    case 'restore':
      await cmdRestore(workspace, skipAdb)
      break

    case 'all': {
      await cmdExtract(workspace, skipAdb)
      console.log('=== Pausing for edits ===')
      console.log(`Edit files in: ${path.join(workspace, 'modified')}/`)
      console.log('Press Enter when ready to build and flash...')
      await new Promise((resolve) => {
        process.stdin.once('data', resolve)
      })
      cmdBuild(workspace)
      await cmdFlash(workspace, skipAdb)
      break
    }

    default:
      console.log(`Usage: node tools/patch-res.mjs <command> [options]

Commands:
  extract     Dump and extract the res partition from the device
  build       Repack the modified directory into a SquashFS image
  flash       Write the patched image to the device (backs up first)
  restore     Write the original backup back to the device
  all         Extract, pause for edits, build, and flash

Options:
  --skip-adb  Device is already in ADB mode (skip HID switch)
  -w <dir>    Workspace directory (default: ./res-workspace)

Workflow:
  1. node tools/patch-res.mjs extract
  2. Edit files in ./res-workspace/modified/
     - Replace icons: cp my-icon.png ./res-workspace/modified/ui/default/Images/calc.png
     - Replace wallpaper: cp bg.jpg ./res-workspace/modified/ui/icon/wallpaper.jpg
  3. node tools/patch-res.mjs build
  4. node tools/patch-res.mjs flash
  5. Replug the D200

To undo:
  node tools/patch-res.mjs restore
`)
      break
  }
}

main().catch((e) => {
  console.error('Fatal:', e.message)
  process.exit(1)
})
