#!/usr/bin/env node
/**
 * Interactive command probe for the Ulanzi D200.
 *
 * Sends one command at a time and waits for you to describe what happened
 * on the device before moving to the next. Logs full response details.
 *
 * Usage:
 *   node tools/probe-interactive.mjs                # scan 0x0002..0x0020
 *   node tools/probe-interactive.mjs 0x0002 0x0010  # custom range
 *   node tools/probe-interactive.mjs 0x0003         # single command
 */
import HID from 'node-hid'
import readline from 'node:readline'

const VID = 0x2207
const PID = 0x0019
const INTERFACE = 0
const PACKET_SIZE = 1024
const HEADER_SIZE = 8

const KNOWN = {
  0x0001: 'OUT_SET_BUTTONS',
  0x0006: 'OUT_SET_SMALL_WINDOW_DATA',
  0x000a: 'OUT_SET_BRIGHTNESS',
  0x000b: 'OUT_SET_LABEL_STYLE',
  0x000d: 'OUT_PARTIALLY_UPDATE_BUTTONS',
}

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg=='

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

// Different payloads to try
const PAYLOADS = {
  bare: { label: 'bare JSON manifest', data: MANIFEST_BARE },
  datauri: { label: 'data:image/ manifest', data: MANIFEST_DATAURI },
  empty: { label: 'empty payload', data: '' },
  brightness: { label: 'brightness "50"', data: '50' },
}

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
  const data = buf.subarray(HEADER_SIZE, HEADER_SIZE + Math.min(len, buf.length - HEADER_SIZE))
  if (cmd === 0x0303) {
    const nul = data.indexOf(0)
    const json = data.subarray(0, nul >= 0 ? nul : data.length).toString('utf8')
    return { cmd, cmdHex: hexCmd(cmd), type: 'DEVICE_INFO', detail: json }
  }
  if (cmd === 0x010b) {
    return { cmd, cmdHex: hexCmd(cmd), type: 'ACK', detail: `len=${len}` }
  }
  if (cmd === 0x0101) {
    return {
      cmd,
      cmdHex: hexCmd(cmd),
      type: 'BUTTON',
      detail: `idx=${data[1]} pressed=${data[3] === 1}`,
    }
  }
  const hex = data.subarray(0, Math.min(32, data.length)).toString('hex')
  return { cmd, cmdHex: hexCmd(cmd), type: 'UNKNOWN', detail: `len=${len} data=${hex}` }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve))
}

