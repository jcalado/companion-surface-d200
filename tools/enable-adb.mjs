#!/usr/bin/env node
/**
 * Send command 0xFF to the D200 to switch USB gadget to ADB mode.
 *
 * After this, the HID device will disappear and an ADB device should
 * enumerate. Run `adb devices` to check, then `adb shell` for access.
 *
 * To restore normal HID mode: replug the D200.
 */
import HID from 'node-hid'

const VID = 0x2207
const PID = 0x0019
const INTERFACE = 0
const PACKET_SIZE = 1024

function buildPacket(command, payload = '') {
  const buf = Buffer.alloc(PACKET_SIZE)
  buf[0] = 0x7c
  buf[1] = 0x7c
  buf.writeUInt16BE(command, 2)
  const data = Buffer.from(payload, 'utf8')
  buf.writeUInt32LE(data.length, 4)
  data.copy(buf, 8)
  return buf
}

async function main() {
  const devices = await HID.devicesAsync()
  const info = devices.find(
    (d) => d.vendorId === VID && d.productId === PID && d.interface === INTERFACE,
  )
  if (!info) {
    console.error('D200 not found. Is it plugged in?')
    process.exit(1)
  }

  console.log(`Found D200: ${info.path}`)
  console.log('Sending command 0xFF (switch to ADB mode)...')

  const device = await HID.HIDAsync.open(info.path)
  const pkt = buildPacket(0x00ff)
  const buf = Buffer.alloc(PACKET_SIZE + 1)
  buf[0] = 0x00
  pkt.copy(buf, 1)
  await device.write(buf)

  console.log('Sent. HID device will disconnect.')
  console.log('')
  console.log('Wait a few seconds, then run:')
  console.log('  adb devices')
  console.log('  adb shell')
  console.log('')
  console.log('To restore normal mode: replug the D200.')

  // Give it a moment then close
  await new Promise((r) => setTimeout(r, 1000))
  try { await device.close() } catch {}
}

main().catch((e) => {
  console.error('Fatal:', e.message)
  process.exit(1)
})
