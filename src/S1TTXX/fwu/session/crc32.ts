/**
 * IEEE 802.3 CRC32 (poly 0xEDB88320).
 *
 * Bit-exact with both bootloaders' `fwu_crc32_update()` (S1TTXX
 * `bootloader/Src/fwu_crc.c`, P1TT2C `bootloader/Src/fwu_crc32.c`), with the
 * merge scripts that build `merged.bin`, and with Python's `zlib.crc32`.
 *
 * Implemented here rather than via `zlib.crc32` because the CLI ships as a
 * `pkg` binary on node18, where that function does not exist yet.
 */
export function crc32(data: Buffer): number {
  let crc = 0xffffffff >>> 0;
  for (let i = 0; i < data.length; i++) {
    crc = (crc ^ data[i]) >>> 0;
    for (let b = 0; b < 8; b++) {
      const mask = -(crc & 1) >>> 0;
      crc = ((crc >>> 1) ^ (0xedb88320 & mask)) >>> 0;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
