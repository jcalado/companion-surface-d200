# companion-surface-ulanzi-d200

Companion surface plugin for the **Ulanzi Stream Controller D200** — 13 physical
buttons on a 5×3 grid plus a status window, 196×196 px icons.

Built against [`@companion-surface/base`](https://github.com/bitfocus/companion-surface-api).
Wire protocol reverse-engineered with help from
[redphx/strmdck](https://github.com/redphx/strmdck) and USBPcap captures of
Ulanzi Studio.

## Quickstart (Linux)

> ⚠️ **Connect the D200 through a USB 2.0 hub**, not directly to the PC.
> Direct connection fails to enumerate the device on Linux. See
> [SETUP.md](./SETUP.md#direct-connection-vs-usb-hub) for the why.

You need **Companion 4.3.0+** and **Node 22**.

```bash
# 1. Build
yarn install
yarn build

# 2. Grant your user access to the device
sudo ./tools/install-udev.sh
# then unplug/replug the D200 (through the hub)

# 3. Make Companion see the plugin as a developer module
mkdir -p ~/companion-dev
ln -s "$(pwd)" ~/companion-dev/companion-surface-d200
```

In Companion's web UI:

1. **Settings → Advanced → Developer** — toggle **Enable Developer Modules** on,
   and set **Developer modules path** to `~/companion-dev`.
2. **Modules → Surfaces** — enable **Ulanzi Stream Controller D200**.
3. Plug in the D200 (through the hub). It appears under **Surfaces**.

For full details, platform-specific notes, and troubleshooting, see
[**SETUP.md**](./SETUP.md).

## Features

- 13 configurable buttons, each with a Companion-rendered icon
- Brightness control from Companion
- Button press/release events
- Small-window status display (clock / system stats), selectable per-surface
  via the ⚙ **Config** panel

## Development

```bash
yarn dev       # tsc --watch
yarn build     # → dist/
yarn package   # full package for Companion
```

## Not yet implemented

- Background-image mode for the small window (dropdown choice exists; needs
  manifest-side image push)
- `showStatus()` / `CardGenerator` idle card
- Pincode map
- Keyboard emulation on interface 1 (intentionally left to `usbhid`)

## License

MIT.
