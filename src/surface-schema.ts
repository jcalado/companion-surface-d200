import type { SurfacePincodeMap, SurfaceSchemaLayoutDefinition } from '@companion-surface/base'
import { ICON_HEIGHT, ICON_WIDTH, SMALL_WINDOW_BG_HEIGHT, SMALL_WINDOW_BG_WIDTH } from './protocol.js'

/**
 * The D200X has 14 physical LCD buttons in a 5×3 grid (including the small-window
 * touch area) plus 2 page buttons and 3 rotary encoders:
 *
 *   row 0: col 0  col 1  col 2  col 3  col 4
 *   row 1: col 0  col 1  col 2  col 3  col 4
 *   row 2: col 0  col 1  col 2  col 3  (small-window touch, 2 cells wide)
 *   row 3: [pg_L] enc1   enc2   enc3  [pg_R]
 *
 * The device emits indices 0–12 for the standard grid buttons, 13 for the
 * small-window touch area, 15/16 for page buttons, and 17–19 for encoders.
 */
export const LCD_BUTTON_POSITIONS: ReadonlyArray<{ col: number; row: number }> = [
	{ col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 }, { col: 3, row: 0 }, { col: 4, row: 0 },
	{ col: 0, row: 1 }, { col: 1, row: 1 }, { col: 2, row: 1 }, { col: 3, row: 1 }, { col: 4, row: 1 },
	{ col: 0, row: 2 }, { col: 1, row: 2 }, { col: 2, row: 2 }, { col: 3, row: 2 },
]

export type InputControlType = 'button' | 'encoder' | 'page'

interface InputControlDef {
	controlId: string
	type: InputControlType
	col: number
	row: number
}

interface VirtualControlDef {
	controlId: string
	col: number
	row: number
}

const VIRTUAL_ENCODER_TURN_CONTROLS: ReadonlyArray<VirtualControlDef> = [
	{ controlId: 'enc-1-left', col: 0, row: 4 },
	{ controlId: 'enc-1-right', col: 1, row: 4 },
	{ controlId: 'enc-2-left', col: 2, row: 4 },
	{ controlId: 'enc-2-right', col: 3, row: 4 },
	{ controlId: 'enc-3-left', col: 1, row: 5 },
	{ controlId: 'enc-3-right', col: 2, row: 5 },
]

/**
 * Complete input map for the D200X. Maps device input indices to control IDs.
 *
 * Indices 0–12: LCD grid buttons (same as D200)
 * Index 13: small-window slot (status display, not a button/control)
 * Index 14: does not exist
 * Index 15: left page button
 * Index 16: right page button
 * Index 17: encoder 1
 * Index 18: encoder 2
 * Index 19: encoder 3
 */
const INPUT_CONTROLS: ReadonlyArray<InputControlDef | null> = [
	{ controlId: '0-0', type: 'button', col: 0, row: 0 },
	{ controlId: '1-0', type: 'button', col: 1, row: 0 },
	{ controlId: '2-0', type: 'button', col: 2, row: 0 },
	{ controlId: '3-0', type: 'button', col: 3, row: 0 },
	{ controlId: '4-0', type: 'button', col: 4, row: 0 },
	{ controlId: '0-1', type: 'button', col: 0, row: 1 },
	{ controlId: '1-1', type: 'button', col: 1, row: 1 },
	{ controlId: '2-1', type: 'button', col: 2, row: 1 },
	{ controlId: '3-1', type: 'button', col: 3, row: 1 },
	{ controlId: '4-1', type: 'button', col: 4, row: 1 },
	{ controlId: '0-2', type: 'button', col: 0, row: 2 },
	{ controlId: '1-2', type: 'button', col: 1, row: 2 },
	{ controlId: '2-2', type: 'button', col: 2, row: 2 },
	{ controlId: '3-2', type: 'button', col: 3, row: 2 },
	null,
	{ controlId: 'page-left',  type: 'page',    col: 0, row: 3 },
	{ controlId: 'page-right', type: 'page',    col: 4, row: 3 },
	{ controlId: 'enc-1',      type: 'encoder', col: 1, row: 3 },
	{ controlId: 'enc-2',      type: 'encoder', col: 2, row: 3 },
	{ controlId: 'enc-3',      type: 'encoder', col: 3, row: 3 },
]

/** Companion control ids may only contain `[a-zA-Z0-9\-/]`, so grid buttons use `col-row`. */
export function controlIdFor(col: number, row: number): string {
	return `${col}-${row}`
}

export function controlIdFromIndex(index: number): string | null {
	return INPUT_CONTROLS[index]?.controlId ?? null
}

export function inputTypeFromIndex(index: number): InputControlType | null {
	return INPUT_CONTROLS[index]?.type ?? null
}

export function indexFromControlId(controlId: string): number | null {
	const idx = INPUT_CONTROLS.findIndex((p) => p?.controlId === controlId)
	return idx === -1 ? null : idx
}

export function positionFromControlId(controlId: string): { col: number; row: number } | null {
	const idx = indexFromControlId(controlId)
	const entry = idx !== null ? INPUT_CONTROLS[idx] : null
	if (!entry || entry.type !== 'button') return null
	return { col: entry.col, row: entry.row }
}

export function virtualTurnControlId(controlId: string, direction: 'left' | 'right'): string | null {
	if (controlId !== 'enc-1' && controlId !== 'enc-2' && controlId !== 'enc-3') return null
	return `${controlId}-${direction}`
}

/**
 * Numpad-style pincode entry: 7/8/9 on the top row, 4/5/6 middle,
 * 1/2/3 bottom, 0 next to 6. The small-window button (3-2) is available
 * as a general-purpose control but not assigned a pincode digit.
 */
export const PINCODE_MAP: SurfacePincodeMap = {
	type: 'single-page',
	pincode: null,
	7: '0-0', 8: '1-0', 9: '2-0',
	4: '0-1', 5: '1-1', 6: '2-1',
	1: '0-2', 2: '1-2', 3: '2-2',
	0: '3-1',
}

export function createSurfaceSchema(): SurfaceSchemaLayoutDefinition {
	const layout: SurfaceSchemaLayoutDefinition = {
		stylePresets: {
			default: {},
			button: {
				bitmap: { w: ICON_WIDTH, h: ICON_HEIGHT, format: 'rgb' },
			},
			wide: {
				bitmap: { w: SMALL_WINDOW_BG_WIDTH, h: SMALL_WINDOW_BG_HEIGHT, format: 'rgb' },
			},
		},
		controls: {},
	}
	for (const { col, row } of LCD_BUTTON_POSITIONS) {
		layout.controls[controlIdFor(col, row)] = {
			row,
			column: col,
			stylePreset: col === 3 && row === 2 ? 'wide' : 'button',
		}
	}
	for (const entry of INPUT_CONTROLS) {
		if (!entry || entry.type === 'button') continue
		layout.controls[entry.controlId] = {
			row: entry.row,
			column: entry.col,
		}
	}
	for (const entry of VIRTUAL_ENCODER_TURN_CONTROLS) {
		layout.controls[entry.controlId] = {
			row: entry.row,
			column: entry.col,
			stylePreset: 'button',
		}
	}
	return layout
}
