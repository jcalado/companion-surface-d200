# Ulanzi D200 firmware analysis

Reverse-engineered from `Win_Ulanzi_Studio_V3.0.16.20260323.exe`, firmware
version **5.3.1** (MD5: `0b22493ae1178248770857031ba1a97c`).

---

## Platform

| Detail | Value |
|--------|-------|
| SoC | Allwinner T113 (ARM Cortex-A7, hard-float) |
| OS | Linux 3.2+ (OpenWrt-based, glibc, GCC 6.4.1 cross-toolchain) |
| Toolchain path | `/home/guoxs/program/c++/zkswe/easyui/platforms/T113/glibc/toolchain/` |
| Cross triple | `arm-openwrt-linux-gnueabi` |
| Flash | SPI NOR/NAND, MTD partitions (`/dev/mtd/mtd*`, `/dev/block/mtdblock*`) |
| Filesystems | JFFS2 (persistent storage), FAT32 (data partition) |
| USB gadget | HID via `/dev/hidg0` (deck protocol) and `/dev/hidg1` (keyboard emulation) |
| USB VID:PID | `2207:0019` (Rockchip VID reused, actual SoC is Allwinner) |
| Serial number source | `/sys/class/zkswe_usb/zkswe0/iSerial` |
| Vendor | Zhuhai Zkswe Technology Co., Ltd ("ZKSWEV1.0" format) |
| Multi-device firmware | Shared across SSD201, SSD210, and T113 targets. Includes knob support (KNOB_1/2/3) and row 3 grid positions absent on the D200 hardware. |
| SVG rendering | Links [lunasvg](https://github.com/nicfit/lunasvg) for SVG rasterization |
| Image codecs | libpng12, libjpeg.9, libwebp.7 (encode + decode), libfreetype.6 |

---

## Extracting the firmware from the installer

The Ulanzi Studio Windows installer is a self-extracting archive. Use 7z to
unpack it:

```bash
mkdir -p /tmp/ulanzi-extract
7z x -o/tmp/ulanzi-extract Win_Ulanzi_Studio_V3.0.16.20260323.exe -y
```

This produces three files:

| File | Purpose |
|------|---------|
| `update.img` | Firmware image (3,256,892 bytes) |
| `binversion` | ASCII version string, e.g. `5.3.1` |
| `md5.txt` | MD5 hash of `update.img` |

---

## ZKSWE firmware image format

`update.img` uses a proprietary format with the magic `ZKSWEV1.0-180127`. It
is **not** a standard SquashFS image despite containing an `hsqs` marker at
offset 0x20. The superblock fields after the marker (compression, version,
metadata pointers) do not conform to the SquashFS specification. The `hsqs`
string appears to be a type tag indicating the target partition format, not an
actual superblock.

### Layout

```
Offset    Size       Content
0x000     16         Magic: "ZKSWEV1.0-180127"
0x010     16         Metadata (build flags, total size at 0x1C as u32 LE)
0x020     4          Type marker: "hsqs"
0x024     20         SquashFS-like fields (inodes, mkfs_time, block_size, fragments)
0x038     ~516       Block table (purpose not fully decoded)
0x23C     32         Hash or checksum (possibly SHA-256 of the payload)
0x25C     64         Eight u64 LE values resembling SquashFS metadata pointers
0x29C     to EOF     XZ-compressed data blocks (51 blocks)
```

### Header fields

```
Offset  Size  Type     Field            Value (v5.3.1)
0x00    16    ascii    magic            "ZKSWEV1.0-180127"
0x18    4     u32 LE   entry_count?     572 (0x23C, matches hash offset)
0x1C    4     u32 LE   payload_size     3,256,320 (total XZ data + metadata)
0x20    4     ascii    fs_type          "hsqs"
0x24    4     u32 LE   inodes           77
0x28    4     u32 LE   mkfs_time        1,772,699,281 (2026-03-05 08:28:01 UTC)
0x2C    4     u32 LE   block_size       131,072 (128 KB)
0x30    4     u32 LE   fragments        524
```

### XZ data blocks

The firmware payload is 51 XZ-compressed blocks starting at offset 0x29C. Each
decompresses to 131,072 bytes (128 KB), except for a few smaller blocks at
boundaries. When decompressed and concatenated in order they produce a 5,548,861
byte flat binary containing the root filesystem contents.

---

## Decompressing the firmware

```python
import lzma

with open("update.img", "rb") as f:
    data = f.read()

XZ_MAGIC = b"\xfd7zXZ\x00"

# Find all XZ block offsets
offsets = []
pos = 0
while True:
    idx = data.find(XZ_MAGIC, pos)
    if idx == -1:
        break
    offsets.append(idx)
    pos = idx + 1

# Decompress and concatenate
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

Two of the 51 blocks (indices 46 and 48) fail to decompress due to truncated
XZ streams. The remaining 49 blocks produce the full firmware content.

---

## Decompressed firmware contents

The decompressed blob is a flat binary image, not a mountable filesystem. It
contains ELF binaries, images, and data packed contiguously. Binwalk or manual
ELF header parsing can extract the individual files.

### ELF binaries

| Offset | Type | Size | Identity | Dependencies |
|--------|------|------|----------|--------------|
| 0x000000 | Shared lib | 295 KB | `libeasyui.so` (ZKSWE UI framework + libwebp) | libc, libm, libwebp, libgcc_s |
| 0x047FF0 | Shared lib | 1.3 MB | Main application library (HID protocol, button handling, rendering, OTA) | libeasyui, libfreetype, libjpeg, libpng12, liblog, libdl |
| 0x49553B | Executable | 58 KB | `zkgui` (main launcher) | libc, libstdc++, libz, libdl, libm |
| 0x4A3EB4 | Shared lib | 19 KB | WebP demux wrapper (has debug symbols) | libc, libwebp, libwebpdemux |

### Images

| Offset | Format | Dimensions | Content |
|--------|--------|------------|---------|
| 0x13E910 | PNG | 196x196 | Built-in button icon |
| 0x154BF0 | PNG | 196x196 | Built-in button icon |
| 0x16CB8C | PNG | 196x196 | Built-in button icon |
| 0x19F692 | PNG | 196x196 | Built-in button icon |
| 0x1EBD00 | PNG | 196x196 | Built-in button icon |
| 0x251575 | PNG | 196x196 | Built-in button icon |
| 0x2A792B | JPEG | 1280x720 | Wallpaper / splash screen |

Additional small PNGs (status icons, UI elements) are embedded within the main
application library at offsets 0x4A8C05 onward.

---

## Extracting ELF binaries

ELF files span multiple 128 KB blocks. To extract them properly, parse the
decompressed blob for `\x7fELF` headers and use the section header table
offset (`e_shoff`) plus section count to compute the file boundary:

```python
import struct

with open("firmware_decompressed.bin", "rb") as f:
    data = f.read()

ELF_MAGIC = b"\x7fELF"
pos = 0
while True:
    idx = data.find(ELF_MAGIC, pos)
    if idx == -1:
        break
    e_shoff = struct.unpack_from("<I", data, idx + 32)[0]
    e_shentsize = struct.unpack_from("<H", data, idx + 46)[0]
    e_shnum = struct.unpack_from("<H", data, idx + 48)[0]
    size = e_shoff + e_shentsize * e_shnum
    with open(f"elf_0x{idx:06x}.elf", "wb") as out:
        out.write(data[idx : idx + size])
    pos = idx + 1
```

---

## Key strings from the firmware

### Internal protocol commands

```
Protocol::ID::SETKEYPAD
Protocol::ID::SETSCREEN_PIC
Protocol::ID::SET_SMALLWINDOW_TO_KNOB
Protocol::ID::DRAW_JS_IMG
Protocol::ID::LOCKSCREEN
Protocol::ID::UNLOCKSCREEN
Protocol::ID::UPDATE_BIN
Protocol::ID::APP_EXIT
Protocol::ID::SHUTDOWN
Protocol::ID::RUN_RESULT
```

### Source file references

```
../src/HidProtocolHelper.cpp
../src/hid_device.cpp
../src/hid_protocol.cpp
../src/update/update.cpp
```

### Device info fields

```
SerialNumber / firmwareSN
Dversion / firmwareVersion
HardwareVersion / hardwareVersion
binversion
```

### Filesystem paths used at runtime

```
/dev/hidg0              HID gadget (deck protocol)
/dev/hidg1              HID gadget (keyboard emulation)
/dev/ttyS1              UART (MCU communication)
/dev/block/mtdblock*    MTD block devices
/dev/mtd/mtd*           MTD char devices
/proc/mtd               Partition table
/data/wallpaper/        User wallpaper storage
/boot/%s                Boot partition
/tmp/update/            OTA staging directory
/etc/font               Font configuration
```

---

## OTA update mechanism

The firmware contains an `UPDATE` class (`update.cpp`) that:

1. Checks for `/tmp/update/update.img` (or similar staging path)
2. Validates the image with `checkZkImg()` and `hashFile()`
3. Remounts partitions read-write
4. Writes blocks to MTD via `flash_erase -j` and block device writes
5. An `McuUpdate` class handles MCU firmware over UART (`/dev/ttyS1`)

The HID protocol exposes `Protocol::ID::UPDATE_BIN` for host-initiated
firmware updates.

---

## What's still unknown

- **Block table format** (0x38 to 0x23C): likely compressed block sizes or
  checksums, but the encoding isn't decoded. Entries follow a `XX 00 00 YY`
  pattern in groups of 4 bytes.
- **Hash at 0x23C**: 32 bytes that could be SHA-256 of the payload.
- **Metadata pointers at 0x25C**: eight u64 LE values that resemble SquashFS
  table offsets (inode table, directory table, fragment table, etc.) but don't
  work when grafted into a standard SquashFS superblock. The data at those
  offsets does not contain valid SquashFS metadata blocks.
- **How to rebuild a mountable filesystem**: the flat binary doesn't match any
  standard filesystem format (SquashFS, ext4, cramfs, JFFS2). It may be a raw
  MTD partition image with a custom layout, or the ZKSWE EasyUI framework may
  use a proprietary packing scheme.
- **MTD partition map**: the `/proc/mtd` layout (boot, rootfs, data, etc.) is
  not known without a live shell on the device.
- **MCU firmware**: a separate microcontroller handles button scanning and
  display driving; its firmware is updated over UART via `McuUpdate` and is
  not included in this image.
