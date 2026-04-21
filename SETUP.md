# Setup: Ulanzi D200 Companion plugin

## Supported platforms

| Platform | Status | Extra steps |
|----------|--------|-------------|
| Windows  | ✅ Works out of the box | None — just build and register as a developer module |
| Linux    | ⚠️ Works with workarounds | udev rule + USB 2.0 hub (see below) |
| macOS    | 🤷 Untested | Likely works like Windows; hidraw-style access is default |

Tested on:
- Windows 10/11 (direct USB connection)
- Arch Linux (kernel 6.19) with Companion 4.3.0 (via USB-2 hub)

## Required (all platforms)

- **Companion v4.3.0 or newer.** Earlier versions reject `"type": "surface"` in developer manifests (the surface plugin system landed in 4.3.0).
- **Node.js 22.x.** Matches Companion's `node22` runtime target. Companion spawns the plugin in its bundled Node; yarn/tsc on your workstation should also use Node 22 for local builds (mise/fnm/volta/nvm all fine).

## Linux-only

- **USB 2.0 hub between the D200 and the host.** See [Direct connection vs. USB hub](#direct-connection-vs-usb-hub) below — this is the single most important point. A plain unpowered USB-2 hub works.
- **udev rule** granting access to the device's `/dev/hidraw*` nodes.

## Build (all platforms)

```bash
cd d200
yarn install
yarn build
```

## Register the plugin with Companion (all platforms)

Companion scans subfolders of a developer modules path.

1. Create a folder (or reuse `~/companion-dev/` on Linux/macOS,
   `%USERPROFILE%\companion-dev\` on Windows) and put this project (or a
   symlink) inside it:

   ```bash
   # Linux / macOS
   mkdir -p ~/companion-dev
   ln -s "$(pwd)" ~/companion-dev/companion-surface-d200
   ```

   On Windows, either copy the project in or use `mklink /D`.

2. In Companion's web UI, open **Settings → Advanced → Developer**.
3. Toggle **Enable Developer Modules** on.
4. Click **Select** next to **Developer modules path** and pick the parent
   folder (not the project folder).
5. Companion logs:

   ```
   Instance/Modules  Looking for extra modules in: <path>
   Instance/Modules  Found new surface module ulanzi-d200@0.0.0 in: <path>/companion-surface-d200
   ```

6. Enable the module under **Modules → Surfaces → Ulanzi Stream Controller D200**.
7. Plug the D200 in. Companion lists it under **Surfaces**.

On Windows this is the whole setup. On Linux, continue with the steps below.

## Windows: quit Ulanzi Studio

> ⚠️ **Ulanzi Studio must not be running.** If Studio is open, or has been
> auto-launched in the background from the system tray, the D200 fires its
> standalone hotkey HID events (volume up/down, media keys, etc.) *in addition*
> to Companion button events, so every press triggers twice. Quit Studio fully,
> including any tray icon, and disable auto-start if it was installed.

## Linux: install the udev rule

```bash
sudo ./tools/install-udev.sh
```

This writes `/etc/udev/rules.d/70-ulanzi-d200.rules` with:

```
KERNEL=="hidraw*", ATTRS{idVendor}=="2207", ATTRS{idProduct}=="0019", MODE="0660", GROUP="input", TAG+="uaccess"
SUBSYSTEM=="usb",  ATTRS{idVendor}=="2207", ATTRS{idProduct}=="0019", MODE="0660", GROUP="input", TAG+="uaccess"
```

Unplug/replug the D200 (through the hub) after installing.

Verify:

```bash
ls -la /dev/hidraw* | tail -2
# crw-rw----+ ... /dev/hidraw7
# crw-rw----+ ... /dev/hidraw8
```

The `+` (or `@` in `eza`) indicates an ACL granting access to the active local user.

## Linux: direct connection vs. USB hub

**Symptom when connected directly:** the D200's screen lights up with its default buttons, but Companion never sees it. `lsusb` only shows the device as:

```
Bus 003 Device XXX: ID 18d1:d002 Google Inc. Nexus 4 (debug)
```

and no `/dev/hidraw*` is created for it.

### What's actually happening

The D200 firmware exposes **two USB devices concurrently**, over an internal hub:

| VID:PID     | Interface class      | Purpose                                                  |
|-------------|----------------------|----------------------------------------------------------|
| `18d1:d002` | Vendor-specific bulk | Dummy/residual (ADB-shaped descriptor, not used by Studio) |
| `2207:0019` | HID                  | **The real device.** Deck protocol + keyboard emulation  |

Windows enumerates both cleanly. Linux's xHCI/usbcore stack, when the D200 is plugged in directly, gets into a state where one of the two fails repeatedly. From `dmesg`:

```
usb 3-1: new high-speed USB device number 38 using xhci_hcd
usb 3-1: no configurations
usb 3-1: can't read configurations, error -22
usb 3-1: new high-speed USB device number 39 using xhci_hcd
usb 3-1: no configurations
usb 3-1: can't read configurations, error -22
usb usb3-port1: attempt power cycle
usb 3-1: new high-speed USB device number 40 using xhci_hcd
usb 3-1: New USB device found, idVendor=18d1, idProduct=d002, bcdDevice=ff.ff
```

Three attempts, two `can't read configurations, error -22` (EINVAL), a power-cycle, and only the `18d1:d002` device remains. The HID device that actually carries the deck protocol never completes enumeration.

If you poke at the surviving `18d1:d002` with libusb, every control transfer fails with `EPROTO` (USB protocol error), every submitted URB with `ENOENT` — `adb` has the same experience. That device is essentially a decoy from our perspective.

### Why a hub fixes it

Putting a USB-2 hub between the host and the D200 changes the enumeration timing and forces the device's internal hub to negotiate upstream through a second hub layer. Empirically, both child devices then enumerate cleanly:

```
Bus 005 Device 006: ID 2207:0019 Fuzhou Rockchip Electronics Company ulanzi
```

and `/dev/hidraw7` / `/dev/hidraw8` appear (interface 0: deck protocol, interface 1: keyboard emulation).

A plain USB-2 hub is enough; a powered hub is not required. USB-3 hubs also work but force the link to Gen1 anyway — USB-2 is simpler.

### Other things that did *not* work (documented so we don't retry them)

- Trying different direct USB ports (front panel, rear, USB-3-only, USB-2-only): same failure.
- `adb devices`: fails with `failed to clear halt on endpoint 0x82: LIBUSB_ERROR_OTHER`.
- `libusb_control_transfer(GET_STATUS)` to the `18d1:d002` device: `errno=71` (EPROTO).
- `libusb_set_interface_alt_setting(0)`: `errno=71` (EPROTO).
- Bulk OUT submission: `errno=2` (ENOENT) — kernel usbfs has no valid endpoint because the prior `SET_INTERFACE` failed.
- `modprobe -r xhci_hcd && modprobe xhci_hcd`: no effect; symptom is above the xHCI layer.

The short answer: we couldn't get the `18d1:d002` endpoint to respond to *anything*, standard or otherwise. A hub sidesteps the problem rather than solving it.

## Firmware quirks worth knowing

These are handled by the plugin, but useful if you're debugging.

- **ZIP "bad byte" offsets.** Each `OUT_SET_BUTTONS` upload is framed in 1024-byte interrupt packets. The firmware corrupts the upload if the byte at ZIP file offset `1016 + 1024·N` is `0x00` or `0x7c`. `src/zip-builder.ts` retries compression with a random-length dummy file appended until every such offset is safe.
- **Manifest layout.** Top-level files are `manifest.json` and `Images/<uuid>.png` — no `page/` prefix. Each button's `ViewParam[0]` must include a `Font` object (`Align`, `Color`, `FontName`, `ShowTitle`, `Size`, `Weight`). The slot at `3_2` must exist with `SmallViewMode: 1` (or `2` for background mode) even when we have nothing to put there, or the firmware may reject the update.
- **Grid shape.** 5 columns × 3 rows, but row 2 only has three real buttons (`0_2`, `1_2`, `2_2`). The 2-cell-wide slot at `(col 3, row 2)` is the small-window status display; `(col 4, row 2)` does not exist physically. Device button indices are row-major (`idx = row*5 + col`) over the 13 real buttons (0…12).

## Troubleshooting

```bash
# Is the HID device enumerating?
lsusb | grep 2207
# want: Bus 005 Device N: ID 2207:0019 Fuzhou Rockchip Electronics Company ulanzi

# Can Companion's user open hidraw nodes?
ls -la /dev/hidraw* | grep -- '+'

# Live Companion log
tail -f ~/.config/companion/logs/companion-*.log
```

Common log signatures:

- `Error: Unknown module type "surface" in manifest` — Companion is older than 4.3.0.
- `Error loading module ... Cannot find module '@companion-surface/base/package.json'` — ran `yarn install` in PnP mode; set `nodeLinker: node-modules` in `.yarnrc.yml` and reinstall.
- `Failed to open ... EACCES` — udev rule not applied; replug the device.
- Nothing appears under **Surfaces** despite a successful module load — almost always the direct-connect enumeration issue; switch to a USB hub.
