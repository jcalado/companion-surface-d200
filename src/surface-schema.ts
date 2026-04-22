import type { SurfacePincodeMap, SurfaceSchemaLayoutDefinition } from '@companion-surface/base'
import { ICON_HEIGHT, ICON_WIDTH } from './protocol.js'
import { SMALL_WINDOW_SLOT } from './zip-builder.js'

/**
 * The D200/D200X has 13 physical LCD buttons in a non-uniform 5×3 grid:
 *
 *   row 0: col 0  col 1  col 2  col 3  col 4
 *   row 1: col 0  col 1  col 2  col 3  col 4
 *   row 2: col 0  col 1  col 2  [small window]  -
 *
 * The slot at (col 3, row 2) is the small-window status display (not a
 * button), and (col 4, row 2) does not exist.
 *
 * The device emits row-major button indices 0..12 (idx = row*5 + col).
 */
export const LCD_BUTTON_POSITIONS: ReadonlyArray<{ col: number; row: number }> = [
	{ col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 }, { col: 3, row: 0 }, { col: 4, row: 0 },
	{ col: 0, row: 1 }, { col: 1, row: 1 }, { col: 2, row: 1 }, { col: 3, row: 1 }, { col: 4, row: 1 },
	{ col: 0, row: 2 }, { col: 1, row: 2 }, { col: 2, row: 2 },
]

export type InputControlType = 'button' | 'encoder' | 'page'

interface InputControlDef {
	controlId: string
	type: InputControlType
	col: number
	row: number
}

/**
 * Complete input map for the D200X. Maps device input indices to control IDs.
 *
 * Indices 0–12: LCD grid buttons (same as D200)
 * Index 13: unknown (state=200 observed, possibly a special/system button)
 * Index 14: unused
 * Index 15: left page button
 * Index 16: right page button
 * Index 17: encoder 1
 * Index 18: encoder 2
 * Index 19: encoder 3
 */
const INPUT_CONTROLS: ReadonlyArray<InputControlDef | null> = [
	{ controlId: '0_0', type: 'button', col: 0, row: 0 },
	{ controlId: '1_0', type: 'button', col: 1, row: 0 },
	{ controlId: '2_0', type: 'button', col: 2, row: 0 },
	{ controlId: '3_0', type: 'button', col: 3, row: 0 },
	{ controlId: '4_0', type: 'button', col: 4, row: 0 },
	{ controlId: '0_1', type: 'button', col: 0, row: 1 },
	{ controlId: '1_1', type: 'button', col: 1, row: 1 },
	{ controlId: '2_1', type: 'button', col: 2, row: 1 },
	{ controlId: '3_1', type: 'button', col: 3, row: 1 },
	{ controlId: '4_1', type: 'button', col: 4, row: 1 },
	{ controlId: '0_2', type: 'button', col: 0, row: 2 },
	{ controlId: '1_2', type: 'button', col: 1, row: 2 },
	{ controlId: '2_2', type: 'button', col: 2, row: 2 },
	null,
	null,
	{ controlId: 'page_left',  type: 'page',    col: 0, row: 3 },
	{ controlId: 'page_right', type: 'page',    col: 4, row: 3 },
	{ controlId: 'enc_1',      type: 'encoder', col: 1, row: 3 },
	{ controlId: 'enc_2',      type: 'encoder', col: 2, row: 3 },
	{ controlId: 'enc_3',      type: 'encoder', col: 3, row: 3 },
]

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
	if (!entry) return null
	return { col: entry.col, row: entry.row }
}

export const PINCODE_MAP: SurfacePincodeMap = {
	type: 'single-page',
	pincode: null,
	7: '0_0', 8: '1_0', 9: '2_0',
	4: '0_1', 5: '1_1', 6: '2_1',
	1: '0_2', 2: '1_2', 3: '2_2',
	0: '3_1',
}

export function createSurfaceSchema(): SurfaceSchemaLayoutDefinition {
	const layout: SurfaceSchemaLayoutDefinition = {
		stylePresets: {
			default: {},
			button: {
				bitmap: { w: ICON_WIDTH, h: ICON_HEIGHT, format: 'rgb' },
			},
		},
		controls: {},
	}
	for (const { col, row } of LCD_BUTTON_POSITIONS) {
		layout.controls[`${col}_${row}`] = {
			row,
			column: col,
			stylePreset: 'button',
		}
	}
	for (const entry of INPUT_CONTROLS) {
		if (!entry || entry.type === 'button') continue
		layout.controls[entry.controlId] = {
			row: entry.row,
			column: entry.col,
		}
	}
	void SMALL_WINDOW_SLOT
	return layout
}
