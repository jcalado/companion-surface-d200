# companion-surface-ulanzi-d200

Companion surface plugin for the **[Ulanzi Stream Controller D200](https://www.ulanzi.com/products/stream-controller-d200)**: 13 physical
buttons on a 5×3 grid plus a status window, 196×196 px icons.

Built against [`@companion-surface/base`](https://github.com/bitfocus/companion-surface-api).
Wire protocol reverse-engineered with help from
[redphx/strmdck](https://github.com/redphx/strmdck) and USBPcap captures of
Ulanzi Studio.

## Features

- 13 configurable buttons, each with a Companion-rendered icon
- Brightness control from Companion
- Button press/release events
- Small-window status display with seven modes (analog dial clock, four
  digital clock variants (time; time + weekday; time + date; date + time +
  weekday), system stats (CPU / RAM), or a custom background image),
  selectable per-surface via the ⚙ **Config** panel. Digital modes honour a
  12/24-hour checkbox. Background images are loaded from a local file path
  (PNG/JPEG), automatically resized and center-cropped to 458×196.

## Quickstart

Requires **Companion 4.3.0+** and **Node 22**.

```bash
yarn install
yarn build
```

Then register the build directory with Companion as a developer module and
enable it under **Modules → Surfaces**. Windows works out of the box; Linux
needs a udev rule and a USB 2.0 hub.

See [**SETUP.md**](./SETUP.md) for the full walkthrough, platform notes,
firmware quirks, and troubleshooting.

## Development

```bash
yarn dev       # tsc --watch
yarn build     # → dist/
yarn package   # full package for Companion
```

## Not yet implemented

- `showStatus()` / `CardGenerator` idle card
- Keyboard emulation on interface 1 (intentionally left to `usbhid`)

## Support the project

If this plugin is useful to you, you can buy me a coffee at
[ko-fi.com/jcalado](https://ko-fi.com/jcalado). Support helps keep the project
maintained and encourages future work (more surfaces, bug fixes, features).

## License

MIT.
