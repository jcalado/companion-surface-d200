#!/usr/bin/env node
/**
 * Probe for undiscovered HID command IDs on the Ulanzi D200.
 *
 * Opens the 2207:0019 HID device (interface 0) and sends candidate command
 * numbers with a small JSON manifest payload containing an inline base64 PNG.
 * Logs every response so we can identify which commands the firmware accepts.
 *
 * Usage:
 *   node tools/probe-commands.mjs                  # scan default range
 *   node tools/probe-commands.mjs 0x0002           # test a single command
 *   node tools/probe-commands.mjs 0x0002 0x0020    # scan a range
 *   node tools/probe-commands.mjs --brightness     # quick connectivity test
 */
import HID from 'node-hid'

const VID = 0x2207
const PID = 0x0019
const INTERFACE = 0
const PACKET_SIZE = 1024
const HEADER_SIZE = 8

// Known commands (skip during scan)
const KNOWN = new Set([
  0x0001, // OUT_SET_BUTTONS
  0x0006, // OUT_SET_SMALL_WINDOW_DATA
  0x000a, // OUT_SET_BRIGHTNESS
  0x000b, // OUT_SET_LABEL_STYLE
  0x000d, // OUT_PARTIALLY_UPDATE_BUTTONS
  0x0101, // IN_BUTTON
  0x0303, // IN_DEVICE_INFO
])

// 1x1 red PNG, base64-encoded (67 bytes decoded)
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg=='

// Minimal JSON manifest targeting button 0_0 with an inline data URI
const MANIFEST_DATAURI = JSON.stringify({
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

// Bare JSON manifest with no image (lighter probe)
const MANIFEST_BARE = JSON.stringify({
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
        Text: 'PROBE',
      },
    ],
  },
})

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

function buildBrightnessPacket(percent) {
  return buildPacket(0x000a, String(percent))
}

function hexCmd(n) {
  return `0x${n.toString(16).padStart(4, '0')}`
}

