import type { SomeCompanionInputField } from '@companion-surface/base'
import { SmallWindowMode } from './protocol.js'

export const CONFIG_FIELDS: SomeCompanionInputField[] = [
	{
		id: 'smallWindowMode',
		type: 'dropdown',
		label: 'Small window display',
		choices: [
			{ id: String(SmallWindowMode.CLOCK), label: 'Clock' },
			{ id: String(SmallWindowMode.STATS), label: 'System stats (CPU / memory)' },
			{ id: String(SmallWindowMode.BACKGROUND), label: 'Background (from manifest)' },
		],
		default: String(SmallWindowMode.CLOCK),
	},
]

export function parseSmallWindowMode(value: unknown): SmallWindowMode {
	const n = Number(value)
	if (n === SmallWindowMode.STATS || n === SmallWindowMode.BACKGROUND || n === SmallWindowMode.CLOCK) return n
	return SmallWindowMode.CLOCK
}
