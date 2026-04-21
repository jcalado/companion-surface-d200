#!/usr/bin/env node
/**
 * Fast non-interactive command probe for the Ulanzi D200.
 *
 * Scans a range of command IDs, sending each with an empty payload.
 * Flags commands that produce anything OTHER than a plain ACK (0x010b),
 * or that produce NO response at all (possible crash/hang).
 *
 * Watch the D200 screen while it runs. If anything changes, note the
 * command number shown in the terminal. Ctrl+C to stop.
 *
 * Usage:
 *   node tools/probe-fast.mjs                  # scan 0x0021..0x0100
 *   node tools/probe-fast.mjs 0x0100 0x0200    # custom range
 *   node tools/probe-fast.mjs --with-manifest  # send JSON manifest instead of empty
 */
import HID from 'node-hid'

const VID = 0x2207
const PID = 0x0019
const INTERFACE = 0
const PACKET_SIZE = 1024
const HEADER_SIZE = 8

const SKIP = new Set([
  0x0001, // OUT_SET_BUTTONS
  0x0003, // GET_DEVICE_INFO
  0x0004, // SHUTDOWN (destructive)
  0x0006, // OUT_SET_SMALL_WINDOW_DATA
  0x000a, // OUT_SET_BRIGHTNESS
  0x000b, // OUT_SET_LABEL_STYLE
  0x000d, // OUT_PARTIALLY_UPDATE_BUTTONS
  0x000f, // LOCKSCREEN
  0x0010, // UNLOCKSCREEN
  0x00d0, // GET_DEVICE_INFO (alt, responds on 0x03d0)
  0x00fe, // kills device, needs replug
  0x00ff, // kills device, needs replug
  0x0101, // IN_BUTTON
  0x0303, // IN_DEVICE_INFO
])

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg=='

const MANIFEST = JSON.stringify({
  '0_0': {
    State: 0,
    ViewParam: [
      {
        Font: {
          Align: 'bottom',
          Color: 16777215,
          FontName: 'Source Han Sans SC',
          ShowTitle: true,
          Size: 10,
          Weight: 80,
        },
        Icon: `data:image/png;base64,${TINY_PNG_B64}`,
        Text: 'PROBE',
      },
    ],
  },
})

function hexCmd(n) {
  return `0x${n.toString(16).padStart(4, '0')}`
}

function buildPacket(command, payload) {
  const buf = Buffer.alloc(PACKET_SIZE)
  buf[0] = 0x7c
  buf[1] = 0x7c
  buf.writeUInt16BE(command, 2)
  const data = Buffer.from(payload, 'utf8')
  buf.writeUInt32LE(data.length, 4)
  data.copy(buf, HEADER_SIZE)
  return buf
}

function parseResponse(buf) {
  if (buf.length < HEADER_SIZE) return null
  if (buf[0] !== 0x7c || buf[1] !== 0x7c) return null
  const cmd = buf.readUInt16BE(2)
  const len = buf.readUInt32LE(4)
  if (cmd === 0x010b) return { type: 'ACK' }
  if (cmd === 0x0303) {
    const data = buf.subarray(HEADER_SIZE, HEADER_SIZE + Math.min(len, buf.length - HEADER_SIZE))
    const nul = data.indexOf(0)
    return { type: 'DEVICE_INFO', data: data.subarray(0, nul >= 0 ? nul : data.length).toString('utf8') }
  }
  if (cmd === 0x0101) return { type: 'BUTTON' }
  const data = buf.subarray(HEADER_SIZE, HEADER_SIZE + Math.min(16, len, buf.length - HEADER_SIZE))
  return { type: `CMD_${hexCmd(cmd)}`, data: data.toString('hex') }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  const args = process.argv.slice(2)
  const withManifest = args.includes('--with-manifest')
  const positional = args.filter((a) => !a.startsWith('--'))

  let rangeStart = 0x0021
  let rangeEnd = 0x0100
  if (positional.length === 1) {
    rangeStart = rangeEnd = parseInt(positional[0], 16) || parseInt(positional[0], 10)
  } else if (positional.length === 2) {
    rangeStart = parseInt(positional[0], 16) || parseInt(positional[0], 10)
    rangeEnd = parseInt(positional[1], 16) || parseInt(positional[1], 10)
  }

  const devices = await HID.devicesAsync()
  const info = devices.find((d) => d.vendorId === VID && d.productId === PID && d.interface === INTERFACE)
  if (!info) throw new Error('D200 not found')
  console.log(`Found D200: ${info.path}`)
  const device = await HID.HIDAsync.open(info.path)

  const responses = []
  device.on('data', (buf) => {
    const parsed = parseResponse(buf)
    if (parsed) responses.push(parsed)
  })
  device.on('error', (e) => console.error('HID error:', e.message))

  const payload = withManifest ? MANIFEST : ''
  const payloadLabel = withManifest ? 'JSON manifest' : 'empty'
  const total = rangeEnd - rangeStart + 1
  const skipped = [...SKIP].filter((c) => c >= rangeStart && c <= rangeEnd).length
  console.log(`Scanning ${hexCmd(rangeStart)}..${hexCmd(rangeEnd)} (${total} values, ${skipped} skipped)`)
  console.log(`Payload: ${payloadLabel}`)
  console.log(`Watch the D200 screen. Interesting commands will be flagged.\n`)

  const interesting = []
  const noResponse = []
  let lastProgress = 0

  try {
    for (let cmd = rangeStart; cmd <= rangeEnd; cmd++) {
      if (SKIP.has(cmd)) continue

      responses.length = 0
      const pkt = buildPacket(cmd, payload)
      const buf = Buffer.alloc(PACKET_SIZE + 1)
      buf[0] = 0x00
      pkt.copy(buf, 1)
      await device.write(buf)
      await sleep(150)

      const acks = responses.filter((r) => r.type === 'ACK')
      const others = responses.filter((r) => r.type !== 'ACK' && r.type !== 'BUTTON')

      // Progress indicator every 16 commands
      const progress = Math.floor((cmd - rangeStart) / 16)
      if (progress > lastProgress) {
        process.stdout.write(`  ... ${hexCmd(cmd)}\n`)
        lastProgress = progress
      }

      if (others.length > 0) {
        const desc = others.map((r) => r.type + (r.data ? `(${r.data.substring(0, 60)})` : '')).join(', ')
        console.log(`  ** ${hexCmd(cmd)}: ${desc}`)
        interesting.push({ cmd, cmdHex: hexCmd(cmd), responses: others })
      } else if (responses.length === 0) {
        console.log(`  ?? ${hexCmd(cmd)}: NO RESPONSE`)
        noResponse.push({ cmd, cmdHex: hexCmd(cmd) })
      }
      // Plain ACK = silent, don't print
    }
  } finally {
    await device.close()
  }

  console.log('\n' + '='.repeat(60))
  console.log('=== RESULTS ===\n')
  if (interesting.length === 0 && noResponse.length === 0) {
    console.log('Nothing interesting. All commands returned plain ACK.')
  }
  if (interesting.length > 0) {
    console.log('Commands with non-ACK responses:')
    for (const h of interesting) {
      console.log(`  ${h.cmdHex}: ${h.responses.map((r) => r.type).join(', ')}`)
    }
  }
  if (noResponse.length > 0) {
    console.log('\nCommands with NO response (possible crash):')
    for (const h of noResponse) {
      console.log(`  ${h.cmdHex}`)
    }
  }
  console.log('\nDone.')
}

main().catch((e) => {
  console.error('Fatal:', e.message)
  process.exit(1)
})
