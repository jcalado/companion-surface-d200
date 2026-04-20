/**
 * Ulanzi D200 wire protocol.
 *
 * Ported from strmdck (https://github.com/redphx/strmdck), MIT-licensed.
 * See: strmdck/src/strmdck/devices/ulanzi_d200.py
 */

// The D200 exposes two USB devices simultaneously via an internal hub:
//  1. 18d1:d002 — a dummy ADB-style bulk device (unused)
//  2. 2207:0019 — the real HID device with the deck protocol
//
// Interface 0 on the HID device: two 1024-byte interrupt endpoints
//   EP 0x01 OUT / EP 0x82 IN  — the channel we talk on
// Interface 1: HID keyboard emulation (for standalone hotkey buttons) — ignored.
//
// Some Linux controllers fail to enumerate both devices concurrently; a USB 2.0
// hub between the D200 and the host is a reliable workaround.
export const D200_VENDOR_ID = 0x2207
export const D200_PRODUCT_ID = 0x0019
export const D200_INTERFACE_NUMBER = 0

export const PACKET_SIZE = 1024
export const HEADER_SIZE = 8
export const FIRST_CHUNK_DATA = PACKET_SIZE - HEADER_SIZE // 1016

export const BUTTON_COUNT = 13
export const BUTTON_ROWS = 3
export const BUTTON_COLS = 5
export const ICON_WIDTH = 196
export const ICON_HEIGHT = 196

export enum Command {
	OUT_SET_BUTTONS = 0x0001,
	OUT_PARTIALLY_UPDATE_BUTTONS = 0x000d,
	OUT_SET_SMALL_WINDOW_DATA = 0x0006,
	OUT_SET_BRIGHTNESS = 0x000a,
	OUT_SET_LABEL_STYLE = 0x000b,

	IN_BUTTON = 0x0101,
	IN_DEVICE_INFO = 0x0303,
}

export enum SmallWindowMode {
	STATS = 0,
	CLOCK = 1,
	BACKGROUND = 2,
}

/** Build the first framed packet: `[0x7c 0x7c][cmd:2 BE][length:4 LE][data padded to 1016]` */
export function buildFramedPacket(command: Command, length: number, data: Buffer): Buffer {
	if (data.length > FIRST_CHUNK_DATA) {
		throw new Error(`Framed packet data too large: ${data.length} > ${FIRST_CHUNK_DATA}`)
	}
	const buf = Buffer.alloc(PACKET_SIZE)
	buf[0] = 0x7c
	buf[1] = 0x7c
	buf.writeUInt16BE(command, 2)
	buf.writeUInt32LE(length, 4)
	data.copy(buf, HEADER_SIZE)
	return buf
}

/** Build a single-packet command with inline payload and length = payload size. */
export function buildSimplePacket(command: Command, payload: Buffer): Buffer {
	return buildFramedPacket(command, payload.length, payload)
}

/** Chunk a payload (already including the ZIP body) into wire packets. */
export function buildChunkedPackets(command: Command, payload: Buffer): Buffer[] {
	const packets: Buffer[] = []
	const first = payload.subarray(0, FIRST_CHUNK_DATA)
	packets.push(buildFramedPacket(command, payload.length, first))
	for (let offset = FIRST_CHUNK_DATA; offset < payload.length; offset += PACKET_SIZE) {
		const chunk = payload.subarray(offset, offset + PACKET_SIZE)
		if (chunk.length === PACKET_SIZE) {
			packets.push(Buffer.from(chunk))
		} else {
			const padded = Buffer.alloc(PACKET_SIZE)
			chunk.copy(padded)
			packets.push(padded)
		}
	}
	return packets
}

/**
 * The D200 has a firmware bug: the byte at file offset 1016 + 1024*N (i.e. the
 * first byte of every subsequent raw chunk) must not be 0x00 or 0x7c.
 * Returns true if the ZIP payload is safe to send.
 */
export function isPayloadSafe(payload: Buffer): boolean {
	for (let i = FIRST_CHUNK_DATA; i < payload.length; i += PACKET_SIZE) {
		const b = payload[i]
		if (b === 0x00 || b === 0x7c) return false
	}
	return true
}

export interface ButtonEvent {
	state: number
	index: number
	pressed: boolean
}

/** Parse an incoming HID report. Returns null if not recognised. */
export function parseIncoming(
	report: Buffer,
): { kind: 'button'; event: ButtonEvent } | { kind: 'info'; info: string } | null {
	if (report.length < HEADER_SIZE) return null
	if (report[0] !== 0x7c || report[1] !== 0x7c) return null
	const command = report.readUInt16BE(2)
	const length = report.readUInt32LE(4)
	const data = report.subarray(HEADER_SIZE, HEADER_SIZE + length)

	if (command === Command.IN_BUTTON) {
		if (data.length < 4) return null
		return {
			kind: 'button',
			event: {
				state: data[0],
				index: data[1],
				// data[2] === 0x01 sentinel
				pressed: data[3] === 0x01,
			},
		}
	}
	if (command === Command.IN_DEVICE_INFO) {
		const nul = data.indexOf(0)
		const info = data.subarray(0, nul >= 0 ? nul : data.length).toString('ascii')
		return { kind: 'info', info }
	}
	return null
}

export function encodeBrightness(percent: number): Buffer {
	const clamped = Math.max(0, Math.min(100, Math.round(percent)))
	return Buffer.from(String(clamped), 'utf8')
}

export interface LabelStyle {
	align?: 'top' | 'middle' | 'bottom'
	color?: string // hex "RRGGBB"
	fontName?: string
	showTitle?: boolean
	size?: number
	weight?: number
}

export function encodeLabelStyle(style: LabelStyle): Buffer {
	const json = {
		Align: style.align ?? 'bottom',
		Color: parseInt(style.color ?? 'FFFFFF', 16),
		FontName: style.fontName ?? 'Roboto',
		ShowTitle: style.showTitle ?? true,
		Size: style.size ?? 10,
		Weight: style.weight ?? 80,
	}
	return Buffer.from(JSON.stringify(json), 'utf8')
}

export interface SmallWindowData {
	mode?: SmallWindowMode
	cpu?: number
	mem?: number
	gpu?: number
	time?: string // HH:MM:SS
}

export function encodeSmallWindow(data: SmallWindowData): Buffer {
	const mode = data.mode ?? SmallWindowMode.CLOCK
	const cpu = data.cpu ?? 0
	const mem = data.mem ?? 0
	const gpu = data.gpu ?? 0
	const time = data.time ?? new Date().toISOString().substring(11, 19)
	return Buffer.from(`${mode}|${cpu}|${mem}|${time}|${gpu}`, 'utf8')
}
