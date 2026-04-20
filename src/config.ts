import type { SomeCompanionInputField } from '@companion-surface/base'
import { SmallWindowMode, isValidSmallWindowMode } from './protocol.js'

export const CONFIG_FIELDS: SomeCompanionInputField[] = [
	{
		id: 'smallWindowMode',
		type: 'dropdown',
		label: 'Small window display',
		choices: [
			{ id: String(SmallWindowMode.DIAL), label: 'Analog dial clock' },
			{ id: String(SmallWindowMode.DIGITAL_TIME), label: 'Digital: time' },
			{ id: String(SmallWindowMode.DIGITAL_TIME_WEEKDAY), label: 'Digital: time + weekday' },
			{ id: String(SmallWindowMode.DIGITAL_TIME_DATE), label: 'Digital: time + date' },
			{ id: String(SmallWindowMode.DIGITAL_DATE_TIME_WEEKDAY), label: 'Digital: date + time + weekday' },
			{ id: String(SmallWindowMode.STATS), label: 'System stats (CPU / memory)' },
			{ id: String(SmallWindowMode.BACKGROUND), label: 'Background image' },
		],
		default: String(SmallWindowMode.DIAL),
	},
	{
		id: 'twelveHour',
		type: 'checkbox',
		label: 'Use 12-hour clock (digital modes)',
		default: false,
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
	return isValidSmallWindowMode(n) ? n : SmallWindowMode.DIAL
}
