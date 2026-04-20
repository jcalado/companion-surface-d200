import EventEmitter from 'node:events'
import os from 'node:os'
import type { HIDAsync } from 'node-hid'
import {
	type ButtonEvent,
	Command,
	type LabelStyle,
	PACKET_SIZE,
	type SmallWindowData,
	SmallWindowMode,
	buildChunkedPackets,
	buildSimplePacket,
	encodeBrightness,
	encodeLabelStyle,
	encodeSmallWindow,
	parseIncoming,
} from './protocol.js'
import { type ButtonRenderInput, buildButtonZip } from './zip-builder.js'

export interface D200Events {
	error: [error: Error]
	button: [event: ButtonEvent]
	deviceInfo: [info: string]
	log: [line: string]
}

/**
 * Low-level driver for the Ulanzi D200 over HID (interface 0).
 *
 * The device uses two 1024-byte interrupt endpoints. Writes require an HID
 * report-ID byte (0) prepended. Reads arrive via the node-hid `data` event.
 */
export class D200Device extends EventEmitter<D200Events> {
	readonly #device: HIDAsync
	#writeQueue: Promise<void> = Promise.resolve()
	#keepAlive?: NodeJS.Timeout
	#closed = false
	#smallWindowMode: SmallWindowMode = SmallWindowMode.CLOCK
	#cpuSample: { idle: number; total: number } = sampleCpu()

	constructor(device: HIDAsync) {
		super()
		this.#device = device

		device.on('error', (e) => {
			if (this.#closed) return
			this.emit('error', e as Error)
		})
		device.on('data', (data: Buffer) => {
			this.emit('log', `RX ${data.length}B: ${data.subarray(0, 16).toString('hex')}`)
			const parsed = parseIncoming(data)
			if (!parsed) {
				this.emit('log', `RX unparsed`)
				return
			}
			if (parsed.kind === 'button') {
				this.emit('log', `RX button idx=${parsed.event.index} pressed=${parsed.event.pressed} state=${parsed.event.state}`)
				this.emit('button', parsed.event)
			} else if (parsed.kind === 'info') {
				this.emit('deviceInfo', parsed.info)
			}
		})

		this.#keepAlive = setInterval(() => {
			this.setSmallWindow(this.#buildSmallWindowData()).catch(() => null)
		}, 5000)
	}

	async close(): Promise<void> {
		if (this.#closed) return
		this.#closed = true
		if (this.#keepAlive) clearInterval(this.#keepAlive)
		try {
			await this.#device.close()
		} catch {
			/* ignore */
		}
	}

	async setBrightness(percent: number): Promise<void> {
		await this.#writePacket(buildSimplePacket(Command.OUT_SET_BRIGHTNESS, encodeBrightness(percent)))
	}

	async setLabelStyle(style: LabelStyle): Promise<void> {
		await this.#writePacket(buildSimplePacket(Command.OUT_SET_LABEL_STYLE, encodeLabelStyle(style)))
	}

	async setSmallWindow(data: SmallWindowData): Promise<void> {
		await this.#writePacket(buildSimplePacket(Command.OUT_SET_SMALL_WINDOW_DATA, encodeSmallWindow(data)))
	}

	setSmallWindowMode(mode: SmallWindowMode): void {
		this.#smallWindowMode = mode
		// Push immediately so the mode change is visible without waiting for the keep-alive.
		this.setSmallWindow(this.#buildSmallWindowData()).catch(() => null)
	}

	#buildSmallWindowData(): SmallWindowData {
		const data: SmallWindowData = { mode: this.#smallWindowMode }
		if (this.#smallWindowMode === SmallWindowMode.STATS) {
			const prev = this.#cpuSample
			const now = sampleCpu()
			this.#cpuSample = now
			const idleDelta = now.idle - prev.idle
			const totalDelta = now.total - prev.total
			data.cpu = totalDelta > 0 ? Math.max(0, Math.min(100, Math.round(100 - (100 * idleDelta) / totalDelta))) : 0
			const total = os.totalmem()
			const free = os.freemem()
			data.mem = total > 0 ? Math.round((100 * (total - free)) / total) : 0
		}
		return data
	}

	async setButtons(buttons: ButtonRenderInput[], opts: { partial?: boolean } = {}): Promise<void> {
		const zipPayload = await buildButtonZip(buttons)
		const command = opts.partial ? Command.OUT_PARTIALLY_UPDATE_BUTTONS : Command.OUT_SET_BUTTONS
		const packets = buildChunkedPackets(command, zipPayload)
		await this.#writePackets(packets)
	}

	#writePacket(packet: Buffer): Promise<void> {
		return this.#writePackets([packet])
	}

	#writePackets(packets: Buffer[]): Promise<void> {
		const job = this.#writeQueue.then(async () => {
			if (this.#closed) return
			for (const packet of packets) {
				if (packet.length !== PACKET_SIZE) {
					throw new Error(`Packet size mismatch: expected ${PACKET_SIZE}, got ${packet.length}`)
				}
				// node-hid: prepend report ID byte 0 for unnumbered HID reports
				const out = Buffer.alloc(PACKET_SIZE + 1)
				packet.copy(out, 1)
				await this.#device.write(out)
			}
		})
		this.#writeQueue = job.catch(() => undefined)
		return job
	}
}

function sampleCpu(): { idle: number; total: number } {
	let idle = 0
	let total = 0
	for (const cpu of os.cpus()) {
		const t = cpu.times
		idle += t.idle
		total += t.user + t.nice + t.sys + t.idle + t.irq
	}
	return { idle, total }
}
