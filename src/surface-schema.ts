import type { SurfaceSchemaLayoutDefinition } from '@companion-surface/base'
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