function parseResponse(buf) {
  if (buf.length < HEADER_SIZE) return null
  if (buf[0] !== 0x7c || buf[1] !== 0x7c) return null
  const cmd = buf.readUInt16BE(2)
  const len = buf.readUInt32LE(4)
  const data = buf.subarray(HEADER_SIZE, HEADER_SIZE + Math.min(len, buf.length - HEADER_SIZE))
  if (cmd === 0x0303) {
    const nul = data.indexOf(0)
    const json = data.subarray(0, nul >= 0 ? nul : data.length).toString('utf8')
    return { cmd, cmdHex: hexCmd(cmd), type: 'DEVICE_INFO', json }
  }
  if (cmd === 0x010b) {
    return { cmd, cmdHex: hexCmd(cmd), type: 'ACK', len }
  }
  if (cmd === 0x0101) {
    return {
      cmd,
      cmdHex: hexCmd(cmd),
      type: 'BUTTON',
      state: data[0],
      index: data[1],
      pressed: data[3] === 0x01,
    }
  }
  return {
    cmd,
    cmdHex: hexCmd(cmd),
    type: 'UNKNOWN',
    len,
    dataHex: data.subarray(0, Math.min(32, data.length)).toString('hex'),
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function findDevice() {
  const devices = HID.devicesAsync()
  return devices.then((list) => {
    const match = list.find(
      (d) => d.vendorId === VID && d.productId === PID && d.interface === INTERFACE,
    )
    if (!match) throw new Error(`D200 not found (VID ${hexCmd(VID)} PID ${hexCmd(PID)} iface ${INTERFACE})`)
    return match
  })
}

async function main() {
  const args = process.argv.slice(2)

  // Parse arguments
  let mode = 'scan'
  let rangeStart = 0x0002
  let rangeEnd = 0x0020

  if (args.includes('--brightness')) {
    mode = 'brightness'
  } else if (args.includes('--datauri')) {
    mode = 'datauri-only'
    if (args.length > 1) {
      const cmdArg = args.find((a) => a !== '--datauri')
      if (cmdArg) {
        rangeStart = rangeEnd = parseInt(cmdArg, 16) || parseInt(cmdArg, 10)
      }
    }
  } else if (args.length === 1 && !args[0].startsWith('--')) {
    mode = 'single'
    rangeStart = rangeEnd = parseInt(args[0], 16) || parseInt(args[0], 10)
  } else if (args.length === 2) {
    rangeStart = parseInt(args[0], 16) || parseInt(args[0], 10)
    rangeEnd = parseInt(args[1], 16) || parseInt(args[1], 10)
  }

  // Find and open device
  const info = await findDevice()
  console.log(`Found D200: ${info.path}`)
  const device = await HID.HIDAsync.open(info.path)

  // Collect responses in background
  const responses = []
  device.on('data', (buf) => {
    const parsed = parseResponse(buf)
    if (parsed) responses.push({ time: Date.now(), ...parsed })
  })
  device.on('error', (e) => console.error('HID error:', e.message))

  // Helper: write a 1024-byte packet, prepending HID report-ID 0x00
  async function hidWrite(packet) {
    const buf = Buffer.alloc(PACKET_SIZE + 1)
    buf[0] = 0x00
    packet.copy(buf, 1)
    await device.write(buf)
  }

  // Helper: send a packet and collect responses for a duration
  async function probe(label, packet, waitMs = 600) {
    responses.length = 0
    await hidWrite(packet)
    await sleep(waitMs)

    const relevant = responses.filter((r) => r.type !== 'BUTTON') // ignore stray button events
    console.log(`\n  ${label}`)
    if (relevant.length === 0) {
      console.log('    -> no response (silent)')
    } else {
      for (const r of relevant) {
        if (r.type === 'DEVICE_INFO') {
          console.log(`    -> DEVICE_INFO: ${r.json.substring(0, 120)}...`)
        } else if (r.type === 'ACK') {
          console.log(`    -> ACK (0x010b)`)
        } else if (r.type === 'UNKNOWN') {
          console.log(`    -> cmd=${r.cmdHex} len=${r.len} data=${r.dataHex}`)
        } else {
          console.log(`    -> ${JSON.stringify(r)}`)
        }
      }
    }
    return relevant
  }

  try {
    // Connectivity test first
    console.log('=== Connectivity test: SET_BRIGHTNESS 30 ===')
    const ack = await probe('brightness=30', buildBrightnessPacket(30), 800)
    if (ack.length === 0) {
      console.log('\nWARNING: no response to brightness command. Device may not be working.')
      console.log('Continuing anyway...\n')
    } else {
      console.log('\nDevice responding OK.\n')
    }

    if (mode === 'brightness') {
      return
    }

    if (mode === 'datauri-only') {
      // Test a specific command with data URI manifest
      console.log(`=== Testing ${hexCmd(rangeStart)} with data:image/ manifest ===`)
      await probe(
        `${hexCmd(rangeStart)} + data URI manifest`,
        buildPacket(rangeStart, MANIFEST_DATAURI),
        1000,
      )
      return
    }

    // Scan mode
    console.log(`=== Probing commands ${hexCmd(rangeStart)}..${hexCmd(rangeEnd)} ===`)
    console.log(`Known commands (skipped): ${[...KNOWN].map(hexCmd).join(', ')}`)
    console.log(`Payload: bare JSON manifest (no image)`)
    console.log()

    const hits = []

    for (let cmd = rangeStart; cmd <= rangeEnd; cmd++) {
      if (KNOWN.has(cmd)) continue

      const result = await probe(
        `${hexCmd(cmd)} (bare manifest)`,
        buildPacket(cmd, MANIFEST_BARE),
        500,
      )

      if (result.length > 0) {
        hits.push({ cmd, cmdHex: hexCmd(cmd), responses: result })

        // If we got a response, also try with the data URI manifest
        console.log(`    ** Got response! Retrying with data:image/ manifest...`)
        await sleep(300)
        await probe(
          `${hexCmd(cmd)} (data URI manifest)`,
          buildPacket(cmd, MANIFEST_DATAURI),
          1000,
        )
      }
    }

    // Summary
    console.log('\n' + '='.repeat(60))
    console.log('=== SCAN RESULTS ===')
    console.log(`Scanned: ${hexCmd(rangeStart)}..${hexCmd(rangeEnd)} (${rangeEnd - rangeStart + 1} values, ${KNOWN.size} known skipped)`)
    if (hits.length === 0) {
      console.log('No new commands responded.')
    } else {
      console.log(`\nResponding commands:`)
      for (const h of hits) {
        const types = [...new Set(h.responses.map((r) => r.type))].join(', ')
        console.log(`  ${h.cmdHex} -> ${types}`)
      }
    }
  } finally {
    await device.close()
    console.log('\nDevice closed.')
  }
}

main().catch((e) => {
  console.error('Fatal:', e.message)
  process.exit(1)
})
