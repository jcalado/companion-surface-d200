# Ulanzi Stream Controller D200 — wire protocol

Reverse-engineered from:
- [redphx/strmdck](https://github.com/redphx/strmdck) (Python, MIT)
- USBPcap captures of Ulanzi Studio on Windows
- Firmware v5.3.1 binary analysis (see `FIRMWARE.md`)

Everything here is based on firmware `5.3.1` (the version shipped in
`Win_Ulanzi_Studio_V3.0.16.20260323.exe`). Other firmware revisions may differ
in manifest keys or command numbers.

## Platform

The D200 runs an **Allwinner T113** SoC (ARM Cortex-A7, hard-float) with an
OpenWrt-based Linux (glibc, kernel 3.2+). The main application is a C++
binary (`zkgui`) built on ZKSWE's EasyUI framework. A separate MCU handles
button/knob scanning and is connected to the T113 over UART (`/dev/ttyS1`).

The USB stack uses Linux's gadget subsystem: `/dev/hidg0` for the deck
protocol (interface 0) and `/dev/hidg1` for keyboard emulation (interface 1).
The USB VID `2207` is Rockchip's, reused by the ZKSWE firmware rather than
reflecting the actual SoC vendor.

The `18d1:d002` companion device uses Google's ADB vendor ID. ADB support is
likely present in the firmware but disabled in production builds. Source
references include `/sys/devices/soc0/soc/soc:usbotg/usb_device` for USB
mode switching.

---

## USB enumeration

The D200 presents **two USB devices simultaneously** behind an internal hub:

| VID:PID     | Purpose                                    | Used by plugin |
|-------------|--------------------------------------------|----------------|
| `18d1:d002` | Vendor-specific bulk — dummy/ADB-shaped    | No             |
| `2207:0019` | HID (Rockchip VID) — deck protocol         | **Yes**        |

The `2207:0019` device has two HID interfaces:

| Interface | Purpose                                | Bound driver |
|-----------|----------------------------------------|--------------|
| `0`       | Deck protocol (this document)          | Claimed by the plugin |
| `1`       | HID keyboard emulation (standalone hotkeys) | Host `usbhid` — untouched |

Interface 0 exposes two **interrupt** endpoints, each with `wMaxPacketSize = 1024`:

- `0x01 OUT` — host → device
- `0x82 IN`  — device → host

Polling interval is 1 ms.

### Descriptor excerpt

```
idVendor:           0x2207 (Fuzhou Rockchip Electronics)
idProduct:          0x0019
iProduct:           "ulanzi"
iManufacturer:      "Zkswe"
iSerial:            e.g. "02C47A015U3672401"
bcdDevice:          0xffff

Interface 0:
  bInterfaceClass    = 0x03 (HID)
  bInterfaceSubClass = 0x00
  bInterfaceProtocol = 0x00
  Endpoints:
    0x82 IN  Interrupt  1024B  bInterval=1
    0x01 OUT Interrupt  1024B  bInterval=1
```

---

## Wire framing

All packets — incoming and outgoing — are **exactly 1024 bytes**.

### Outgoing framed packet (host → device)

Used for every command sent by the host.

```
 Offset  Size  Field
    0     2   magic    = 0x7c 0x7c
    2     2   command  (u16, big-endian)
    4     4   length   (u32, little-endian) — payload length in bytes
    8  1016   data     (command-specific payload, zero-padded)
```

The `length` field is always the total payload size in bytes, even when
`data` only contains the first 1016 bytes because the payload is chunked
across multiple packets.

### Chunked uploads

`OUT_SET_BUTTONS` / `OUT_PARTIALLY_UPDATE_BUTTONS` carry a ZIP body too large
for one packet. The stream is:

1. **First packet**: framed as above, with `length = <total ZIP size>` and
   `data` containing the first 1016 bytes of the ZIP.
2. **Subsequent packets**: raw 1024-byte chunks of the ZIP body (no `0x7c 0x7c`
   header, no length field). The last chunk is zero-padded to 1024 bytes.

The device concatenates the `data` section of the first packet with all the
following chunks until it has accumulated `length` bytes, then decodes the ZIP.

### Incoming packet (device → host)

Same layout as outgoing, always 1024 bytes:

```
    0     2   magic    = 0x7c 0x7c
    2     2   command
    4     4   length
    8     N   data
```

Incoming commands observed so far:

| Command | Value  | Meaning |
|---------|--------|---------|
| `IN_BUTTON`      | `0x0101` | Button press or release event |
| `IN_DEVICE_INFO` | `0x0303` | Firmware/device info (JSON, sent after most OUT commands) |
| `0x010b`         | `0x010b` | Ack/status (seen after each outgoing command). Payload is all zeros so far; safe to ignore. |

### Additional command IDs found in firmware strings

These internal protocol IDs were discovered via firmware binary analysis. They
are referenced in the device's C++ source (`hid_protocol.cpp`) and may
correspond to undiscovered wire command numbers:

| Internal name | Notes |
|---------------|-------|
| `SETKEYPAD` | May configure button/key mappings |
| `SETSCREEN_PIC` | Possibly a direct screen-image push (bypassing the ZIP manifest) |
| `SET_SMALLWINDOW_TO_KNOB` | Displays knob-related content in the small window (dead on D200, which has no knob hardware) |
| `DRAW_JS_IMG` | JSON-manifest image push with `data:image/` URI support (see [DRAW_JS_IMG](#draw_js_img)) |
| `LOCKSCREEN` / `UNLOCKSCREEN` | Lock/unlock the device display; `UNLOCKSCREEN` takes an ID parameter |
| `UPDATE_BIN` | Host-initiated firmware update over HID |
| `APP_EXIT` | Terminates the running application |
| `SHUTDOWN` | Powers off the device |
| `RUN_RESULT` | Status/result reporting (direction unknown) |

None of these have been captured on the wire yet. Probing for their command
numbers (sending candidate values and observing responses) could unlock new
functionality.

---

## Command reference

### `OUT_SET_BRIGHTNESS = 0x000a`

Sets backlight brightness, 0–100.

- **Payload**: ASCII integer, e.g. `"30"` for 30%.

### `OUT_SET_LABEL_STYLE = 0x000b`

Sets the **default** font style used when a button has no per-button `Font`
object in the manifest. Ulanzi Studio sends this once at init. Per-button
styles in the manifest override this.

- **Payload**: UTF-8 JSON object:

```json
{
  "Align":     "bottom",
  "Color":     16777215,
  "FontName":  "Source Han Sans SC",
  "ShowTitle": true,
  "Size":      10,
  "Weight":    80
}
```

### `OUT_SET_SMALL_WINDOW_DATA = 0x0006`

Updates the status window (the 2-cell-wide area at `(col 3, row 2)`).

- **Payload**: pipe-separated ASCII string:

  ```
  <mode>|<cpu>|<mem>|HH:MM:SS|<gpu>
  ```

  Example: `1|9|64|16:23:04|0`

  | Field | Value |
  |-------|-------|
  | `mode` | `0` = stats, `1` = clock, `2` = background image |
  | `cpu` / `mem` / `gpu` | Integers 0–100 (percent). Used by mode `0`. |
  | `HH:MM:SS` | 24-hour local time. Used by mode `1`. |

Studio sends this roughly every 5 s as a keep-alive; the plugin does the same.
A longer `12H|...` tail has been observed in captures but its meaning isn't
known yet.

### `OUT_SET_BUTTONS = 0x0001`

Full replacement of all button icons + labels.

- **Payload**: chunked ZIP archive. See [ZIP format](#zip-format).

### `OUT_PARTIALLY_UPDATE_BUTTONS = 0x000d`

Same wire format as `OUT_SET_BUTTONS`, but the manifest only needs to include
the slots that are changing. The firmware merges the ZIP with its existing
state rather than replacing it.

### `IN_BUTTON = 0x0101`

Sent on every button press and release.

- **Payload** (4 bytes):

  | Offset | Size | Field |
  |--------|------|-------|
  | 0 | 1 | `state`   — page/state index (almost always `1` for us) |
  | 1 | 1 | `index`   — button index, 0–12, row-major in the 5×3 grid |
  | 2 | 1 | constant `0x01` |
  | 3 | 1 | `pressed` — `0x01` = press, `0x00` = release |

### `IN_DEVICE_INFO = 0x0303`

JSON blob describing the device. Seen after almost every successful OUT
command as a confirmation/keep-alive.

Example (reformatted):

```json
{
  "SerialNumber": "02C47A015U3672401",
  "Dversion": "...",
  ...
}
```

---

## Grid and button indexing

```
┌─────┬─────┬─────┬─────┬─────┐
│ 0_0 │ 1_0 │ 2_0 │ 3_0 │ 4_0 │  row 0  →  idx 0..4
├─────┼─────┼─────┼─────┼─────┤
│ 0_1 │ 1_1 │ 2_1 │ 3_1 │ 4_1 │  row 1  →  idx 5..9
├─────┼─────┼─────┼─────┴─────┤
│ 0_2 │ 1_2 │ 2_2 │  3_2 + 4_2 (small window) │  row 2  →  idx 10..12
└─────┴─────┴─────┴───────────┘
```

- The grid is **5 columns × 3 rows** addressed as `{col}_{row}`.
- There are **13 physical buttons** at positions (col 0–4, row 0), (col 0–4, row 1),
  and (col 0–2, row 2).
- The slot at `(col 3, row 2)` is the **small window** status display, spanning
  the width of two cells. Its manifest entry carries `SmallViewMode: 1` (clock)
  or `2` (background image). `(col 4, row 2)` does not exist physically.
- The device's `IN_BUTTON` reports indices **0–12** in row-major order
  (`idx = row * 5 + col`). Index 13 is the small window (never pressed) and
  14 doesn't exist.
- **Button icon size is 196×196 pixels** (confirmed by built-in firmware assets).
  Both PNG and JPEG are accepted.

---

## ZIP format

The payload of `OUT_SET_BUTTONS` is a standard ZIP archive with the following
layout:

```
manifest.json
Images/
Images/<uuid1>.png
Images/<uuid2>.jpg
...
```

- **Flat** — nothing under a `page/` prefix.
- Image filenames are arbitrary but must match whatever `Icon` path the
  manifest references. Ulanzi Studio uses UUID v4. PNG and JPEG both work.
- Compression level: DEFLATE level 1 (fastest, light). Store mode works too.

### `manifest.json`

A single JSON object whose keys are `{col}_{row}` strings. Example (one
button):

```json
{
  "0_0": {
    "State": 0,
    "ViewParam": [
      {
        "Font": {
          "Align":     "bottom",
          "Color":     16777215,
          "FontName":  "Source Han Sans SC",
          "ShowTitle": true,
          "Size":      10,
          "Weight":    80
        },
        "Icon": "Images/72b84f07-a3ea-4208-a231-f1a99d12b486.png",
        "Text": "ChatGPT"
      }
    ]
  }
}
```

Rules:

- Every real button slot **and** the small-window slot (`3_2`) must be present
  in a full `OUT_SET_BUTTONS` upload, or the firmware may reject the update.
  A blank slot looks like `{"State": 0, "ViewParam": [{"Font": {...}}]}`.
- `ViewParam` is an array — firmware supports multiple "states" per button
  (e.g. toggle on/off), but we only use `ViewParam[0]`.
- `Font` **must** be present per-button. Omitting it causes icons not to render
  in at least some firmware versions.
- `Icon` is the path inside the ZIP. Missing icon field means "no image".
- `Text` is the button label rendered below the icon. `""` for none.
- The small-window slot `3_2` includes `"SmallViewMode": 1` (clock) or `2`
  (background image):

  ```json
  "3_2": {
    "SmallViewMode": 1,
    "State": 0,
    "ViewParam": [{ "Font": { ... }, "Text": "" }]
  }
  ```

### Additional manifest fields (from firmware analysis)

The manifest parser (`processLayoutValue` in the firmware) accepts fields
beyond what Ulanzi Studio uses in captures:

| Field | Type | Notes |
|-------|------|-------|
| `Icon` | string | Path inside ZIP (`Images/foo.png`) **or** a `data:image/...` base64 data URI |
| `IconEx` | string | Extended icon field, parsed alongside `Icon`. Purpose unclear; possibly for alternate-state icons. |
| `Action` | string | Action identifier for standalone mode (e.g. `com.ulanzi.ulanzideck.system.open`) |
| `ActionParam` | object | Parameters for the action (e.g. `{"Path": "calc"}`) |

The `data:image/` support on `Icon` is significant: it means the device can
accept inline base64-encoded images in the JSON manifest, potentially
bypassing ZIP packaging entirely. See [DRAW_JS_IMG](#draw_js_img) below.

### Default profiles baked into firmware

The firmware embeds four default manifest profiles used when no host is
connected. Each uses `manifest{0..3}.json`:

| Profile | Target OS | Buttons | Knob row |
|---------|-----------|---------|----------|
| 0 | Windows | Apps (calc, cmd, notepad, explorer, etc.) | Yes (`0_3`..`4_3`) |
| 1 | Windows | Shortcuts (Ctrl+S, Ctrl+Z, Ctrl+C, screenshot, etc.) | Yes |
| 2 | macOS | Shortcuts (Cmd+C, Cmd+V, screenshot, etc.) | No |
| 3 | macOS | Apps (App Store, Calendar, Finder, Safari, etc.) | No |

Profiles 0 and 1 include a "row 3" (`0_3` through `4_3`) for knob actions
(`volumeSw`). The D200 has no knob hardware, so these entries are dead code.
The firmware is shared across multiple ZKSWE devices, some of which have up to
three knobs (`KNOB_1`/`KNOB_2`/`KNOB_3`). Other SoC targets in the firmware
include SSD201, SSD210, and T113.

### Firmware quirk: unsafe byte offsets

The firmware has a bug decoding the chunked ZIP. The first byte of every
"continuation" chunk — i.e. the bytes at file offsets `1016 + 1024·N` for
N ≥ 0 — must **not** be `0x00` or `0x7c`. If it is, the firmware corrupts
the upload or rejects it silently.

`src/zip-builder.ts` works around this: after compression, it scans those
offsets; if any byte is forbidden, it appends a random-length `dummy.txt`
file and recompresses. Repeats until the payload is safe. This is the same
workaround used by strmdck.

---

## Canonical command sequence

Observed sequence when Ulanzi Studio starts up and syncs with the D200:

1. `OUT_SET_BUTTONS` — send a "blank" ZIP to clear the grid
2. `OUT_SET_BUTTONS` — send the initial ZIP with the actual layout
3. `OUT_SET_LABEL_STYLE` — default font for buttons without per-button Font
4. *(device replies with `IN_DEVICE_INFO`)*
5. `OUT_SET_BRIGHTNESS` — user's stored brightness
6. `OUT_SET_SMALL_WINDOW_DATA` — kick the clock / stats display
7. `OUT_SET_BUTTONS` — final layout (if different from step 2)

Afterwards, during normal operation:

- The device emits `IN_BUTTON` on every press/release.
- The device emits `IN_DEVICE_INFO` after each outgoing command as a kind of
  acknowledgement.
- The host sends `OUT_SET_SMALL_WINDOW_DATA` every ~5 s as a keep-alive.
- Button icon changes go through `OUT_PARTIALLY_UPDATE_BUTTONS` (faster than a
  full re-upload).

---

## What's still unknown

- **The `12H|...` suffix** sometimes appended to `OUT_SET_SMALL_WINDOW_DATA`
  payloads. Possibly 12/24-hour clock format toggle + extra flags. Unconfirmed.
- **Exact format of the `IN_DEVICE_INFO` JSON.** Known keys from firmware
  analysis: `SerialNumber` (alias `firmwareSN`), `Dversion` (alias
  `firmwareVersion`), `HardwareVersion` (alias `hardwareVersion`). Additional
  fields may exist.
- **Background-mode image format** for the small window (`SmallViewMode: 2`).
  The firmware stores user wallpapers at `/data/wallpaper/`. The manifest
  likely carries an `Icon` on `3_2` pointing at an image inside the ZIP, but
  we haven't captured this being exercised.
- **`State` > 0** semantics. Every capture so far uses `State: 0` for all
  slots. Possibly relates to toggle/latched buttons or long-press states.
- **The `18d1:d002` companion device.** Uses Google's ADB vendor ID
  (`18d1`). Firmware analysis confirms ADB/USB-device mode switching code
  exists (`/sys/devices/soc0/soc/soc:usbotg/usb_device`). Likely an ADB
  interface disabled in production. On Windows it enumerates but Studio never
  talks to it; on Linux it's the only one that *does* enumerate when plugged
  in directly, but it refuses standard USB control requests.
- **Wire command numbers for firmware-discovered IDs.** The internal names
  (`SETKEYPAD`, `DRAW_JS_IMG`, `SET_SMALLWINDOW_TO_KNOB`, etc.) are known but
  their 16-bit command values have not been mapped.
- **MCU protocol.** A separate microcontroller communicates over UART
  (`/dev/ttyS1`). The `McuUpdate` class handles MCU firmware updates and
  `queryMcuVersion` retrieves its version. The MCU likely handles button
  matrix scanning and knob rotation.
- **JavaScript rendering.** The `DRAW_JS_IMG` command suggests the device can
  render dynamic content via a JS engine, not just static PNG/JPEG. The
  mechanism and supported API are unknown.
