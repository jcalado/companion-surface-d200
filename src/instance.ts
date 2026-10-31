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
import { D200Device } from './device.js'
import {
	ICON_HEIGHT,
	ICON_WIDTH,
	SMALL_WINDOW_BG_HEIGHT,
	SMALL_WINDOW_BG_WIDTH,
	SmallWindowMode,
} from './protocol.js'
import { SMALL_WINDOW_DISABLED } from './config.js'
import { type ButtonRenderInput } from './zip-builder.js'
import {
	LCD_BUTTON_POSITIONS,
	controlIdFor,
	controlIdFromIndex,
	positionFromControlId,
	virtualTurnControlId,
} from './surface-schema.js'

export class D200Surface implements SurfaceInstance {
	readonly #logger: ModuleLogger
	readonly #surfaceId: string
	readonly #context: SurfaceContext
	readonly #device: D200Device

	/** Keyed by controlId (`col-row`). */
	readonly #pending = new Map<string, ButtonRenderInput>()
	readonly #renderCache = new Map<string, ButtonRenderInput>()
	#flushTimer?: NodeJS.Timeout
	#screensaverTimer?: NodeJS.Timeout
	#initialPushDone = false
	#statusActive = false
	#screensaverEnabled = false
	#screensaverMinutes = 5
	#screensaverActive = false
	#screensaverWaking = false
	#smallWindowMode: number = SMALL_WINDOW_DISABLED
	#pageButtonsNavigate = true

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
		this.#device.on('input', (event) => {
			void this.#handleInputEvent(event)
		})
		this.#device.on('deviceInfo', (info) => {
			this.#logger.info(`Device info: ${info}`)
		})
		this.#device.on('log', (line) => this.#logger.info(line))
	}

	#pulseVirtualControl(controlId: string, direction: 'left' | 'right'): void {
		const virtualId = virtualTurnControlId(controlId, direction)
		if (!virtualId) return
		this.#context.keyDownById(virtualId)
		this.#context.keyUpById(virtualId)
	}

	async #handleInputEvent(event: { index: number; type: 'button' | 'encoder'; action: 'press' | 'release' | 'left' | 'right' }): Promise<void> {
		const controlId = controlIdFromIndex(event.index)
		if (!controlId) return

		if (this.#screensaverActive) {
			if (this.#screensaverWaking) return
			await this.#wakeFromScreensaver()
			this.#resetScreensaverTimer()
			return
		}

		this.#recordActivity()

		if (event.type === 'encoder') {
			if (event.action === 'left') {
				this.#context.rotateLeftById(controlId)
				this.#pulseVirtualControl(controlId, 'left')
			}
			else if (event.action === 'right') {
				this.#context.rotateRightById(controlId)
				this.#pulseVirtualControl(controlId, 'right')
			}
			else if (event.action === 'press') this.#context.keyDownById(controlId)
			else if (event.action === 'release') this.#context.keyUpById(controlId)
		} else if (controlId === 'page-left') {
			if (this.#pageButtonsNavigate) {
				if (event.action === 'press') this.#context.changePage(false)
			} else {
				if (event.action === 'press') this.#context.keyDownById(controlId)
				else if (event.action === 'release') this.#context.keyUpById(controlId)
			}
		} else if (controlId === 'page-right') {
			if (this.#pageButtonsNavigate) {
				if (event.action === 'press') this.#context.changePage(true)
			} else {
				if (event.action === 'press') this.#context.keyDownById(controlId)
				else if (event.action === 'release') this.#context.keyUpById(controlId)
			}
		} else {
			if (event.action === 'press') this.#context.keyDownById(controlId)
			else if (event.action === 'release') this.#context.keyUpById(controlId)
		}
	}

	async init(): Promise<void> {
		for (const pos of LCD_BUTTON_POSITIONS) {
			const key = controlIdFor(pos.col, pos.row)
			const blank = { col: pos.col, row: pos.row }
			this.#pending.set(key, blank)
			this.#renderCache.set(key, blank)
		}
		await this.#flush(false)
		this.#initialPushDone = true
		this.#applySmallWindowConfig()
		this.#resetScreensaverTimer()
	}

	async close(): Promise<void> {
		if (this.#flushTimer) clearTimeout(this.#flushTimer)
		if (this.#screensaverTimer) clearTimeout(this.#screensaverTimer)
		await this.#device.close()
	}

	updateCapabilities(_caps: HostCapabilities): void {
		// not used
	}

	async updateConfig(config: Record<string, any>): Promise<void> {
		const mode = Number(config.smallWindowMode ?? SMALL_WINDOW_DISABLED)
		this.#smallWindowMode = mode
		this.#pageButtonsNavigate = config.pageButtonsNavigate !== false
		this.#screensaverEnabled = config.screensaverEnabled === true
		this.#screensaverMinutes = Number(config.screensaverMinutes || 5)
		this.#device.setTwelveHour(!!config.twelveHour)
		this.#applySmallWindowConfig()
		if (this.#screensaverActive && !this.#screensaverEnabled) {
			await this.#wakeFromScreensaver()
		}
		this.#resetScreensaverTimer()
	}

	async ready(): Promise<void> {}

	async setBrightness(percent: number): Promise<void> {
		await this.#device.setBrightness(percent)
	}

	async blank(): Promise<void> {
		for (const pos of LCD_BUTTON_POSITIONS) {
			this.#pending.set(controlIdFor(pos.col, pos.row), { col: pos.col, row: pos.row })
		}
		await this.#flush(false)
	}

	async draw(signal: AbortSignal, drawProps: SurfaceDrawProps): Promise<void> {
		const pos = positionFromControlId(drawProps.controlId)
		if (!pos) return
		const key = controlIdFor(pos.col, pos.row)
		const isSmallWindowSlot = pos.col === 3 && pos.row === 2

		if (!drawProps.image) {
			const blank = { col: pos.col, row: pos.row }
			this.#pending.set(key, blank)
			this.#renderCache.set(key, blank)
			if (this.#screensaverActive) return
			this.#scheduleFlush()
			return
		}

		const iconW = isSmallWindowSlot ? SMALL_WINDOW_BG_WIDTH : ICON_WIDTH
		const iconH = isSmallWindowSlot ? SMALL_WINDOW_BG_HEIGHT : ICON_HEIGHT

		const png = await imageRs.ImageTransformer.fromBuffer(
			drawProps.image,
			iconW,
			iconH,
			'rgb',
		).toEncodedImage('png')
		if (signal.aborted) return

		this.#pending.set(key, {
			col: pos.col,
			row: pos.row,
			iconPng: Buffer.from(png.buffer),
		})
		this.#renderCache.set(key, {
			col: pos.col,
			row: pos.row,
			iconPng: Buffer.from(png.buffer),
		})
		if (this.#screensaverActive) return
		this.#scheduleFlush()
	}

	async showStatus(signal: AbortSignal, cards: CardGenerator, _statusMessage?: string): Promise<void> {
		if (signal.aborted) return

		this.#pauseSmallWindowUpdates()

		const buttonPixels = await cards.generateLogoCard(SMALL_WINDOW_BG_WIDTH, SMALL_WINDOW_BG_HEIGHT, 'rgb')
		if (signal.aborted) return

		const buttonPng = await imageRs.ImageTransformer.fromBuffer(
			Buffer.from(buttonPixels),
			SMALL_WINDOW_BG_WIDTH,
			SMALL_WINDOW_BG_HEIGHT,
			'rgb',
		).toEncodedImage('png')
		if (signal.aborted) return

		const batch: ButtonRenderInput[] = LCD_BUTTON_POSITIONS.map((pos) => ({
			col: pos.col,
			row: pos.row,
			iconPng: Buffer.from(buttonPng.buffer),
		}))

		try {
			await this.#device.setButtons(batch, {
				partial: false,
				smallWindowMode: this.#smallWindowMode,
			})
			this.#statusActive = true
		} catch (e) {
			this.#logger.warn(`showStatus setButtons failed: ${(e as Error).message}`)
		}
	}

	#scheduleFlush(): void {
		if (this.#flushTimer) return
		this.#flushTimer = setTimeout(() => {
			this.#flushTimer = undefined
			void this.#flush(true)
		}, 75)
	}

	async #flush(partial: boolean): Promise<void> {
		if (this.#screensaverActive) return
		if (this.#pending.size === 0) return
		let isPartial = partial && this.#initialPushDone
		if (this.#statusActive) {
			this.#statusActive = false
			this.#resumeSmallWindowUpdates()
			isPartial = false
			for (const pos of LCD_BUTTON_POSITIONS) {
				const key = controlIdFor(pos.col, pos.row)
				if (!this.#pending.has(key)) this.#pending.set(key, { col: pos.col, row: pos.row })
			}
		}
		const batch = Array.from(this.#pending.values())
		this.#pending.clear()
		try {
			await this.#device.setButtons(batch, {
				partial: isPartial,
				smallWindowMode: this.#smallWindowMode,
			})
		} catch (e) {
			this.#logger.warn(`setButtons failed: ${(e as Error).message}`)
		}
	}

	#recordActivity(): void {
		if (this.#screensaverActive) {
			void this.#wakeFromScreensaver()
		}
		this.#resetScreensaverTimer()
	}

	#resetScreensaverTimer(): void {
		if (this.#screensaverTimer) {
			clearTimeout(this.#screensaverTimer)
			this.#screensaverTimer = undefined
		}
		if (!this.#screensaverEnabled || this.#screensaverMinutes <= 0) return
		this.#screensaverTimer = setTimeout(() => {
			void this.#activateScreensaver()
		}, this.#screensaverMinutes * 60 * 1000)
	}

	async #activateScreensaver(): Promise<void> {
		if (this.#screensaverActive) return
		this.#screensaverActive = true
		this.#pauseSmallWindowUpdates()
		try {
			await this.#device.lockScreen()
		} catch (e) {
			this.#logger.warn(`screensaver lock failed: ${(e as Error).message}`)
		}
	}

	async #wakeFromScreensaver(): Promise<void> {
		if (!this.#screensaverActive) return
		if (this.#screensaverWaking) return
		this.#screensaverWaking = true
		try {
			await this.#device.unlockScreen()
		} catch (e) {
			this.#logger.warn(`screensaver unlock failed: ${(e as Error).message}`)
			this.#screensaverWaking = false
			return
		}
		this.#screensaverActive = false
		if (this.#flushTimer) {
			clearTimeout(this.#flushTimer)
			this.#flushTimer = undefined
		}
		this.#restoreCachedButtonsToPending()
		this.#resumeSmallWindowUpdates()
		await this.#flushNow(false)
		this.#resetScreensaverTimer()
		this.#screensaverWaking = false
	}

	#restoreCachedButtonsToPending(): void {
		for (const pos of LCD_BUTTON_POSITIONS) {
			const key = controlIdFor(pos.col, pos.row)
			this.#pending.set(key, this.#renderCache.get(key) ?? { col: pos.col, row: pos.row })
		}
	}

	async #flushNow(partial: boolean): Promise<void> {
		const wasActive = this.#screensaverActive
		this.#screensaverActive = false
		try {
			await this.#flush(partial)
		} finally {
			this.#screensaverActive = wasActive
		}
	}

	#applySmallWindowConfig(): void {
		if (this.#smallWindowMode === SMALL_WINDOW_DISABLED) {
			this.#device.setSmallWindowMode(SmallWindowMode.BACKGROUND)
			this.#device.pauseKeepAlive()
		} else {
			this.#device.setSmallWindowMode(this.#smallWindowMode)
			this.#device.resumeKeepAlive()
		}
	}

	#pauseSmallWindowUpdates(): void {
		this.#device.pauseKeepAlive()
	}

	#resumeSmallWindowUpdates(): void {
		if (this.#smallWindowMode !== SMALL_WINDOW_DISABLED) {
			this.#device.resumeKeepAlive()
		}
	}
}
