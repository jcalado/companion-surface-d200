import {
	type CardGenerator,
	type HostCapabilities,
	type SurfaceContext,
	type SurfaceDrawProps,
	type SurfaceInstance,
	createModuleLogger,
	type ModuleLogger,
} from '@companion-surface/base'
import * as imageRs from '@julusian/image-rs'
import type { HIDAsync } from 'node-hid'
import { parseSmallWindowMode } from './config.js'
import { D200Device } from './device.js'
import { ICON_HEIGHT, ICON_WIDTH } from './protocol.js'
import { type ButtonRenderInput } from './zip-builder.js'
import { BUTTON_POSITIONS, controlIdFromIndex, positionFromControlId } from './surface-schema.js'

export class D200Surface implements SurfaceInstance {
	readonly #logger: ModuleLogger
	readonly #surfaceId: string
	readonly #context: SurfaceContext
	readonly #device: D200Device

	/** Keyed by controlId (`col_row`). */
	readonly #pending = new Map<string, ButtonRenderInput>()
	#flushTimer?: NodeJS.Timeout
	#initialPushDone = false

	public get surfaceId(): string {
		return this.#surfaceId
	}
	public get productName(): string {
		return 'Ulanzi Stream Controller D200'
	}

	constructor(surfaceId: string, device: HIDAsync, context: SurfaceContext) {
		this.#logger = createModuleLogger(`Instance/${surfaceId}`)
		this.#surfaceId = surfaceId
		this.#context = context
		this.#device = new D200Device(device)

		this.#device.on('error', (e) => {
			this.#logger.error(`D200 error: ${e.message}`)
			context.disconnect(e)
		})
		this.#device.on('button', ({ index, pressed }) => {
			const controlId = controlIdFromIndex(index)
			if (!controlId) return
			if (pressed) this.#context.keyDownById(controlId)
			else this.#context.keyUpById(controlId)
		})
		this.#device.on('deviceInfo', (info) => {
			this.#logger.info(`Device info: ${info}`)
		})
		this.#device.on('log', (line) => this.#logger.info(line))
	}

	async init(): Promise<void> {
		for (const pos of BUTTON_POSITIONS) {
			const key = `${pos.col}_${pos.row}`
			this.#pending.set(key, { col: pos.col, row: pos.row })
		}
		await this.#flush(false)
		this.#initialPushDone = true
	}

	async close(): Promise<void> {
		if (this.#flushTimer) clearTimeout(this.#flushTimer)
		await this.#device.close()
	}

	updateCapabilities(_caps: HostCapabilities): void {
		// not used
	}

	async updateConfig(config: Record<string, any>): Promise<void> {
		if (config.smallWindowMode !== undefined) {
			this.#device.setSmallWindowMode(parseSmallWindowMode(config.smallWindowMode))
		}
	}

	async ready(): Promise<void> {}

	async setBrightness(percent: number): Promise<void> {
		await this.#device.setBrightness(percent)
	}

	async blank(): Promise<void> {
		for (const pos of BUTTON_POSITIONS) {
			this.#pending.set(`${pos.col}_${pos.row}`, { col: pos.col, row: pos.row })
		}
		await this.#flush(false)
	}

	async draw(signal: AbortSignal, drawProps: SurfaceDrawProps): Promise<void> {
		const pos = positionFromControlId(drawProps.controlId)
		if (!pos) return
		const key = `${pos.col}_${pos.row}`

		if (!drawProps.image) {
			this.#pending.set(key, { col: pos.col, row: pos.row })
			this.#scheduleFlush()
			return
		}

		const png = await imageRs.ImageTransformer.fromBuffer(
			drawProps.image,
			ICON_WIDTH,
			ICON_HEIGHT,
			'rgb',
		).toEncodedImage('png')
		if (signal.aborted) return

		this.#pending.set(key, {
			col: pos.col,
			row: pos.row,
			iconPng: Buffer.from(png.buffer),
		})
		this.#scheduleFlush()
	}

	async showStatus(_signal: AbortSignal, _cards: CardGenerator): Promise<void> {
		// not implemented
	}

	#scheduleFlush(): void {
		if (this.#flushTimer) return
		this.#flushTimer = setTimeout(() => {
			this.#flushTimer = undefined
			void this.#flush(true)
		}, 75)
	}

	async #flush(partial: boolean): Promise<void> {
		if (this.#pending.size === 0) return
		const batch = Array.from(this.#pending.values())
		this.#pending.clear()
		try {
			await this.#device.setButtons(batch, { partial: partial && this.#initialPushDone })
		} catch (e) {
			this.#logger.warn(`setButtons failed: ${(e as Error).message}`)
		}
	}
}
