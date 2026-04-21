# Ulanzi D200 firmware analysis

Reverse-engineered from:
- `Win_Ulanzi_Studio_V3.0.16.20260323.exe` (firmware v5.3.1)
- Live device access via ADB (command `0xFF` switches USB gadget to ADB mode)
- Ghidra disassembly of `libzkgui.so`

---

## Platform

| Detail | Value |
|--------|-------|
| SoC | **SigmaStar SSD210** (dual Cortex-A7, `HardwareVersion: "SSD210V100"`) |
| CPU | ARMv7 rev 5 (v7l), 2 cores, hard-float, NEON |
| RAM | ~64MB (`LX_MEM=0x3FE0000`) |
| Flash | 16MB SPI NOR |
| OS | Linux (glibc 2.30, "SStar Soc" in `/proc/cpuinfo`) |
| Toolchain | `arm-openwrt-linux-gnueabi`, GCC 6.4.1 |
| Build system | ZKSWE EasyUI / FlyThings (hostname: `flythings`) |
| Console | UART ttyS0 @ 115200, ttyS1 for MCU |
| USB gadget | `/sys/class/zkswe_usb/zkswe0/` with `f_hid` and `f_adb` functions |
| USB VID:PID | `2207:0019` (Rockchip VID reused) |
| Display | 960x540, rotated 90 degrees (`rotateScreen: 90` in EasyUI.cfg) |
| Multi-device firmware | Shared across SSD201, SSD210, and T113. Includes knob support absent on D200. |
| SVG rendering | [lunasvg](https://github.com/nicfit/lunasvg) |
| Image codecs | libpng12, libjpeg.9, libwebp.7, libfreetype.6 |

---

## Accessing the device via ADB

Sending HID command `0xFF` to the D200 reconfigures the USB gadget from HID to
ADB mode. The firmware calls `SystemProperties::setString("sys.usb.config", "adb")`
and closes the HID device. After a few seconds, the D200 enumerates as an ADB
device.

```bash
# Send the ADB switch command
node tools/enable-adb.mjs

# Wait 2-3 seconds, then connect
adb devices
adb shell
```

The shell runs as root (`zkswe@flythings:/ #`). To restore normal HID mode,
replug the D200.

---

## MTD partition map

From `/proc/mtd` and `/proc/cmdline`:

```
mtdparts=nor0:0x50000(BOOT0),0x1b0000(KERNEL),0x740000(rootfs),
  0x500000(res),0x90000(config),0x80000(MISC),0x400000(data),0xCB0000(UDISK)
```

| Partition | MTD | Size | Mount | Format | Contents |
|-----------|-----|------|-------|--------|----------|
| BOOT0 | mtd0 | 320 KB | (not mounted) | raw | SoC bootloader |
| KERNEL | mtd1 | 1.7 MB | (not mounted) | raw | Linux kernel |
| rootfs | mtd2 | 7.25 MB | `/` (ro) | SquashFS 4.0 XZ | Base OS: busybox, glibc, zkgui, adbd, kernel modules |
| res | mtd3 | 5 MB | `/res` (ro) | SquashFS 4.0 XZ | **App library (libzkgui.so)**, UI assets, manifests, fonts |
| config | mtd4 | 576 KB | `/config` (ro) | SquashFS 4.0 XZ | Board config, display kernel modules, mmap.ini |
| MISC | mtd5 | 512 KB | `/misc` (tmpfs) | (unused?) | Runtime scratch |
| data | mtd6 | 4 MB | `/data` (rw) | JFFS2 | preferences.json, wallpaper, property store |
| UDISK | mtd7 | 12.7 MB | `/mnt/storage` (ro) | VFAT | User storage |

### Firmware updates target mtd3 (res), not mtd2 (rootfs)

The `update.img` from Ulanzi Studio (3,255,513 bytes) matches the SquashFS on
mtd3 exactly. Firmware updates only replace `/res/` (the application library,
UI assets, default manifests, and fonts). The base OS in mtd2 is never
overwritten by normal OTA updates.

---

## Filesystem layout

### Root filesystem (mtd2, read-only)

```
/bin/zkgui              Main executable (9.5KB launcher, loads libzkgui.so)
/bin/zkdisplay          Framebuffer display server
/bin/zkdaemon           Daemon manager
/bin/adbd               Android Debug Bridge daemon
/bin/busybox            Minimal busybox (cat, cp, ls, mount, ps, etc.)
/bin/vold               Volume daemon
/bin/logd               Log daemon
/bin/mksh               Shell
/etc/init.rc            Init script
/etc/build.prop         Build properties
/etc/vold.fstab         Volume mount table
/etc/font/fzcircle.ttf  System font
/lib/libeasyui.so       ZKSWE EasyUI framework (822KB)
/lib/libinternalapp.so  Internal app support (181KB)
/lib/libc-2.30.so       glibc 2.30
/lib/libstdc++.so.6     GCC 6.4.1 C++ runtime
/sbin/init              PID 1
```

### Resource partition (mtd3, read-only, updated by OTA)

```
/res/lib/libzkgui.so           Main application library (1.3MB) — HID protocol,
                                 button rendering, manifest parsing, OTA, etc.
/res/lib/libwebp.so.7          WebP codec
/res/lib/libwebpdemux.so       WebP demux
/res/bin/minizip               ZIP extraction tool
/res/etc/EasyUI.cfg            Application config (see below)
/res/tr/en_US-ENGLISH.json     English translation strings
/res/ui/main.ftu               FlyThings UI layout definition
/res/ui/font/SeoulNamsan_B_3.ttf   UI font
/res/ui/default/               Default button profiles:
  manifest0.json                 Windows apps (calc, cmd, notepad, etc.)
  manifest1.json                 Windows shortcuts (Ctrl+C, screenshot, etc.)
  manifest2.json                 macOS shortcuts
  manifest3.json                 macOS apps (Finder, Safari, etc.)
  Images/*.png                   55 button icons (196x196)
/res/ui/icon/
  wallpaper.jpg                  Idle wallpaper (429KB)
  www_ulanzistudio_com.png       Ulanzi branding QR code
  exclamation_mark.png           Status overlay icon
  fail.png                       Error icon
/res/ui/clock_960_540/           Analog clock face assets (clock, hour, minute, sec PNGs)
```

### Data partition (mtd6, read-write)

```
/data/preferences.json    {"sys_brightness_key": 100, "sys_lang_code_key": "en_US", "DefKeyMode": 0}
/data/wallpaper/          User-uploaded wallpapers
/data/property/           System property store
/data/local/              Local data
```

### Config partition (mtd4, read-only)

```
/config/board.ini         Board hardware config
/config/mmap.ini          Memory map
/config/PQConfig.ini      Picture quality config
/config/model/Customer.ini  Customer/model config
/config/modules/*.ko      Kernel modules: fbdev, mhal, mi_ao, mi_common,
                            mi_disp, mi_divp, mi_gfx, mi_panel, mi_rgn,
                            mi_sys, mi_vdisp
```

---

## EasyUI.cfg

Application configuration loaded by `zkgui` at startup:

```json
{
  "baud": "115200",
  "rotateTouch": 90,
  "rotateScreen": 90,
  "startupLibPath": "/res/lib/libzkgui.so",
  "languageCode": "zh_CN",
  "defBrightness": 100,
  "screensaverTimeOut": -1,
  "touchDev": "/dev/input/event0",
  "languagePath": "/res/tr/",
  "uart": "ttyS1",
  "startupTouchCalib": false,
  "zkdebug": false,
  "resPath": "/res/ui/"
}
```

The `startupLibPath` confirms that `zkgui` is a thin launcher that loads
`libzkgui.so` at runtime. This is the 1.3MB library containing all protocol
logic, and is the primary target for Ghidra analysis.

---

## Running processes

```
PID  USER  VIRT    STAT  COMMAND
1    root  1944K   S     /sbin/init
411  root  2040K   S     /sbin/ueventd
550  root  22340K  S     /bin/vold
551  1036  31472K  S     /bin/logd
616  root  10700K  S     /bin/zkdisplay
622  root  98252K  S     {zkgui_ui} /bin/zkgui
```

`zkgui` is the main application (98MB virtual, thread name `zkgui_ui`).
`zkdisplay` handles the framebuffer. No networking stack is running.

---

## Extracting the firmware from the installer

The Ulanzi Studio Windows installer is a self-extracting archive:

```bash
mkdir -p /tmp/ulanzi-extract
7z x -o/tmp/ulanzi-extract Win_Ulanzi_Studio_V3.0.16.20260323.exe -y
```

This produces:

| File | Purpose |
|------|---------|
| `update.img` | Firmware image (3,256,892 bytes, targets mtd3/res partition) |
| `binversion` | ASCII version string: `5.3.1` |
| `md5.txt` | MD5 hash: `0b22493ae1178248770857031ba1a97c` |

---

## ZKSWE firmware image format (update.img)

`update.img` uses a proprietary format with the magic `ZKSWEV1.0-180127`. It
wraps a SquashFS image for the res partition (mtd3). The format is **not** a
standard SquashFS despite containing an `hsqs` marker at offset 0x20.

### Layout

```
Offset    Size       Content
0x000     16         Magic: "ZKSWEV1.0-180127"
0x010     16         Metadata (build flags, total size at 0x1C as u32 LE)
0x020     4          Type marker: "hsqs"
0x024     20         SquashFS-like fields (inodes, mkfs_time, block_size, fragments)
0x038     ~516       Block table (purpose not fully decoded)
0x23C     32         Hash or checksum
0x25C     64         Eight u64 LE values (SquashFS-like metadata pointers)
0x29C     to EOF     XZ-compressed data blocks (51 blocks)
```

### Dumping partitions directly via ADB

With ADB access, you can dump any partition without dealing with the ZKSWE
format:

```bash
node tools/enable-adb.mjs
# wait for ADB
adb shell "cat /dev/block/mtdblock3 > /tmp/res.img"
adb pull /tmp/res.img ./mtd3_res.sqfs
unsquashfs -d ./res mtd3_res.sqfs
```

This produces a standard SquashFS 4.0 image that `unsquashfs` handles directly.

---

## Decompressing update.img without ADB

If ADB isn't available, the firmware can be decompressed by extracting the XZ
blocks:

```python
import lzma

with open("update.img", "rb") as f:
    data = f.read()

XZ_MAGIC = b"\xfd7zXZ\x00"

offsets = []
pos = 0
while True:
    idx = data.find(XZ_MAGIC, pos)
    if idx == -1:
        break
    offsets.append(idx)
    pos = idx + 1

result = bytearray()
for i, off in enumerate(offsets):
    end = offsets[i + 1] if i + 1 < len(offsets) else len(data)
    chunk = data[off:end]
    try:
        result.extend(lzma.decompress(chunk))
    except lzma.LZMAError:
        pass  # last 1-2 blocks may be truncated

with open("firmware_decompressed.bin", "wb") as f:
    f.write(result)
```

The resulting 5.5MB flat binary contains the res partition contents packed
contiguously (ELF binaries, PNG/JPEG images, JSON manifests). Individual files
can be extracted with binwalk or manual ELF header parsing.

---

## HID command map (from Ghidra disassembly)

The `HidProtocolHelper::processMessage()` function in `libzkgui.so` dispatches
commands by their wire ID. The Protocol::ID enum values are the wire command
numbers:

| Wire cmd | Handler | Description |
|----------|---------|-------------|
| `0x0003` | `packageDeviceInfo()` | Returns device info JSON (SerialNumber, Dversion, DeviceType, HardwareVersion) |
| `0x0006` | `Protocol::parse()` | Parses full manifest/layout |
| `0x000a` | `strtol()` → brightness | Sets backlight brightness (0-100) |
| `0x000b` | `parseFontInfo()` | Sets default label font style |
| `0x00d0` | `packageHardwareInfo()` | Returns hardware info JSON |
| `0x00fe` | `SecurityManager::writeSecData()` | Writes serial number (17 bytes) |
| `0x00ff` | `SystemProperties::setString("sys.usb.config", "adb")` | **Switches USB to ADB mode** |

Additional commands handled in `threadLoop()` before reaching `processMessage()`
include `0x0001` (SET_BUTTONS), `0x000d` (PARTIAL_UPDATE), `0x000f` (LOCKSCREEN),
and `0x0010` (UNLOCKSCREEN). The `DRAW_JS_IMG` handler has not been located in
the dispatch yet.

### Dangerous commands

| Wire cmd | Effect | Recovery |
|----------|--------|----------|
| `0x0004` | Kills display application | Replug USB |
| `0x000f` | Activates lockscreen | Send `0x0010` to unlock |
| `0x00fe` | Writes serial number to flash | Irreversible (writes to SecurityManager) |
| `0x00ff` | Switches to ADB, drops HID | Replug USB to restore HID |

---

## Device info JSON

Returned by command `0x0003`:

```json
{
  "SerialNumber": "02C47A015U3672401",
  "Dversion": "5.3.1",
  "error": "0",
  "DeviceType": "D200",
  "HardwareVersion": "SSD210V100"
}
```

---

## OTA update mechanism

The firmware `UPDATE` class:

1. Checks for `update.img` at the staging path
2. Validates with `checkZkImg()` and `hashFile()`
3. Remounts partitions read-write
4. Writes to mtd3 (res partition) via `flash_erase` and block writes
5. `McuUpdate` class handles MCU firmware over UART (`/dev/ttyS1`)

The HID protocol exposes `UPDATE_BIN` for host-initiated updates.

---

## Key files for reverse engineering

| File | Location | Size | Purpose |
|------|----------|------|---------|
| `libzkgui.so` | `/res/lib/` (mtd3) | 1.3 MB | Main app: HID protocol, manifest parsing, rendering, OTA. Primary Ghidra target. |
| `libeasyui.so` | `/lib/` (mtd2) | 822 KB | ZKSWE UI framework |
| `libinternalapp.so` | `/lib/` (mtd2) | 181 KB | Internal app support |
| `zkgui` | `/bin/` (mtd2) | 9.5 KB | Thin launcher, loads libzkgui.so |
| `EasyUI.cfg` | `/res/etc/` (mtd3) | 238 B | App configuration |
| `main.ftu` | `/res/ui/` (mtd3) | 1.9 KB | FlyThings UI layout |

Copies for analysis:
- `tools/libzkgui_d200.elf` (pulled from live device via ADB)
- `tools/libapp_d200.elf` (extracted from update.img decompression)

---

## What's still unknown

- **DRAW_JS_IMG wire command number**: not found in `processMessage()`. Likely
  dispatched in `threadLoop()` before reaching processMessage, or handled by a
  different code path. The `Protocol::parseJSData()` function exists at a known
  address and is the next Ghidra target.
- **Block table format** (0x38 to 0x23C in update.img): likely compressed block
  sizes or checksums, encoding not decoded.
- **Hash at 0x23C**: 32 bytes, possibly SHA-256 of the payload.
- **MCU firmware**: separate microcontroller on UART ttyS1, firmware not in
  update.img. Updated via `McuUpdate` class.
- **`IconEx` field semantics**: parsed alongside `Icon` in manifests, purpose
  unclear.
- **Boot partition (mtd0)**: SoC bootloader, not dumped.
- **Kernel (mtd1)**: Linux kernel image, not analyzed.
