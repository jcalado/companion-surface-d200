import type { SurfacePincodeMap, SurfaceSchemaLayoutDefinition } from '@companion-surface/base'
import { ICON_HEIGHT, ICON_WIDTH } from './protocol.js'
import { SMALL_WINDOW_SLOT } from './zip-builder.js'

/**
 * The D200 has 13 physical buttons in a non-uniform 5×3 grid:
 *
 *   row 0: col 0  col 1  col 2  col 3  col 4
 *   row 1: col 0  col 1  col 2  col 3  col 4
 *   row 2: col 0  col 1  col 2  [small window]  -
 *
 * The slot at (col 3, row 2) is the small-window status display (not a
 * button), and (col 4, row 2) does not exist.
 *
 * The device emits row-major button indices 0..12 (`idx = row*5 + col`).
 */
export const BUTTON_POSITIONS: ReadonlyArray<{ col: number; row: number }> = [
	{ col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 }, { col: 3, row: 0 }, { col: 4, row: 0 },
	{ col: 0, row: 1 }, { col: 1, row: 1 }, { col: 2, row: 1 }, { col: 3, row: 1 }, { col: 4, row: 1 },
	{ col: 0, row: 2 }, { col: 1, row: 2 }, { col: 2, row: 2 },
]

export function controlIdFromIndex(index: number): string | null {
	const pos = BUTTON_POSITIONS[index]
	if (!pos) return null
	return `${pos.col}_${pos.row}`
}

export function indexFromControlId(controlId: string): number | null {
	const idx = BUTTON_POSITIONS.findIndex((p) => `${p.col}_${p.row}` === controlId)
	return idx === -1 ? null : idx
}

export function positionFromControlId(controlId: string): { col: number; row: number } | null {
	const idx = indexFromControlId(controlId)
	return idx === null ? null : BUTTON_POSITIONS[idx]
}

/**
 * Numpad-style pincode entry: 7/8/9 on the top row, 4/5/6 middle, 1/2/3 bottom,
 * with 0 tucked next to 6 on the right (we have no usable fourth row on this
 * device). The small window occupies (3,2), so (4,1) sits beside it.
 */
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
	for (const { col, row } of BUTTON_POSITIONS) {
		layout.controls[`${col}_${row}`] = {
			row,
			column: col,
			stylePreset: 'button',
		}
	}
	// Reserve the small-window slot so Companion's grid doesn't repurpose it.
	void SMALL_WINDOW_SLOT
	return layout
}
