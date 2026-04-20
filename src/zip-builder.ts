import JSZip from 'jszip'
import { randomBytes, randomUUID } from 'node:crypto'
import { FIRST_CHUNK_DATA, PACKET_SIZE, isPayloadSafe } from './protocol.js'

export interface ButtonRenderInput {
	col: number
	row: number
	name?: string
	/** PNG-encoded icon; omit for a blank slot. */
	iconPng?: Buffer
}

interface FontStyle {
	Align: 'bottom' | 'middle' | 'top'
	Color: number
	FontName: string
	ShowTitle: boolean
	Size: number
	Weight: number
}

interface ViewParam {
	Font: FontStyle
	Icon?: string
	Text?: string
}

interface ManifestEntry {
	State: number
	ViewParam: ViewParam[]
	SmallViewMode?: number
}

const DEFAULT_FONT: FontStyle = {
	Align: 'bottom',
	Color: 0xffffff,
	FontName: 'Source Han Sans SC',
	ShowTitle: true,
	Size: 10,
	Weight: 80,
}

/** Slot occupied by the small-window status display. */
export const SMALL_WINDOW_SLOT = { col: 3, row: 2 }

export interface BuildButtonZipOptions {
	/** PNG for the 458×196 small-window background. When present, `3_2` is built with SmallViewMode:2 + Icon. */
	backgroundPng?: Buffer
	/**
	 * Whether to emit the `3_2` small-window slot in the manifest.
	 * Full SET_BUTTONS updates should include it (firmware may reject the upload otherwise).
	 * PARTIAL_UPDATE should omit it so we don't re-upload a large background PNG on every
	 * button change — the slot persists from the last full upload.
	 */
	includeSmallWindowSlot?: boolean
}

/**
 * Build the ZIP payload the D200 expects. Structure mirrors what Ulanzi Studio
 * sends (captured via USBPcap):
 *
 *   manifest.json            — at archive root
 *   Images/<uuid>.png        — icons referenced from the manifest
 *
 * The firmware has a bug where the byte at offsets 1016, 1016+1024, ... must
 * not be 0x00 or 0x7c. We retry compression with a random dummy file until
 * the payload is safe.
 */
export async function buildButtonZip(
	buttons: ButtonRenderInput[],
	options: BuildButtonZipOptions = {},
): Promise<Buffer> {
	const manifest: Record<string, ManifestEntry> = {}
	const icons = new Map<string, Buffer>()

	for (const button of buttons) {
		const key = `${button.col}_${button.row}`
		const viewParam: ViewParam = { Font: DEFAULT_FONT }
		if (button.name) viewParam.Text = button.name
		if (button.iconPng) {
			const iconId = randomUUID()
			viewParam.Icon = `Images/${iconId}.png`
			icons.set(iconId, button.iconPng)
		}
		manifest[key] = { State: 0, ViewParam: [viewParam] }
	}

	// The small-window slot must be declared on every full SET_BUTTONS upload,
	// otherwise the firmware may refuse the whole update. When the user has set a
	// background image, this slot carries SmallViewMode:2 and an Icon; otherwise
	// SmallViewMode:1 (dial clock placeholder, also used for stats / digital).
	// Partial updates omit this slot so we don't re-upload the background on every
	// button change — the slot persists from the last full upload.
	if (options.includeSmallWindowSlot ?? true) {
		const smallKey = `${SMALL_WINDOW_SLOT.col}_${SMALL_WINDOW_SLOT.row}`
		if (options.backgroundPng) {
			const iconId = randomUUID()
			icons.set(iconId, options.backgroundPng)
			manifest[smallKey] = {
				State: 0,
				SmallViewMode: 2,
				ViewParam: [{ Font: DEFAULT_FONT, Icon: `Images/${iconId}.png`, Text: '' }],
			}
		} else {
			manifest[smallKey] = {
				State: 0,
				SmallViewMode: 1,
				ViewParam: [{ Font: DEFAULT_FONT, Text: '' }],
			}
		}
	}

	let payload = await compress(manifest, icons, '')
	let retries = 0
	while (!isPayloadSafe(payload)) {
		retries++
		if (retries > 64) throw new Error('Failed to build D200-safe ZIP after 64 retries')
		const dummy = randomBytes(8 * retries).toString('hex')
		payload = await compress(manifest, icons, dummy)
	}
	return payload
}

async function compress(
	manifest: Record<string, ManifestEntry>,
	icons: Map<string, Buffer>,
	dummy: string,
): Promise<Buffer> {
	const zip = new JSZip()
	zip.file('manifest.json', JSON.stringify(manifest))
	if (dummy) zip.file('dummy.txt', dummy)
	const imagesDir = zip.folder('Images')!
	for (const [id, data] of icons) imagesDir.file(`${id}.png`, data)
	return zip.generateAsync({
		type: 'nodebuffer',
		compression: 'DEFLATE',
		compressionOptions: { level: 1 },
	})
}

export function findUnsafeOffsets(payload: Buffer): number[] {
	const offsets: number[] = []
	for (let i = FIRST_CHUNK_DATA; i < payload.length; i += PACKET_SIZE) {
		const b = payload[i]
		if (b === 0x00 || b === 0x7c) offsets.push(i)
	}
	return offsets
}
