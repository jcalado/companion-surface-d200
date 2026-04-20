import type { SomeCompanionInputField } from '@companion-surface/base'
import { SmallWindowMode } from './protocol.js'

export const CONFIG_FIELDS: SomeCompanionInputField[] = [
	{
		id: 'smallWindowMode',
		type: 'dropdown',
		label: 'Small window display',
		choices: [
			{ id: String(SmallWindowMode.CLOCK), label: 'Analog dial clock' },
			{ id: String(SmallWindowMode.STATS), label: 'System stats (CPU / memory)' },
			{ id: String(SmallWindowMode.BACKGROUND), label: 'Background image' },
		],
		default: String(SmallWindowMode.CLOCK),
	},
	{
		id: 'backgroundImagePath',
		type: 'textinput',
		label: 'Background image path (PNG/JPEG, resized and cropped to 458×196)',
		default: '',
	},
]

export function parseSmallWindowMode(value: unknown): SmallWindowMode {
	const n = Number(value)
	if (n === SmallWindowMode.STATS || n === SmallWindowMode.BACKGROUND || n === SmallWindowMode.CLOCK) return n
	return SmallWindowMode.CLOCK
}
