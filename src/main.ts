import {
	createModuleLogger,
	type DiscoveredSurfaceInfo,
	type HIDDevice,
	type OpenSurfaceResult,
	type SurfaceContext,
	type SurfacePlugin,
} from '@companion-surface/base'
import { HIDAsync } from 'node-hid'
import { CONFIG_FIELDS } from './config.js'
import { D200Surface } from './instance.js'
import { D200_INTERFACE_NUMBER, D200_PRODUCT_ID, D200_VENDOR_ID } from './protocol.js'
import { PINCODE_MAP, createSurfaceSchema } from './surface-schema.js'

export interface D200PluginInfo {
	device: HIDDevice
}

const logger = createModuleLogger('Plugin')

const D200Plugin: SurfacePlugin<D200PluginInfo> = {
	async init() {
		logger.info('Ulanzi D200 plugin initialized')
	},

	async destroy() {
		/* no-op */
	},

	checkSupportsHidDevice(device: HIDDevice): DiscoveredSurfaceInfo<D200PluginInfo> | null {
		if (device.vendorId !== D200_VENDOR_ID || device.productId !== D200_PRODUCT_ID) return null
		// Only claim interface 0 (deck protocol). Interface 1 is the keyboard emulation
		// which should stay bound to usbhid so host hotkeys keep working.
		if (device.interface !== D200_INTERFACE_NUMBER && device.interface !== -1) return null
		return {
			surfaceId: `ulanzi-d200:${device.serialNumber ?? device.path}`,
			description: 'Ulanzi Stream Controller D200',
			pluginInfo: { device },
		}
	},

	async openSurface(
		surfaceId: string,
		pluginInfo: D200PluginInfo,
		context: SurfaceContext,
	): Promise<OpenSurfaceResult> {
		const device = await HIDAsync.open(pluginInfo.device.path).catch((e) => {
			throw new Error(`Failed to open ${pluginInfo.device.path}: ${(e as Error).message}`)
		})
		logger.info(`Opening D200 at ${pluginInfo.device.path} (${surfaceId})`)

		return {
			surface: new D200Surface(surfaceId, device, context),
			registerProps: {
				brightness: true,
				surfaceLayout: createSurfaceSchema(),
				pincodeMap: PINCODE_MAP,
				configFields: CONFIG_FIELDS,
				location: null,
			},
		}
	},
}

export default D200Plugin
