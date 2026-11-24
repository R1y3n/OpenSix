
import { constants, createHash, createPublicKey, verify } from 'node:crypto';
import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { basename } from 'node:path';
import { createInflateRaw, inflateSync, inflateRawSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { hasByteRange } from './available-ranges.mjs';

const EXECUTABLE_HASH = 'e95020b2fa4a721db3df59fdecf75621730ac559d8835252f6c3b658d5a08993';
const FILE_TABLE = 0x33f70dfaf2c50989n;
const RESOURCE_TABLE = 0xba180afb232d1b4bn;
const HASH64_TABLE = 0x73bcb72dce74f11fn;
const HASH32_TABLE = 0xb7076b6245d35fb5n;
const LOOKUP_TABLE = 0xb6f5bdb2c66da2e9n;
const CRYPTO_TABLE = 0x286030a358a789fbn;
const CHUNK_TABLE = 0xe0c12d7a5d4884c5n;
const HEADER_SIZE = 64;
const DIRECTORY_LIMIT = 512 * 1024 * 1024;

function requireFormat(condition, message) {
  if (!condition) throw new Error(message);
}

const align = (value, boundary) => Math.ceil(value / boundary) * boundary;

function bytesAt(fd, offset, size) {
  const bytes = Buffer.allocUnsafe(size);
  for (let done = 0; done < size;) {
    const count = readSync(fd, bytes, done, size - done, offset + done);
    if (count === 0) throw new Error('Unexpected end of file');
    done += count;
  }
  return bytes;
}

export class GameExecutable {
  #image;
  #base;
  #sections;
  #keys;
  #headerKey;
  #decoders = new Map();

  constructor(path) {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      requireFormat(size === 120181760, 'This executable differs from the supported Scarlett build.');
      this.#image = bytesAt(fd, 0, size);
    } finally {
      closeSync(fd);
    }
    const digest = createHash('sha256').update(this.#image).digest('hex');
    requireFormat(digest === EXECUTABLE_HASH, 'This executable differs from the supported Scarlett build (SHA-256 mismatch).');
    const pe = this.#image.readUInt32LE(0x3c);
    const optional = pe + 24;
    this.#base = this.#image.readBigUInt64LE(optional + 24);
    const table = optional + this.#image.readUInt16LE(pe + 20);
    this.#sections = Array.from({ length: this.#image.readUInt16LE(pe + 6) }, (_, index) => {
      const p = table + 40 * index;
      return {
        rva: this.#image.readUInt32LE(p + 12),
        bytes: this.#image.readUInt32LE(p + 16),
        offset: this.#image.readUInt32LE(p + 20),
      };
    });
    const records = this.#address(0x1466e5900n, 24 * 24);
    this.#keys = new Map();
    for (let index = 0; index < 24; index++) {
      const p = index * 24;
      this.#keys.set(records.readBigUInt64LE(p), {
        address: records.readBigUInt64LE(p + 8),
        size: Number(records.readBigUInt64LE(p + 16)),
      });
    }
  }

  #address(virtualAddress, size) {
    const rva = Number(virtualAddress - this.#base);
    const section = this.#sections.find(s => rva >= s.rva && rva + size <= s.rva + s.bytes);
    requireFormat(section, 'Executable address is outside its file-backed sections.');
    const offset = section.offset + rva - section.rva;
    return this.#image.subarray(offset, offset + size);
  }

  normalize(name) {
    const mapping = this.#address(0x1465b23b0n, 256);
    return Buffer.from(Buffer.from(name, 'utf8').map(byte => mapping[byte]));
  }

  extension(type) {
    const range = type < 0x13 ? [0x1462fcd30n, type]
      : type >= 0x40 && type <= 0x73 ? [0x14618d9e0n, type - 0x40] : null;
    if (!range) return null;
    const address = this.#address(range[0] + 8n * BigInt(range[1]), 8).readBigUInt64LE();
    if (address === 0n) return null;
    const bytes = this.#address(address, 32);
    const end = bytes.indexOf(0);
    const extension = bytes.toString('ascii', 0, end < 0 ? 32 : end);
    return /^\w{1,12}$/.test(extension) ? extension : null;
  }

  *pathReferences() {
    // Read path literals from the supplied executable.
    const rdata = this.#sections.find(section => section.rva === 99880960);
    const raw = this.#image.toString('latin1', rdata.offset, rdata.offset + rdata.bytes);
    yield* candidatePaths(raw);
  }

  headerCipher(flag) {
    switch (flag >> 1) {
      case 1: return { type: 3, id: 1, iv: this.#address(0x1462fd460n, 16) };
      case 4: return { type: 16, id: 0x10000001, iv: this.#address(0x1462fd470n, 16) };
      default: throw new Error('Unsupported RPF9 directory mode.');
    }
  }

  verifyHeaderSignature(directory, record) {
    this.#headerKey ??= createPublicKey({key:this.#address(0x1466fd4b0n,294),format:'der',type:'spki'});
    const signatureStart=record+4;
    const signatureEnd=signatureStart+256;
    // Verify the first-transform header. The eight-byte header ID and the
    // signature itself are excluded. PKCS#1 hashes the resulting digest again.
    const digest=createHash('sha256').update(directory.subarray(0,16))
      .update(directory.subarray(24,signatureStart)).update(directory.subarray(signatureEnd)).digest();
    return verify('sha256',digest,{key:this.#headerKey,padding:constants.RSA_PKCS1_PADDING},
      directory.subarray(signatureStart,signatureEnd));
  }

  #blockDecoder(id, type) {
    const algorithms = this.#address(0x1462fe860n, 19 * 4);
    const algorithm = type < 19 ? algorithms.readUInt32LE(type * 4) : 0;
    requireFormat(algorithm === 16 || algorithm === 17, 'Unsupported cipher variant.');
    const key = algorithm + ':' + id;
    if (this.#decoders.has(key)) return this.#decoders.get(key);
    const descriptor = this.#keys.get((BigInt(id) << 32n) | (2n << 24n));
    requireFormat(descriptor?.size === 4340, 'The matching cipher record is missing from the executable.');
    const material = this.#address(descriptor.address, descriptor.size);
    const initialAddress = algorithm === 17 ? 0x146040f30n : 0x146036f30n;
    const initial = this.#address(initialAddress, 16 * 256);
    const roundBytes = this.#address(initialAddress + 0x1000n, 16 * 256 * 4);
    const roundTables = new Uint32Array(16 * 256);
    for (let index = 0; index < roundTables.length; index++) {
      roundTables[index] = roundBytes.readUInt32LE(index * 4);
    }
    const words = new Uint32Array(56);
    for (let index = 0; index < words.length; index++) {
      words[index] = material.readUInt32LE(4 + index * 4);
    }
    const decoder = { algorithm, initial, roundTables, words, final: material.subarray(244) };
    this.#decoders.set(key, decoder);
    return decoder;
  }

  decrypt(data, spans, descriptor) {
    this.decryptor(descriptor)(data,spans);
  }

  decryptor({ id, type, iv }) {
    const { algorithm, initial, roundTables, words, final } = this.#blockDecoder(id, type);
    let state = new Uint32Array(4);
    let next = new Uint32Array(4);
    const chain = Buffer.from(iv);
    const forward = algorithm === 17;
    const shift = forward ? 1 : -1;
    const initialCounter = forward ? (iv.readBigUInt64BE(0) << 64n) | iv.readBigUInt64BE(8) : 0n;
    return (data,spans,origin=0) => {
      for (const { start, length } of spans) {
        requireFormat(start >= 0 && length >= 0 && length % 16 === 0 &&
          start + length <= data.length, 'Cipher span lies outside its buffer or is not block aligned.');
        for (let offset = start; offset < start + length; offset += 16) {
          if (forward) {
            const position = initialCounter + BigInt((origin + offset) / 16);
            chain.writeBigUInt64BE(BigInt.asUintN(64, position >> 64n), 0);
            chain.writeBigUInt64BE(BigInt.asUintN(64, position), 8);
          }
          for (let column = 0; column < 4; column++) {
            let word = 0;
            for (let byte = 0; byte < 4; byte++) {
              const i = column * 4 + byte;
              word = (word << 8) | initial[i * 256 + (forward ? chain[i] : data[offset + i])];
            }
            state[column] = word ^ words[column];
          }
          for (let round = 1; round < 14; round++) {
            for (let column = 0; column < 4; column++) {
              let word = words[4 * round + column];
              for (let byte = 0; byte < 4; byte++) {
                const source = (column + shift * byte + 4) & 3;
                const input = (state[source] >>> (24 - 8 * byte)) & 255;
                word ^= roundTables[(4 * source + byte) * 256 + input];
              }
              next[column] = word;
            }
            [state, next] = [next, state];
          }
          for (let index = 0; index < 16; index++) {
            const byte = index & 3;
            const source = ((index >>> 2) + shift * byte + 4) & 3;
            const ciphertext = data[offset + index];
            const input = (state[source] >>> (24 - 8 * byte)) & 255;
            data[offset + index] = final[index * 256 + input] ^ (forward ? ciphertext : chain[index]);
            if (!forward) chain[index] = ciphertext;
          }
        }
      }
    };
  }
}


function readChunks(data, record, limit, storedSize, decodedSize, prefixLength) {
  const start = record + data.readUInt32LE(record);
  const count = data.readUInt16LE(record + 4);
  const format = data[record + 7];
  requireFormat(start >= record && start + count * 8 <= limit, 'Chunk records cross the directory boundary.');
  if (![2, 3, 4].includes(format)) return { unsupported: 'Unsupported chunk record encoding ' + format };
  let offset = prefixLength;
  let outputSize = 0;
  const items = [];
  for (let i = 0; i < count; i++) {
    const word = data.readBigUInt64LE(start + i * 8);
    let readSize, padded, size, codec;
    if (format === 3) {
      readSize = 65536 - Number((word >> 16n) & 0xffffn);
      padded = align(readSize, 16);
      size = 65536 - Number(word & 0xffffn);
      codec = Number((word >> 60n) & 3n);
    } else if (format === 2) {
      padded = Number((word >> 28n) & 0xffffff0n);
      readSize = padded - Number((word >> 58n) & 15n);
      size = Number((word << 4n) & 0xffffff0n);
      codec = Number((word >> 62n) & 3n);
    } else {
      padded = Number((word >> 24n) & 0xffffff0n);
      readSize = padded - Number((word >> 52n) & 15n);
      size = Number(word & 0xfffffffn);
      codec = Number((word >> 56n) & 3n);
    }
    requireFormat(readSize >= 0 && size > 0, 'Invalid chunk size.');
    items.push({ offset, readSize, size, codec });
    offset += padded;
    outputSize += size;
  }
  requireFormat(offset <= storedSize && outputSize === decodedSize,
    'Chunk sizes disagree with their archive entry.');
  return { items };
}

export const MAX_DECODE = 256 * 1024 * 1024;

function* payloadSpans(crypto, size) {
  const alignedSize = Math.floor(size / 16) * 16;
  const head = Math.min(crypto.lead, alignedSize);
  const tailStart = Math.max(head, alignedSize - crypto.tail);
  if (head) yield { start: 0, length: head };
  if (crypto.block) {
    const period = crypto.block + crypto.step;
    for (let start = head; start < tailStart; start += period) {
      yield { start, length: Math.min(crypto.block, tailStart - start) };
    }
  }
  if (tailStart < alignedSize) yield { start: tailStart, length: alignedSize - tailStart };
}

export function decodePayload(executable, archive, row) {
  requireFormat(row.size <= MAX_DECODE && row.stored <= MAX_DECODE,
    'Decoded download exceeds 256 MiB. The stored download is available.');
  return decodeStoredPayload(executable, row, readStored(archive, row));
}

export function decodeStoredPayload(executable, row, stored) {
  requireFormat(row.size <= MAX_DECODE && row.stored <= MAX_DECODE &&
    stored.length === row.stored, 'The complete stored payload is required for decoding.');
  if (row.chunks?.unsupported) throw new Error(row.chunks.unsupported);
  if (row.crypto) {
    const offset = row.kind === 'resource' ? row.chunks?.items[0]?.offset ?? 0 : 0;
    const encrypted = stored.subarray(offset);
    executable.decrypt(encrypted, payloadSpans(row.crypto, encrypted.length), row.crypto);
  }
  if (!row.chunks) {
    if (row.size <= stored.length) return stored.subarray(0, row.size);
    const decoded = inflateRawSync(stored, { maxOutputLength: row.size });
    requireFormat(decoded.length === row.size, 'Decoded entry has an unexpected size.');
    return decoded;
  }
  const result = Buffer.allocUnsafe(row.size);
  let position = 0;
  for (const chunk of row.chunks.items) {
    const packed = stored.subarray(chunk.offset, chunk.offset + chunk.readSize);
    const bytes = decodeChunk(chunk,packed);
    bytes.copy(result, position);
    position += bytes.length;
  }
  requireFormat(position === row.size, 'Decoded entry has an unexpected size.');
  return result;
}

function decodeChunk(chunk, packed) {
  let bytes;
  if (chunk.codec === 0) bytes = packed;
  else if (chunk.codec === 3) bytes = inflateSync(packed,{ maxOutputLength:chunk.size });
  else throw new Error('Unsupported compression codec ' + chunk.codec + '. The stored download is available.');
  requireFormat(bytes.length === chunk.size, 'Decoded chunk has an unexpected size.');
  return bytes;
}

export function streamPayload(executable, archive, row) {
  if (row.chunks?.unsupported) throw new Error(row.chunks.unsupported);
  const entryStart = archive.start + row.offset;
  requireFormat(hasByteRange(archive.availableRanges,entryStart,row.stored), 'This part of the archive has not downloaded yet.');
  const chunkList = row.chunks?.items;
  const prefix = row.kind === 'resource' ? chunkList?.[0]?.offset ?? 0 : 0;
  const decrypt = row.crypto ? executable.decryptor(row.crypto) : null;
  const spans = row.crypto ? payloadSpans(row.crypto,row.stored-prefix) : null;
  let span = spans?.next().value;

  function* overlappingSpans(origin, length) {
    while (span && span.start < origin+length) {
      const end = span.start+span.length;
      const first = Math.max(span.start,origin);
      const last = Math.min(end,origin+length);
      if (last > first) yield { start:first-origin, length:last-first };
      if (end > origin+length) break;
      span = spans.next().value;
    }
  }

  function* blocks() {
    const fd = openVerifiedArchiveFile(archive);
    function read(offset,length) {
      const bytes = bytesAt(fd,entryStart+offset,length);
      if (decrypt) decrypt(bytes,overlappingSpans(offset-prefix,length),offset-prefix);
      return bytes;
    }
    try {
      if (chunkList) {
        for (const [index,chunk] of chunkList.entries()) {
          const next = chunkList[index+1]?.offset ?? row.stored;
          const packed = read(chunk.offset,next-chunk.offset).subarray(0,chunk.readSize);
          yield decodeChunk(chunk,packed);
        }
      } else {
        const blockSize = 2 * 1024 * 1024;
        const outputSize = Math.min(row.stored,row.size);
        for (let offset=0;offset<outputSize;offset+=blockSize) {
          const bytes=read(offset,Math.min(row.stored-offset,blockSize));
          yield bytes.subarray(0,outputSize-offset);
        }
      }
    } finally { closeSync(fd); }
  }
  const source = Readable.from(blocks(), { objectMode:false });
  if (chunkList || row.size <= row.stored) return source;
  const inflate = createInflateRaw();
  source.on('error',error=>inflate.destroy(error));
  inflate.on('close',()=>source.destroy());
  return source.pipe(inflate);
}

function readIndex(data, offset, width) {
  if (width === 1) return data[offset];
  if (width === 2) return data.readUInt16LE(offset);
  return data.readUInt32LE(offset);
}

function findExtension(data, count, records, fields, type) {
  for (let index = 0; index < count; index++) {
    const p = records + 8 * index;
    if (data.readUInt16LE(p) === type) return fields + data.readUInt32LE(p + 4);
  }
  return null;
}

function readCipher(data, offset) {
  return {
    id: data.readUInt32LE(offset),
    type: data.readUInt16LE(offset + 4),
    iv: Buffer.from(data.subarray(offset + 6, offset + 22)),
  };
}

export function openArchive(executable, path, start = 0, length, options = {}) {
  const fd = openSync(path, 'r');
  try {
    const identity = archiveIdentity(fstatSync(fd));
    const fileSize = identity[0];
    const logicalSize = options.expectedFileSize ?? fileSize;
    const size = length ?? logicalSize;
    const availableRanges = options.availableRanges ?? [[0,fileSize]];
    requireFormat(Number.isSafeInteger(start) && Number.isSafeInteger(size) &&
      Number.isSafeInteger(logicalSize) && logicalSize >= fileSize &&
      start >= 0 && size >= HEADER_SIZE && start + size <= logicalSize &&
      start + HEADER_SIZE <= fileSize, 'Archive range is invalid.');
    requireFormat(hasByteRange(availableRanges,start,HEADER_SIZE), 'The archive header has not downloaded yet.');
    const header = bytesAt(fd, start, HEADER_SIZE);
    requireFormat(header.toString('ascii', 0, 4) === '9FPR', 'The selected file has no RPF9 signature.');
    const directoryEnd = header.readUInt32LE(4);
    const split = header.readUInt32LE(8);
    const trailer = header.readUInt32LE(12);
    const bodyEnd = size - trailer;
    requireFormat(directoryEnd <= DIRECTORY_LIMIT && directoryEnd <= bodyEnd &&
      start + directoryEnd <= fileSize &&
      split >= HEADER_SIZE && split <= directoryEnd, 'Archive header contains invalid directory bounds.');
    requireFormat(hasByteRange(availableRanges,start,directoryEnd), 'The archive directory has not downloaded yet.');
    const data = bytesAt(fd, start, directoryEnd);
    const headerHash = createHash('sha256').update(data).digest('hex');
    const pointerCount = header.readUInt16LE(0x1a);
    const parameterSize = header.readUInt32LE(0x1c);
    const headerSpanTail = header.readUInt32LE(0x30);
    const typeCount = header.readUInt16LE(0x20);
    const externalCount = header.readUInt16LE(0x22);
    const rowCount = header.readUInt32LE(0x24);
    const indexWidth = header[0x2c];
    const encrypted = header[0x2e];
    const indexSentinel = 2 ** (8 * indexWidth) - 1;
    requireFormat([1,2,4].includes(indexWidth) && typeCount > externalCount &&
      rowCount <= indexSentinel && rowCount <= 2_000_000,
      'Archive index dimensions are invalid or unsupported.');
    const parameterStart = HEADER_SIZE + align(8 * pointerCount, 16);
    const directoryStart = align(parameterStart + parameterSize, 16);
    const primaryEnd = parameterStart + parameterSize - headerSpanTail;
    requireFormat(parameterSize >= headerSpanTail && directoryStart <= split &&
      directoryStart + typeCount * 24 <= split, 'Archive parameter spans are invalid.');
    if (encrypted) {
      const prefixSpans = [{ start: HEADER_SIZE, length: parameterStart - HEADER_SIZE }];
      if (encrypted & 1) prefixSpans.push({ start: parameterStart, length: parameterSize - headerSpanTail });
      executable.decrypt(data, prefixSpans, executable.headerCipher(encrypted));
    }
    const signaturePointer = findExtension(data, pointerCount, HEADER_SIZE, parameterStart, 6);
    requireFormat(encrypted !== 9 || signaturePointer !== null, 'Archive header signature is missing.');
    if (signaturePointer !== null) {
      requireFormat(signaturePointer >= parameterStart && signaturePointer + 260 <= primaryEnd &&
        data.readUInt32LE(signaturePointer) === 0x00010001, 'Archive header has an unsupported signature record.');
      requireFormat(executable.verifyHeaderSignature(data,signaturePointer), 'Archive header signature verification failed.');
    }
    const headerSignature = signaturePointer === null ? 'unsigned' : 'verified';
    const cipherPointer = findExtension(data, pointerCount, HEADER_SIZE, parameterStart, 1);
    if (cipherPointer !== null) {
      requireFormat(cipherPointer >= parameterStart && cipherPointer + 22 <= primaryEnd,
        'Archive cipher parameters are outside the decoded header.');
      const cipher = readCipher(data, cipherPointer);
      executable.decrypt(data, [{ start: primaryEnd, length: split - primaryEnd }], cipher);
      if (split < directoryEnd) {
        executable.decrypt(data, [{ start: split, length: directoryEnd - split }], cipher);
      }
    }

    const innerLookup = directoryStart + typeCount * 24;
    const innerCount = typeCount - externalCount;
    const innerTables = align(innerLookup + rowCount * innerCount * indexWidth, 8);
    const outerTables = align(split + rowCount * externalCount * indexWidth, 8);
    requireFormat(innerTables <= split && outerTables <= directoryEnd, 'Archive index tables cross the directory boundary.');
    const columns = new Map();
    let innerColumn = 0;
    let outerColumn = 0;
    for (let index = 0; index < typeCount; index++) {
      const p = directoryStart + index * 24;
      const identifier = data.readBigUInt64LE(p);
      const count = data.readUInt32LE(p + 8);
      const stride = data.readUInt16LE(p + 16);
      const external = Boolean(data.readUInt16LE(p + 18) & 1);
      const table = (external ? outerTables : innerTables) + data.readUInt32LE(p + 12);
      requireFormat(stride > 0 && table + count * stride <= (external ? directoryEnd : split),
        'An archive record table falls outside the decrypted directory.');
      requireFormat(!columns.has(identifier), 'Duplicate archive record table.');
      columns.set(identifier, {
        count, stride, table, external, index: external ? outerColumn++ : innerColumn++,
      });
    }
    requireFormat(innerColumn === innerCount && outerColumn === externalCount &&
      (columns.has(FILE_TABLE) || columns.has(RESOURCE_TABLE)) && columns.has(HASH64_TABLE),
      'Required file and identity tables are missing.');
    const lookup = (identifier, row) => {
      const column = columns.get(identifier);
      if (!column) return null;
      const width = column.external ? externalCount : innerCount;
      const start = column.external ? split : innerLookup;
      const index = readIndex(data, start + (row * width + column.index) * indexWidth, indexWidth);
      if (index === indexSentinel) return null;
      requireFormat(index < column.count, 'An archive row references a nonexistent table record.');
      return column.table + index * column.stride;
    };
    const rows = [];
    for (let index = 0; index < rowCount; index++) {
      const p = lookup(FILE_TABLE, index);
      const resource = lookup(RESOURCE_TABLE, index);
      const name = lookup(HASH64_TABLE, index);
      const joaat = lookup(HASH32_TABLE, index);
      const lookupName = lookup(LOOKUP_TABLE, index);
      const chunk = lookup(CHUNK_TABLE, index);
      const crypto = lookup(CRYPTO_TABLE, index);
      if (p === null && resource === null) throw new Error('Directory row lacks a recognized payload record.');
      let offset, stored, decodedSize, type, kind, systemSize = null;
      if (p !== null) {
        kind = 'file';
        offset = Number(data.readBigUInt64LE(p) & 0xffffffffffn) * 16;
        stored = Number(data.readBigUInt64LE(p + 8) & 0xffffffffffn) * 16;
        decodedSize = Number(data.readBigUInt64LE(p + 16) & 0xfffffffffffn);
        type = data[p + 5];
      } else {
        kind = 'resource';
        offset = data.readUInt32LE(resource + 12) * 16;
        stored = data.readUInt32LE(resource + 8) * 16;
        systemSize = data.readUInt32LE(resource) & 0x7ffffff0;
        decodedSize = systemSize + (data.readUInt32LE(resource + 4) & 0xfffffff0) >>> 0;
        type = data[resource + 16];
      }
      rows.push({
        id: index, kind: type === 0 ? 'archive' : kind, offset, stored, size: decodedSize, type, systemSize,
        hash64: name === null ? null : data.readBigUInt64LE(name).toString(16).padStart(16, '0'),
        hash32: joaat === null ? null : data.readUInt32LE(joaat).toString(16).padStart(8, '0'),
        lookupHash: lookupName === null ? null : data.readBigUInt64LE(lookupName).toString(16).padStart(16, '0'),
        chunks: chunk === null ? null : readChunks(data, chunk, split, stored, decodedSize, p === null ? 16 : 0),
        crypto: crypto === null ? null : {
          ...readCipher(data, crypto),
          lead: Number(data.readBigUInt64LE(crypto + 24)),
          block: Number(data.readBigUInt64LE(crypto + 32)),
          step: Number(data.readBigUInt64LE(crypto + 40)),
          tail: Number(data.readBigUInt64LE(crypto + 48)),
        },
      });
    }
    const physical = rows.slice().sort((a,b) => a.offset - b.offset);
    for (let i = 0; i < physical.length; i++) {
      const row = physical[i];
      const limit = physical[i + 1]?.offset ?? bodyEnd;
      requireFormat(row.offset >= directoryEnd && row.offset <= limit, 'Payload offsets are outside the archive body.');
      requireFormat(Number.isSafeInteger(row.stored) && row.stored >= 0 &&
        row.offset + row.stored <= limit && row.offset + row.stored <= bodyEnd &&
        Number.isSafeInteger(row.size) && row.size >= 0,
        'Payload length crosses another entry or the archive boundary.');
    }
    // Keep all game paths read-only and reference the same validated extent on extraction.
    return { path, name: basename(path), start, size, rowCount, rows, directoryEnd, trailer, identity, headerHash, headerSignature,
      logicalSize, availableRanges };
  } finally {
    closeSync(fd);
  }
}

const u64 = n => BigInt.asUintN(64, n);
const rotate = (value, bits) => u64(value << bits | value >> (64n - bits));
const MURMUR_A = 0x87c37b91114253d5n;
const MURMUR_B = 0x4cf5ad432745937fn;
function mix(value) {
  value = u64((value ^ value >> 33n) * 0xff51afd7ed558ccdn);
  value = u64((value ^ value >> 33n) * 0xc4ceb9fe1a85ec53n);
  return value ^ value >> 33n;
}

export function murmurName64(bytes) {
  let a = 0n;
  let b = 0n;
  const blockEnd = bytes.length - bytes.length % 16;
  const laneA = n => u64(rotate(u64(n * MURMUR_A), 31n) * MURMUR_B);
  const laneB = n => u64(rotate(u64(n * MURMUR_B), 33n) * MURMUR_A);
  for (let offset = 0; offset < blockEnd; offset += 16) {
    a = u64((rotate(a ^ laneA(bytes.readBigUInt64LE(offset)), 27n) + b) * 5n + 0x52dce729n);
    b = u64((rotate(b ^ laneB(bytes.readBigUInt64LE(offset + 8)), 31n) + a) * 5n + 0x38495ab5n);
  }
  const tail = Buffer.alloc(16);
  bytes.copy(tail, 0, blockEnd);
  a ^= laneA(tail.readBigUInt64LE(0));
  b ^= laneB(tail.readBigUInt64LE(8));
  const length = BigInt(bytes.length & 255);
  a = u64((a ^ length) + (b ^ length));
  b = u64((b ^ length) + a);
  return u64(mix(a) + mix(b)).toString(16).padStart(16, '0');
}

export function joaatName32(bytes) {
  let hash = 0;
  for (const byte of bytes) {
    hash = (hash + byte) >>> 0;
    hash = (hash + (hash << 10)) >>> 0;
    hash ^= hash >>> 6;
  }
  hash = (hash + (hash << 3)) >>> 0;
  hash ^= hash >>> 11;
  return ((hash + (hash << 15)) >>> 0).toString(16).padStart(8, '0');
}

export function* candidatePaths(text) {
  const paths = /(?:[a-z][a-z0-9_]*:[\\/])?(?:[a-z0-9_@.-]+[\\/])+[a-z0-9_@.-]{2,}|[a-z0-9_@-]{3,}\.(?:[a-z][a-z0-9]{1,10})(?=[^\w.-]|$)/gi;
  for (const match of text.matchAll(paths)) {
    const raw = match[0].replace(/\\/g, '/');
    if (raw.length <= 255 && !raw.startsWith('//') && !raw.includes('../')) yield raw;
  }
}

function archiveIdentity(stat) {
  return [stat.size, stat.mtimeMs, stat.ino, stat.dev];
}

export function openVerifiedArchiveFile(archive) {
  const fd = openSync(archive.path, 'r');
  try {
    const identity = archiveIdentity(fstatSync(fd));
    requireFormat(identity.every((part, i) => part === archive.identity[i]), 'The archive changed. Reopen it before extracting.');
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function readStored(archive, row, limit = row.stored) {
  requireFormat(Number.isSafeInteger(limit) && limit >= 0, 'Invalid read limit.');
  const offset = archive.start+row.offset;
  const length = Math.min(row.stored,limit);
  requireFormat(hasByteRange(archive.availableRanges,offset,length), 'This part of the archive has not downloaded yet.');
  const fd = openVerifiedArchiveFile(archive);
  try {
    return bytesAt(fd, offset, length);
  } finally {
    closeSync(fd);
  }
}
