# companion-surface-ulanzi-d200

Companion surface plugin for the **[Ulanzi Stream Controller D200](https://www.ulanzi.com/products/stream-controller-d200)** — 13 physical
buttons on a 5×3 grid plus a status window, 196×196 px icons.

Built against [`@companion-surface/base`](https://github.com/bitfocus/companion-surface-api).
Wire protocol reverse-engineered with help from
[redphx/strmdck](https://github.com/redphx/strmdck) and USBPcap captures of
Ulanzi Studio.

## Quickstart

You need **Companion 4.3.0+** and **Node 22**.

```bash
yarn install
yarn build
```

Register the built plugin with Companion as a developer module: create a folder
(e.g. `~/companion-dev/`) and put this project (or a symlink to it) inside.
Then in Companion's web UI:

1. **Settings → Advanced → Developer** — toggle **Enable Developer Modules** on,
   and set **Developer modules path** to the parent folder.
2. **Modules → Surfaces** — enable **Ulanzi Stream Controller D200**.
3. Plug in the D200. It appears under **Surfaces**.

### Windows

That's it — no driver, no udev rule, no hub needed. Plug the D200 directly into
the PC and it works.

> ⚠️ **Ulanzi Studio must not be running.** If Studio is open (or has been
> auto-launched in the background / from the system tray), the D200 will fire
> its standalone hotkey HID events (volume up/down, media keys, etc.) *in
> addition* to Companion button events, so every press triggers twice. Quit
> Studio fully — including any tray icon — and disable auto-start if it was
> installed.

### Linux

Two extra steps:

```bash
# Grant your user access to the device's hidraw nodes
sudo ./tools/install-udev.sh
# then unplug/replug the D200
```

> ⚠️ **Connect the D200 through a USB 2.0 hub**, not directly to the PC.
> Direct connection fails to enumerate the HID interface on Linux. See
> [SETUP.md](./SETUP.md#direct-connection-vs-usb-hub) for the diagnosis.

For full details and troubleshooting, see [**SETUP.md**](./SETUP.md).

## Features

- 13 configurable buttons, each with a Companion-rendered icon
- Brightness control from Companion
- Button press/release events
- Small-window status display with seven modes — analog dial clock, four
  digital clock variants (time; time + weekday; time + date; date + time +
  weekday), system stats (CPU / RAM), or a custom background image —
  selectable per-surface via the ⚙ **Config** panel. Digital modes honour a
  12/24-hour checkbox. Background images are loaded from a local file path
  (PNG/JPEG), automatically resized and center-cropped to 458×196.

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
