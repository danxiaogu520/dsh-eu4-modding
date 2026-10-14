import { promisify } from 'node:util';
import { crc32, gunzip, inflateRaw } from 'node:zlib';

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_EXECUTABLE_BYTES = 128 * 1024 * 1024;
const unzip = promisify(gunzip);
const inflate = promisify(inflateRaw);

export interface ServerArtifact {
  target: string;
  binary: string;
  extension: 'tar.gz' | 'zip';
}

export function platformArtifact(platform: NodeJS.Platform = process.platform, arch: string = process.arch): ServerArtifact {
  const targets: Record<string, string> = {
    'linux/x64': 'x86_64-unknown-linux-gnu',
    'linux/arm64': 'aarch64-unknown-linux-gnu',
    'darwin/x64': 'x86_64-apple-darwin',
    'darwin/arm64': 'aarch64-apple-darwin',
    'win32/x64': 'x86_64-pc-windows-msvc',
  };
  const target = targets[`${platform}/${arch}`];
  if (!target) throw new Error(`ParadoxCode has no published server for ${platform}/${arch}. Configure serverPath with a local executable.`);
  return { target, binary: platform === 'win32' ? 'paradoxcode.exe' : 'paradoxcode', extension: platform === 'win32' ? 'zip' : 'tar.gz' };
}

/** Release archives contain exactly one ordinary root file. Never extract archive paths to disk. */
export async function extractServer(archive: Buffer, artifact: ServerArtifact): Promise<Buffer> {
  if (!archive.length || archive.length > MAX_ARCHIVE_BYTES) throw new Error('Server archive exceeds the 64 MiB limit or is empty');
  if (artifact.extension === 'zip') return extractZip(archive, artifact.binary);
  const tar = await unzip(archive, { maxOutputLength: MAX_EXECUTABLE_BYTES + 8192 });
  if (tar.length < 1536) throw new Error('Invalid server tar archive');
  const header = tar.subarray(0, 512);
  const field = (start: number, size: number) => header.subarray(start, start + size).toString('utf8').replace(/\0.*$/s, '');
  const octal = (start: number, size: number) => {
    const value = field(start, size).trim();
    if (!/^[0-7]+$/.test(value)) throw new Error('Invalid tar numeric field');
    return parseInt(value, 8);
  };
  const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
  if (checksum !== octal(148, 8)) throw new Error('Invalid tar header checksum');
  if (field(0, 100) !== artifact.binary || field(345, 155) || field(157, 100) || (header[156] !== 0 && header[156] !== 48)) {
    throw new Error(`Server archive must contain only the regular file ${artifact.binary}`);
  }
  const size = octal(124, 12);
  const end = 512 + Math.ceil(size / 512) * 512;
  if (size < 1 || size > MAX_EXECUTABLE_BYTES || end + 1024 > tar.length || tar.subarray(512 + size).some(byte => byte !== 0)) {
    throw new Error('Invalid tar payload, extra entries, or executable size exceeds 128 MiB');
  }
  return Buffer.from(tar.subarray(512, 512 + size));
}

async function extractZip(zip: Buffer, binary: string): Promise<Buffer> {
  // Only the single-file, non-ZIP64 layout emitted by ParadoxCode is accepted.
  let end = zip.length - 22;
  for (; end >= Math.max(0, zip.length - 65557); end--) {
    if (zip.readUInt32LE(end) === 0x06054b50 && end + 22 + zip.readUInt16LE(end + 20) === zip.length) break;
  }
  if (end < 0 || zip.length < 22 || zip.readUInt32LE(end) !== 0x06054b50) throw new Error('Invalid server ZIP archive');
  if (zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6) || zip.readUInt16LE(end + 8) !== 1 || zip.readUInt16LE(end + 10) !== 1) {
    throw new Error('Server ZIP must contain exactly one file on one disk');
  }
  const centralSize = zip.readUInt32LE(end + 12);
  const central = zip.readUInt32LE(end + 16);
  if (central + centralSize !== end || centralSize < 46 || central + 46 > end || zip.readUInt32LE(central) !== 0x02014b50) {
    throw new Error('Invalid ZIP central directory');
  }
  const flags = zip.readUInt16LE(central + 8);
  const method = zip.readUInt16LE(central + 10);
  const compressedSize = zip.readUInt32LE(central + 20);
  const size = zip.readUInt32LE(central + 24);
  const nameSize = zip.readUInt16LE(central + 28);
  const extraSize = zip.readUInt16LE(central + 30);
  const commentSize = zip.readUInt16LE(central + 32);
  const mode = zip.readUInt32LE(central + 38) >>> 16;
  const local = zip.readUInt32LE(central + 42);
  const filename = zip.subarray(central + 46, central + 46 + nameSize).toString('utf8');
  if (46 + nameSize + extraSize + commentSize !== centralSize || filename !== binary || flags & 1 || zip.readUInt16LE(central + 34) || (mode & 0xf000) && (mode & 0xf000) !== 0x8000) {
    throw new Error(`Server ZIP must contain only the unencrypted regular file ${binary}`);
  }
  if (size < 1 || size > MAX_EXECUTABLE_BYTES || local + 30 > central || zip.readUInt32LE(local) !== 0x04034b50) {
    throw new Error('Invalid ZIP executable size or local header');
  }
  const localNameSize = zip.readUInt16LE(local + 26);
  const dataStart = local + 30 + localNameSize + zip.readUInt16LE(local + 28);
  if (zip.readUInt16LE(local + 6) !== flags || zip.readUInt16LE(local + 8) !== method || zip.subarray(local + 30, local + 30 + localNameSize).toString('utf8') !== binary || dataStart + compressedSize > central) {
    throw new Error('ZIP local header does not match its central directory');
  }
  const compressed = zip.subarray(dataStart, dataStart + compressedSize);
  const bytes = method === 0 ? Buffer.from(compressed) : method === 8 ? await inflate(compressed, { maxOutputLength: MAX_EXECUTABLE_BYTES }) : undefined;
  if (!bytes || bytes.length !== size || crc32(bytes) !== zip.readUInt32LE(central + 16)) throw new Error('Invalid ZIP compression, size, or CRC');
  return bytes;
}
