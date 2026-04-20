#!/usr/bin/env node
// Standalone probe: open the D200, send ONE brightness packet, read any response.
// Run with: node tools/probe.mjs
import { usb } from 'usb'

try {
	usb.setDebugLevel(4)
} catch {}

const VID = 0x18d1
const PID = 0xd002
const EP_OUT = 0x01
const EP_IN = 0x82
const PACKET_SIZE = 1024

function buildBrightness(percent) {
	const buf = Buffer.alloc(PACKET_SIZE)
	buf[0] = 0x7c
	buf[1] = 0x7c
	buf.writeUInt16BE(0x000a, 2) // OUT_SET_BRIGHTNESS
	const payload = Buffer.from(String(percent), 'utf8')
	buf.writeUInt32LE(payload.length, 4)
	payload.copy(buf, 8)
	return buf
}

function describe(err) {
	if (!err) return 'ok'
	const errno = err.errno !== undefined ? ` (errno=${err.errno})` : ''
	return `${err.message ?? String(err)}${errno}`
}

async function main() {
	const dev = usb.getDeviceList().find(
		(d) => d.deviceDescriptor.idVendor === VID && d.deviceDescriptor.idProduct === PID,
	)
	if (!dev) throw new Error('D200 not found')
	console.log('found device:', dev.busNumber, dev.portNumbers?.join('.'))

	dev.open()
	const iface = dev.interface(0)
	console.log('interface class/subclass:', iface.descriptor.bInterfaceClass, iface.descriptor.bInterfaceSubClass)

	if (iface.isKernelDriverActive()) {
		console.log('detaching kernel driver')
		iface.detachKernelDriver()
	}
	iface.claim()
	console.log('interface claimed')

	const epOut = iface.endpoints.find((e) => e.address === EP_OUT)
	const epIn = iface.endpoints.find((e) => e.address === EP_IN)
	if (!epOut || !epIn) throw new Error('endpoints not found')

	console.log('skipping clearHalt — device rejects CLEAR_FEATURE control req')

	// Try a GET_STATUS control transfer to confirm control path works at all.
	console.log('trying GET_STATUS control transfer')
	await new Promise((resolve) => {
		dev.controlTransfer(
			0x80, // bmRequestType: device-to-host, standard, device
			0x00, // bRequest: GET_STATUS
			0,
			0,
			2, // length
			(err, data) => {
				if (err) console.log('GET_STATUS failed:', describe(err))
				else console.log('GET_STATUS ok:', data.toString('hex'))
				resolve()
			},
		)
	})

	// Try setAltSetting 0 — some devices require this to activate endpoints.
	console.log('trying setAltSetting(0)')
	await new Promise((resolve) => {
		iface.setAltSetting(0, (err) => {
			if (err) console.log('setAltSetting failed:', describe(err))
			else console.log('setAltSetting ok')
			resolve()
		})
	})

	const packet = buildBrightness(30)
	console.log('submitting OUT transfer, first 16 bytes:', packet.subarray(0, 16).toString('hex'))
	const t0 = Date.now()
	await new Promise((resolve, reject) => {
		const transfer = epOut.makeTransfer(5000, (err, _buf, len) => {
			const ms = Date.now() - t0
			if (err) {
				console.log(`OUT transfer FAILED after ${ms}ms:`, describe(err))
				reject(err)
			} else {
				console.log(`OUT transfer OK after ${ms}ms, wrote ${len} bytes`)
				resolve()
			}
		})
		try {
			transfer.submit(packet)
		} catch (e) {
			console.log('submit threw:', describe(e))
			reject(e)
		}
	})

	console.log('starting IN poll for 2s')
	epIn.on('data', (d) => console.log('IN data:', d.length, 'bytes', d.subarray(0, 16).toString('hex')))
	epIn.on('error', (e) => console.log('IN error:', describe(e)))
	epIn.startPoll(2, 512)
	await new Promise((r) => setTimeout(r, 2000))
	await new Promise((r) => epIn.stopPoll(() => r()))

	await new Promise((r) => iface.release(true, () => r()))
	dev.close()
	console.log('done')
}

main().catch((e) => {
	console.error('fatal:', describe(e))
	process.exit(1)
})