async function main() {
  const args = process.argv.slice(2)
  let rangeStart = 0x0002
  let rangeEnd = 0x0020

  if (args.length === 1) {
    rangeStart = rangeEnd = parseInt(args[0], 16) || parseInt(args[0], 10)
  } else if (args.length === 2) {
    rangeStart = parseInt(args[0], 16) || parseInt(args[0], 10)
    rangeEnd = parseInt(args[1], 16) || parseInt(args[1], 10)
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  const devices = await HID.devicesAsync()
  const info = devices.find((d) => d.vendorId === VID && d.productId === PID && d.interface === INTERFACE)
  if (!info) throw new Error('D200 not found')
  console.log(`Found D200: ${info.path}\n`)
  let device = await HID.HIDAsync.open(info.path)

  const responses = []
  device.on('data', (buf) => {
    const parsed = parseResponse(buf)
    if (parsed) responses.push(parsed)
  })
  device.on('error', (e) => console.error('HID error:', e.message))

  async function hidWrite(packet) {
    const buf = Buffer.alloc(PACKET_SIZE + 1)
    buf[0] = 0x00
    packet.copy(buf, 1)
    await device.write(buf)
  }

  async function sendAndLog(cmd, payloadKey) {
    const pl = PAYLOADS[payloadKey]
    responses.length = 0
    await hidWrite(buildPacket(cmd, pl.data))
    await sleep(800)
    return [...responses]
  }

  // Restore function: send brightness + known-good SET_BUTTONS to reset state
  async function restore() {
    console.log('  [restoring: brightness=50]')
    await hidWrite(buildPacket(0x000a, '50'))
    await sleep(500)
  }

  const log = []

  try {
    // Initial brightness to confirm comms
    console.log('--- Connectivity test ---')
    responses.length = 0
    await hidWrite(buildPacket(0x000a, '50'))
    await sleep(800)
    if (responses.length > 0) {
      console.log(`OK: ${responses.map((r) => r.type).join(', ')}\n`)
    } else {
      console.log('WARNING: no response\n')
    }

    // Skip known-destructive commands discovered in prior runs
    const DESTRUCTIVE = new Set([
      0x0004, // kills the display app, needs replug
    ])

    // Commands with known effects that we skip in broad scans
    const SKIP_KNOWN_EFFECT = new Set([
      0x0003, // GET_DEVICE_INFO (harmless but noisy)
      0x000f, // LOCKSCREEN
      0x0010, // UNLOCKSCREEN
    ])

    console.log(`Will probe ${hexCmd(rangeStart)}..${hexCmd(rangeEnd)}`)
    console.log('After each command, describe what you see on the D200.')
    console.log('Answers: "nothing" / "dark" / "lockscreen" / "icons changed" / etc.')
    console.log('Commands: "skip" = skip to next, "done" = end scan, "q" = quit')
    console.log('If device dies: replug, then type "replug" to reconnect.\n')

    let currentDevice = device

    // Reconnect after replug
    async function reconnect() {
      try { await currentDevice.close() } catch {}
      console.log('  Waiting for device...')
      for (let i = 0; i < 20; i++) {
        await sleep(1000)
        const devs = await HID.devicesAsync()
        const found = devs.find((d) => d.vendorId === VID && d.productId === PID && d.interface === INTERFACE)
        if (found) {
          currentDevice = await HID.HIDAsync.open(found.path)
          currentDevice.on('data', (buf) => {
            const parsed = parseResponse(buf)
            if (parsed) responses.push(parsed)
          })
          currentDevice.on('error', (e) => console.error('HID error:', e.message))
          console.log(`  Reconnected: ${found.path}`)
          return
        }
      }
      throw new Error('Device not found after 20s')
    }

    async function hidWriteCurrent(packet) {
      const buf = Buffer.alloc(PACKET_SIZE + 1)
      buf[0] = 0x00
      packet.copy(buf, 1)
      await currentDevice.write(buf)
    }

    async function sendAndLogCurrent(cmd, payloadKey) {
      const pl = PAYLOADS[payloadKey]
      responses.length = 0
      await hidWriteCurrent(buildPacket(cmd, pl.data))
      await sleep(800)
      return [...responses]
    }

    async function restoreCurrent() {
      console.log('  [restoring: brightness=50]')
      await hidWriteCurrent(buildPacket(0x000a, '50'))
      await sleep(500)
    }

    for (let cmd = rangeStart; cmd <= rangeEnd; cmd++) {
      if (cmd in KNOWN) {
        console.log(`${hexCmd(cmd)} = ${KNOWN[cmd]} (known, skipping)`)
        continue
      }
      if (DESTRUCTIVE.has(cmd)) {
        console.log(`${hexCmd(cmd)} = destructive (kills screen, skipping)`)
        log.push({ cmd: hexCmd(cmd), emptyPayload: { responses: ['SKIP'], visual: 'destructive (kills screen)' } })
        continue
      }
      if (SKIP_KNOWN_EFFECT.has(cmd)) {
        const names = { 0x0003: 'GET_DEVICE_INFO', 0x000f: 'LOCKSCREEN', 0x0010: 'UNLOCKSCREEN' }
        console.log(`${hexCmd(cmd)} = ${names[cmd]} (already mapped, skipping)`)
        continue
      }

      console.log(`\n${'='.repeat(50)}`)
      console.log(`Testing ${hexCmd(cmd)} with empty payload...`)

      let r1
      try {
        r1 = await sendAndLogCurrent(cmd, 'empty')
      } catch (e) {
        console.log(`  Write failed: ${e.message}`)
        const fix = await ask(rl, '  Type "replug" after reconnecting, or "skip"/"q": > ')
        if (fix.toLowerCase() === 'replug') {
          await reconnect()
          continue
        }
        if (fix.toLowerCase() === 'q') break
        continue
      }
      console.log(`  Responses: ${r1.length === 0 ? 'none' : r1.map((r) => `${r.type}(${r.detail})`).join(', ')}`)

      const answer = (await ask(rl, `  What happened on the D200? > `)).trim().toLowerCase()
      if (answer === 'q') break
      if (answer === 'done') break

      const entry = {
        cmd: hexCmd(cmd),
        emptyPayload: { responses: r1.map((r) => r.type), visual: answer },
      }

      if (answer === 'replug') {
        entry.emptyPayload.visual = 'device died, needed replug'
        log.push(entry)
        await reconnect()
        continue
      }

      // If something visible happened, test other payloads
      if (answer && answer !== 'nothing' && answer !== 'n' && answer !== 'skip') {
        await restoreCurrent()
        await sleep(500)

        // Try with bare manifest
        console.log(`  Retrying ${hexCmd(cmd)} with bare JSON manifest...`)
        const r2 = await sendAndLogCurrent(cmd, 'bare')
        console.log(`  Responses: ${r2.length === 0 ? 'none' : r2.map((r) => `${r.type}(${r.detail})`).join(', ')}`)
        const a2 = (await ask(rl, `  What happened? > `)).trim().toLowerCase()
        entry.bareManifest = { responses: r2.map((r) => r.type), visual: a2 }

        if (a2 === 'replug') {
          log.push(entry)
          await reconnect()
          continue
        }

        await restoreCurrent()
        await sleep(500)

        // Try with data URI manifest
        console.log(`  Retrying ${hexCmd(cmd)} with data:image/ manifest...`)
        const r3 = await sendAndLogCurrent(cmd, 'datauri')
        console.log(`  Responses: ${r3.length === 0 ? 'none' : r3.map((r) => `${r.type}(${r.detail})`).join(', ')}`)
        const a3 = (await ask(rl, `  What happened? > `)).trim().toLowerCase()
        entry.datauriManifest = { responses: r3.map((r) => r.type), visual: a3 }

        if (a3 === 'replug') {
          log.push(entry)
          await reconnect()
          continue
        }

        await restoreCurrent()
      }

      log.push(entry)
    }

    device = currentDevice
  } finally {
    try { await device.close() } catch {}
    rl.close()
  }

  // Print summary
  console.log('\n' + '='.repeat(60))
  console.log('=== PROBE LOG ===\n')
  for (const e of log) {
    const visuals = [e.emptyPayload?.visual, e.bareManifest?.visual, e.datauriManifest?.visual]
      .filter((v) => v && v !== 'nothing' && v !== 'n')
    if (visuals.length > 0) {
      console.log(`${e.cmd}:`)
      if (e.emptyPayload) console.log(`  empty:    ${e.emptyPayload.visual} [${e.emptyPayload.responses}]`)
      if (e.bareManifest) console.log(`  bare:     ${e.bareManifest.visual} [${e.bareManifest.responses}]`)
      if (e.datauriManifest) console.log(`  datauri:  ${e.datauriManifest.visual} [${e.datauriManifest.responses}]`)
    } else {
      console.log(`${e.cmd}: no visual effect [${e.emptyPayload.responses}]`)
    }
  }

  console.log('\nDone.')
}

main().catch((e) => {
  console.error('Fatal:', e.message)
  process.exit(1)
})
