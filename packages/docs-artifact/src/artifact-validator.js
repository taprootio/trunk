import { LIMITS } from "./constants.js";
import { snapshotBinaryInput } from "./binary.js";
import { DocsArtifactValidationError, ValidationContext } from "./errors.js";
import { validateManifest } from "./manifest-validator.js";
import { compareFragmentHeadings, validateHtmlFragment } from "./markup.js";
import { normalizeArtifactPath } from "./path.js";

function inspectStringContent(content, remainingArtifactBytes) {
  let byteLength = 0;
  for (let offset = 0; offset < content.length;) {
    const first = content.charCodeAt(offset);
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = content.charCodeAt(offset + 1);
      if (!(second >= 0xdc00 && second <= 0xdfff)) return { error: "file.invalid_unicode" };
      byteLength += 4;
      offset += 2;
    } else {
      if (first >= 0xdc00 && first <= 0xdfff) return { error: "file.invalid_unicode" };
      byteLength += first <= 0x7f ? 1 : first <= 0x7ff ? 2 : 3;
      offset += 1;
    }
    if (byteLength > remainingArtifactBytes) return { kind: "string", content, byteLength };
  }
  return { kind: "string", content, byteLength };
}

function inspectContent(content, maximumBytes, remainingArtifactBytes) {
  if (typeof content === "string") return inspectStringContent(content, remainingArtifactBytes);
  const snapshotLimit = Math.min(maximumBytes, remainingArtifactBytes);
  const snapshot = snapshotBinaryInput(content, snapshotLimit);
  if (snapshot.kind === "too_large") return { kind: "bytes", byteLength: snapshot.byteLength };
  if (snapshot.kind === "bytes") return snapshot;
  return undefined;
}

function materializeContent(content) {
  if (content.kind === "string") return new TextEncoder().encode(content.content);
  return content.bytes;
}

async function sha256(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function ascii(bytes, start, length) {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function readUint24Le(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readUint16Be(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint16Le(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32Be(bytes, offset) {
  return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}

function readUint32Le(bytes, offset) {
  return (bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16) + (bytes[offset + 3] * 0x1000000)) >>> 0;
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  return crc >>> 0;
});

function crc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function checkedImageDimensions(width, height, frames = 1) {
  if (width * height > LIMITS.decodedPixels) return { error: "asset.decoded_pixels" };
  if (frames > LIMITS.animationFrames) return { error: "asset.animation_frames" };
  return { width, height };
}

function readPngDimensions(bytes) {
  if (bytes.length < 45 || ascii(bytes, 0, 8) !== "\u0089PNG\r\n\u001a\n") return undefined;
  let offset = 8;
  let dimensions;
  let bitDepth;
  let colorType;
  let imageDataBytes = 0;
  let sawImageData = false;
  let leftImageData = false;
  let sawPalette = false;
  let animationDeclaredFrames;
  let animationFrameControls = 0;
  let decodedAnimationPixels = 0;
  let completedAnimationFrames = 0;
  let nextAnimationSequence = 0;
  let currentAnimationFrame;
  let chunkIndex = 0;
  while (offset + 12 <= bytes.length) {
    const dataLength = readUint32Be(bytes, offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + dataLength;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > bytes.length) return undefined;
    const type = ascii(bytes, offset + 4, 4);
    if (!/^[A-Za-z]{4}$/u.test(type) || (bytes[offset + 6] & 0x20) !== 0) return undefined;
    if (readUint32Be(bytes, dataEnd) !== crc32(bytes, offset + 4, dataEnd)) return undefined;

    if (chunkIndex === 0 && type !== "IHDR") return undefined;
    if (sawImageData && type !== "IDAT") leftImageData = true;
    if (currentAnimationFrame?.dataBytes > 0) {
      const expectedDataType = currentAnimationFrame.mode === "idat" ? "IDAT" : "fdAT";
      if (type !== expectedDataType && type !== "fcTL" && type !== "IEND") currentAnimationFrame.dataEnded = true;
    }
    if (type === "IHDR") {
      if (chunkIndex !== 0 || dataLength !== 13 || dimensions) return undefined;
      const width = readUint32Be(bytes, dataStart);
      const height = readUint32Be(bytes, dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      const validDepths = new Map([
        [0, new Set([1, 2, 4, 8, 16])],
        [2, new Set([8, 16])],
        [3, new Set([1, 2, 4, 8])],
        [4, new Set([8, 16])],
        [6, new Set([8, 16])],
      ]);
      if (width === 0 || height === 0 || !validDepths.get(colorType)?.has(bitDepth)) return undefined;
      if (bytes[dataStart + 10] !== 0 || bytes[dataStart + 11] !== 0 || bytes[dataStart + 12] > 1) return undefined;
      dimensions = checkedImageDimensions(width, height);
      if (dimensions.error) return dimensions;
    } else if (type === "acTL") {
      if (!dimensions || animationDeclaredFrames !== undefined || sawImageData || currentAnimationFrame || dataLength !== 8) return undefined;
      animationDeclaredFrames = readUint32Be(bytes, dataStart);
      if (animationDeclaredFrames === 0) return undefined;
      if (animationDeclaredFrames > LIMITS.animationFrames) return { error: "asset.animation_frames" };
    } else if (type === "fcTL") {
      if (!dimensions || animationDeclaredFrames === undefined || dataLength !== 26) return undefined;
      if (currentAnimationFrame) {
        if (currentAnimationFrame.dataBytes === 0) return undefined;
        completedAnimationFrames += 1;
      }
      if (readUint32Be(bytes, dataStart) !== nextAnimationSequence) return undefined;
      nextAnimationSequence += 1;
      const frameWidth = readUint32Be(bytes, dataStart + 4);
      const frameHeight = readUint32Be(bytes, dataStart + 8);
      const frameLeft = readUint32Be(bytes, dataStart + 12);
      const frameTop = readUint32Be(bytes, dataStart + 16);
      if (
        frameWidth === 0 || frameHeight === 0 ||
        frameLeft + frameWidth > dimensions.width || frameTop + frameHeight > dimensions.height ||
        bytes[dataStart + 24] > 2 || bytes[dataStart + 25] > 1
      ) return undefined;
      decodedAnimationPixels += frameWidth * frameHeight;
      if (decodedAnimationPixels > LIMITS.decodedAnimationPixels) return { error: "asset.decoded_animation_pixels" };
      animationFrameControls += 1;
      if (animationFrameControls > LIMITS.animationFrames) return { error: "asset.animation_frames" };
      const mode = sawImageData ? "fdat" : "idat";
      if (mode === "idat" && (
        animationFrameControls !== 1 || frameWidth !== dimensions.width || frameHeight !== dimensions.height || frameLeft !== 0 || frameTop !== 0
      )) return undefined;
      currentAnimationFrame = { mode, dataBytes: 0, dataEnded: false };
    } else if (type === "PLTE") {
      const entries = dataLength / 3;
      if (
        !dimensions || sawPalette || sawImageData || ![2, 3, 6].includes(colorType) ||
        dataLength === 0 || dataLength > 768 || dataLength % 3 !== 0 ||
        (colorType === 3 && entries > 2 ** bitDepth)
      ) return undefined;
      sawPalette = true;
    } else if (type === "IDAT") {
      if (!dimensions || leftImageData || (colorType === 3 && !sawPalette) || currentAnimationFrame?.mode === "fdat") return undefined;
      if (currentAnimationFrame?.dataEnded) return undefined;
      sawImageData = true;
      imageDataBytes += dataLength;
      if (currentAnimationFrame?.mode === "idat") currentAnimationFrame.dataBytes += dataLength;
    } else if (type === "fdAT") {
      if (
        !dimensions || animationDeclaredFrames === undefined || !currentAnimationFrame || currentAnimationFrame.mode !== "fdat" ||
        currentAnimationFrame.dataEnded || dataLength <= 4 || readUint32Be(bytes, dataStart) !== nextAnimationSequence
      ) return undefined;
      nextAnimationSequence += 1;
      currentAnimationFrame.dataBytes += dataLength - 4;
    } else if (type === "IEND") {
      if (dataLength !== 0 || !dimensions || imageDataBytes === 0 || chunkEnd !== bytes.length) return undefined;
      if (colorType === 3 && !sawPalette) return undefined;
      if (currentAnimationFrame) {
        if (currentAnimationFrame.dataBytes === 0) return undefined;
        completedAnimationFrames += 1;
      }
      if (animationDeclaredFrames !== undefined && (
        animationFrameControls === 0 || animationDeclaredFrames !== completedAnimationFrames
      )) return undefined;
      return dimensions;
    } else {
      if ((type.charCodeAt(0) & 0x20) === 0) return undefined;
      if (sawImageData) leftImageData = true;
    }
    offset = chunkEnd;
    chunkIndex += 1;
  }
  return undefined;
}

function skipGifSubBlocks(bytes, offset, requireData) {
  let sawData = false;
  while (offset < bytes.length) {
    const length = bytes[offset];
    offset += 1;
    if (length === 0) return !requireData || sawData ? offset : undefined;
    if (offset + length > bytes.length) return undefined;
    sawData = true;
    offset += length;
  }
  return undefined;
}

function skipGifExtension(bytes, offset) {
  const label = bytes[offset];
  const blockStart = offset + 1;
  if (label === 0xf9) {
    if (blockStart + 6 > bytes.length || bytes[blockStart] !== 4 || bytes[blockStart + 5] !== 0) return undefined;
    const packed = bytes[blockStart + 1];
    if ((packed & 0xe0) !== 0 || ((packed >>> 2) & 0x07) > 3) return undefined;
    return blockStart + 6;
  }
  if (label === 0xff) {
    if (blockStart + 12 > bytes.length || bytes[blockStart] !== 11) return undefined;
    return skipGifSubBlocks(bytes, blockStart + 12, false);
  }
  if (label === 0x01) {
    if (blockStart + 13 > bytes.length || bytes[blockStart] !== 12) return undefined;
    return skipGifSubBlocks(bytes, blockStart + 13, false);
  }
  if (label === 0xfe) return skipGifSubBlocks(bytes, blockStart, false);
  return undefined;
}

function readGifDimensions(bytes) {
  if (bytes.length < 15 || !["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) return undefined;
  const width = readUint16Le(bytes, 6);
  const height = readUint16Le(bytes, 8);
  if (width === 0 || height === 0) return undefined;
  const dimensions = checkedImageDimensions(width, height);
  if (dimensions.error) return dimensions;
  let offset = 13;
  const hasGlobalColorTable = (bytes[10] & 0x80) !== 0;
  if (hasGlobalColorTable) offset += 3 * (2 ** ((bytes[10] & 0x07) + 1));
  if (offset > bytes.length) return undefined;
  let frameCount = 0;
  let decodedAnimationPixels = 0;
  while (offset < bytes.length) {
    const introducer = bytes[offset];
    if (introducer === 0x3b) return frameCount > 0 && offset + 1 === bytes.length ? dimensions : undefined;
    if (introducer === 0x21) {
      if (offset + 2 > bytes.length) return undefined;
      offset = skipGifExtension(bytes, offset + 1);
      if (offset === undefined) return undefined;
      continue;
    }
    if (introducer !== 0x2c || offset + 10 > bytes.length) return undefined;
    const imageLeft = readUint16Le(bytes, offset + 1);
    const imageTop = readUint16Le(bytes, offset + 3);
    const imageWidth = readUint16Le(bytes, offset + 5);
    const imageHeight = readUint16Le(bytes, offset + 7);
    if (imageWidth === 0 || imageHeight === 0 || imageLeft + imageWidth > width || imageTop + imageHeight > height) return undefined;
    decodedAnimationPixels += imageWidth * imageHeight;
    if (decodedAnimationPixels > LIMITS.decodedAnimationPixels) return { error: "asset.decoded_animation_pixels" };
    frameCount += 1;
    if (frameCount > LIMITS.animationFrames) return { error: "asset.animation_frames" };
    const packed = bytes[offset + 9];
    if ((packed & 0x18) !== 0) return undefined;
    offset += 10;
    const hasLocalColorTable = (packed & 0x80) !== 0;
    if (!hasGlobalColorTable && !hasLocalColorTable) return undefined;
    if (hasLocalColorTable) offset += 3 * (2 ** ((packed & 0x07) + 1));
    if (offset > bytes.length) return undefined;
    if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) return undefined;
    offset = skipGifSubBlocks(bytes, offset + 1, true);
    if (offset === undefined) return undefined;
  }
  return undefined;
}

function findJpegMarkerAfterScan(bytes, offset, restartInterval, expectedRestartMarkers) {
  let sawEntropySinceRestart = false;
  let expectedRestart = 0;
  let restartMarkers = 0;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      sawEntropySinceRestart = true;
      offset += 1;
      continue;
    }
    const markerStart = offset;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return undefined;
    const marker = bytes[offset];
    if (marker === 0x00) {
      if (offset - markerStart !== 1) return undefined;
      sawEntropySinceRestart = true;
      offset += 1;
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      if (!sawEntropySinceRestart || restartInterval === 0 || marker !== 0xd0 + expectedRestart) return undefined;
      expectedRestart = (expectedRestart + 1) & 0x07;
      restartMarkers += 1;
      if (restartMarkers > expectedRestartMarkers) return undefined;
      sawEntropySinceRestart = false;
      offset += 1;
      continue;
    }
    return sawEntropySinceRestart && restartMarkers === expectedRestartMarkers ? markerStart : undefined;
  }
  return undefined;
}

function isValidJpegHuffmanTable(bytes, countsOffset, symbolsOffset, symbolCount, tableClass) {
  if (symbolCount === 0 || symbolCount > 256) return false;
  let remainingCodeSpace = 1;
  for (let index = 0; index < 16; index += 1) {
    remainingCodeSpace = (remainingCodeSpace * 2) - bytes[countsOffset + index];
    if (remainingCodeSpace < 0) return false;
  }
  if (remainingCodeSpace === 0) return false;
  for (let index = 0; index < symbolCount; index += 1) {
    const symbol = bytes[symbolsOffset + index];
    if (tableClass === 0 && symbol > 11) return false;
    if (tableClass === 1) {
      const run = symbol >>> 4;
      const size = symbol & 0x0f;
      if (size === 0 ? run !== 0 && run !== 15 : size > 10) return false;
    }
  }
  return true;
}

function readJpegDimensions(bytes) {
  if (bytes.length < 8 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  const quantizationTables = new Set();
  const huffmanTables = new Set();
  const components = new Map();
  const scannedComponents = new Set();
  let offset = 2;
  let dimensions;
  let restartInterval = 0;
  let maxHorizontalSampling = 0;
  let maxVerticalSampling = 0;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return undefined;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x00 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) return undefined;
    if (marker === 0xd9) {
      return dimensions && scannedComponents.size === components.size && offset === bytes.length ? dimensions : undefined;
    }
    if (marker === 0xcc) return undefined;
    if (offset + 2 > bytes.length) return undefined;
    const length = readUint16Be(bytes, offset);
    const segmentEnd = offset + length;
    if (length < 2 || segmentEnd > bytes.length) return undefined;
    if (marker === 0xdb) {
      let tableOffset = offset + 2;
      while (tableOffset < segmentEnd) {
        const information = bytes[tableOffset];
        const precision = information >>> 4;
        const tableId = information & 0x0f;
        const coefficientsStart = tableOffset + 1;
        const tableEnd = coefficientsStart + 64;
        if (precision !== 0 || tableId > 3 || tableEnd > segmentEnd) return undefined;
        for (let index = coefficientsStart; index < tableEnd; index += 1) {
          if (bytes[index] === 0) return undefined;
        }
        quantizationTables.add(tableId);
        tableOffset = tableEnd;
      }
      if (tableOffset !== segmentEnd) return undefined;
    } else if (marker === 0xc4) {
      let tableOffset = offset + 2;
      while (tableOffset < segmentEnd) {
        if (tableOffset + 17 > segmentEnd) return undefined;
        const information = bytes[tableOffset];
        const tableClass = information >>> 4;
        const tableId = information & 0x0f;
        if (tableClass > 1 || tableId > 3) return undefined;
        const countsOffset = tableOffset + 1;
        let symbols = 0;
        for (let index = 0; index < 16; index += 1) symbols += bytes[countsOffset + index];
        const symbolsOffset = countsOffset + 16;
        const tableEnd = symbolsOffset + symbols;
        if (
          tableEnd > segmentEnd ||
          !isValidJpegHuffmanTable(bytes, countsOffset, symbolsOffset, symbols, tableClass)
        ) return undefined;
        huffmanTables.add(`${tableClass}:${tableId}`);
        tableOffset = tableEnd;
      }
      if (tableOffset !== segmentEnd) return undefined;
    } else if (frameMarkers.has(marker)) {
      if (marker !== 0xc0 || dimensions || length < 11 || bytes[offset + 2] !== 8) return undefined;
      const componentCount = bytes[offset + 7];
      if (![1, 3].includes(componentCount) || length !== 8 + (3 * componentCount)) return undefined;
      const height = readUint16Be(bytes, offset + 3);
      const width = readUint16Be(bytes, offset + 5);
      if (width === 0 || height === 0) return undefined;
      let samplingUnits = 0;
      for (let index = 0; index < componentCount; index += 1) {
        const componentOffset = offset + 8 + (3 * index);
        const componentId = bytes[componentOffset];
        const sampling = bytes[componentOffset + 1];
        const horizontalSampling = sampling >>> 4;
        const verticalSampling = sampling & 0x0f;
        const quantizationTable = bytes[componentOffset + 2];
        if (
          components.has(componentId) || horizontalSampling === 0 || horizontalSampling > 4 ||
          verticalSampling === 0 || verticalSampling > 4 || quantizationTable > 3
        ) return undefined;
        samplingUnits += horizontalSampling * verticalSampling;
        if (samplingUnits > 10) return undefined;
        maxHorizontalSampling = Math.max(maxHorizontalSampling, horizontalSampling);
        maxVerticalSampling = Math.max(maxVerticalSampling, verticalSampling);
        components.set(componentId, { horizontalSampling, verticalSampling, quantizationTable });
      }
      const candidateDimensions = checkedImageDimensions(width, height);
      if (candidateDimensions.error) return candidateDimensions;
      dimensions = candidateDimensions;
    } else if (marker === 0xdd) {
      if (length !== 4) return undefined;
      restartInterval = readUint16Be(bytes, offset + 2);
    } else if (marker === 0xda) {
      const componentCount = bytes[offset + 2];
      if (
        !dimensions || componentCount === 0 || componentCount > components.size || length !== 6 + (2 * componentCount)
      ) return undefined;
      const scanComponents = new Set();
      let singleScanComponent;
      for (let index = 0; index < componentCount; index += 1) {
        const componentOffset = offset + 3 + (2 * index);
        const componentId = bytes[componentOffset];
        const selectors = bytes[componentOffset + 1];
        const dcTable = selectors >>> 4;
        const acTable = selectors & 0x0f;
        const component = components.get(componentId);
        if (
          !component || scanComponents.has(componentId) || scannedComponents.has(componentId) ||
          !quantizationTables.has(component.quantizationTable) ||
          !huffmanTables.has(`0:${dcTable}`) || !huffmanTables.has(`1:${acTable}`)
        ) return undefined;
        scanComponents.add(componentId);
        singleScanComponent = component;
      }
      const spectralOffset = offset + 3 + (2 * componentCount);
      if (bytes[spectralOffset] !== 0 || bytes[spectralOffset + 1] !== 63 || bytes[spectralOffset + 2] !== 0) return undefined;
      const mcuColumns = componentCount === 1
        ? Math.ceil((dimensions.width * singleScanComponent.horizontalSampling) / (8 * maxHorizontalSampling))
        : Math.ceil(dimensions.width / (8 * maxHorizontalSampling));
      const mcuRows = componentCount === 1
        ? Math.ceil((dimensions.height * singleScanComponent.verticalSampling) / (8 * maxVerticalSampling))
        : Math.ceil(dimensions.height / (8 * maxVerticalSampling));
      const mcuCount = mcuColumns * mcuRows;
      const expectedRestartMarkers = restartInterval === 0 ? 0 : Math.floor((mcuCount - 1) / restartInterval);
      offset = findJpegMarkerAfterScan(bytes, segmentEnd, restartInterval, expectedRestartMarkers);
      if (offset === undefined) return undefined;
      for (const componentId of scanComponents) scannedComponents.add(componentId);
      continue;
    } else {
      const allowedMetadata = marker === 0xfe || (marker >= 0xe0 && marker <= 0xef);
      if (!allowedMetadata) return undefined;
    }
    offset = segmentEnd;
  }
  return undefined;
}

function readVp8Dimensions(bytes, dataStart, dataLength) {
  if (dataLength < 11 || ascii(bytes, dataStart + 3, 3) !== "\u009d\u0001*") return undefined;
  const frameTag = bytes[dataStart] | (bytes[dataStart + 1] << 8) | (bytes[dataStart + 2] << 16);
  const firstPartitionSize = frameTag >>> 5;
  if (
    (frameTag & 0x01) !== 0 || ((frameTag >>> 1) & 0x07) > 3 || (frameTag & 0x10) === 0 ||
    firstPartitionSize === 0 || dataLength <= 10 + firstPartitionSize
  ) return undefined;
  const width = readUint16Le(bytes, dataStart + 6) & 0x3fff;
  const height = readUint16Le(bytes, dataStart + 8) & 0x3fff;
  return width > 0 && height > 0 ? checkedImageDimensions(width, height) : undefined;
}

function readVp8lDimensions(bytes, dataStart, dataLength) {
  if (dataLength <= 5 || bytes[dataStart] !== 0x2f || (bytes[dataStart + 4] & 0xe0) !== 0) return undefined;
  const dimensions = checkedImageDimensions(
    1 + bytes[dataStart + 1] + ((bytes[dataStart + 2] & 0x3f) << 8),
    1 + ((bytes[dataStart + 2] & 0xc0) >> 6) + (bytes[dataStart + 3] << 2) + ((bytes[dataStart + 4] & 0x0f) << 10),
  );
  return dimensions.error ? dimensions : { ...dimensions, alphaUsed: (bytes[dataStart + 4] & 0x10) !== 0 };
}

function validateWebpAlpha(bytes, dataStart, dataLength, width, height) {
  if (dataLength <= 1) return false;
  const header = bytes[dataStart];
  const compression = header & 0x03;
  const preprocessing = (header >>> 4) & 0x03;
  if ((header & 0xc0) !== 0 || compression > 1 || preprocessing > 1) return false;
  if (compression === 0 && dataLength !== 1 + (width * height)) return false;
  return true;
}

function validateWebpFrame(bytes, start, end, width, height) {
  let offset = start;
  let dimensions;
  let sawAlpha = false;
  while (offset + 8 <= end) {
    const type = ascii(bytes, offset, 4);
    const length = readUint32Le(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + (length & 1);
    if (dataEnd < dataStart || chunkEnd > end) return undefined;
    if ((length & 1) !== 0 && bytes[dataEnd] !== 0) return undefined;
    if (type === "ALPH") {
      if (sawAlpha || dimensions || !validateWebpAlpha(bytes, dataStart, length, width, height)) return undefined;
      sawAlpha = true;
    } else if (type === "VP8 ") {
      if (dimensions) return undefined;
      dimensions = readVp8Dimensions(bytes, dataStart, length);
    } else if (type === "VP8L") {
      if (sawAlpha || dimensions) return undefined;
      dimensions = readVp8lDimensions(bytes, dataStart, length);
    } else {
      return undefined;
    }
    if ((type === "VP8 " || type === "VP8L") && !dimensions) return undefined;
    if (dimensions?.error) return dimensions;
    offset = chunkEnd;
  }
  return offset === end && dimensions
    ? { ...dimensions, alphaObserved: sawAlpha || dimensions.alphaUsed === true }
    : undefined;
}

function validateWebpAnimationFrame(bytes, dataStart, dataEnd, canvasDimensions) {
  if (!canvasDimensions || dataEnd - dataStart < 16 || (bytes[dataStart + 15] & 0xfc) !== 0) return undefined;
  const x = readUint24Le(bytes, dataStart) * 2;
  const y = readUint24Le(bytes, dataStart + 3) * 2;
  const width = readUint24Le(bytes, dataStart + 6) + 1;
  const height = readUint24Le(bytes, dataStart + 9) + 1;
  const dimensions = checkedImageDimensions(width, height);
  if (dimensions.error) return dimensions;
  if (x + width > canvasDimensions.width || y + height > canvasDimensions.height) return undefined;
  const embeddedDimensions = validateWebpFrame(bytes, dataStart + 16, dataEnd, width, height);
  if (!embeddedDimensions) return undefined;
  if (embeddedDimensions.error) return embeddedDimensions;
  if (embeddedDimensions.width !== width || embeddedDimensions.height !== height) return undefined;
  return { ...dimensions, alphaObserved: embeddedDimensions.alphaObserved };
}

function readWebpDimensions(bytes) {
  if (bytes.length < 26 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return undefined;
  if (readUint32Le(bytes, 4) !== bytes.length - 8) return undefined;
  let offset = 12;
  let firstChunk = true;
  let canvasDimensions;
  let payloadDimensions;
  let extendedFlags;
  let sawIccp = false;
  let sawTopLevelAlpha = false;
  let pendingTopLevelAlpha = false;
  let sawExif = false;
  let sawXmp = false;
  let sawAnimationHeader = false;
  let animationAlphaObserved = false;
  let animationFrameCount = 0;
  let decodedAnimationPixels = 0;
  let animationFrameRunEnded = false;
  let chunkIndex = 0;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const length = readUint32Le(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + (length & 1);
    if (dataEnd < dataStart || chunkEnd > bytes.length) return undefined;
    if ((length & 1) !== 0 && bytes[dataEnd] !== 0) return undefined;
    if (firstChunk && !["VP8 ", "VP8L", "VP8X"].includes(type)) return undefined;
    firstChunk = false;
    if (pendingTopLevelAlpha && type !== "VP8 ") return undefined;
    if (sawAnimationHeader && animationFrameCount === 0 && type !== "ANMF") return undefined;
    if (animationFrameCount > 0 && type !== "ANMF") animationFrameRunEnded = true;
    if (type === "VP8X") {
      if (chunkIndex !== 0 || canvasDimensions || length !== 10 || (bytes[dataStart] & 0xc1) !== 0) return undefined;
      if (bytes[dataStart + 1] !== 0 || bytes[dataStart + 2] !== 0 || bytes[dataStart + 3] !== 0) return undefined;
      extendedFlags = bytes[dataStart];
      canvasDimensions = checkedImageDimensions(
        readUint24Le(bytes, dataStart + 4) + 1,
        readUint24Le(bytes, dataStart + 7) + 1,
      );
      if (canvasDimensions.error) return canvasDimensions;
    } else if (type === "ICCP") {
      if (!canvasDimensions || sawIccp || payloadDimensions || sawTopLevelAlpha || sawAnimationHeader || sawExif || sawXmp || length < 1) {
        return undefined;
      }
      sawIccp = true;
    } else if (type === "ALPH") {
      if (
        !canvasDimensions || sawTopLevelAlpha || payloadDimensions || sawAnimationHeader || sawExif || sawXmp ||
        !validateWebpAlpha(bytes, dataStart, length, canvasDimensions.width, canvasDimensions.height)
      ) return undefined;
      sawTopLevelAlpha = true;
      pendingTopLevelAlpha = true;
    } else if (type === "VP8 ") {
      if (payloadDimensions || sawAnimationHeader || animationFrameCount > 0 || sawExif || sawXmp || (extendedFlags & 0x02) !== 0) return undefined;
      payloadDimensions = readVp8Dimensions(bytes, dataStart, length);
      if (!payloadDimensions) return undefined;
      if (payloadDimensions.error) return payloadDimensions;
      pendingTopLevelAlpha = false;
    } else if (type === "VP8L") {
      if (payloadDimensions || sawTopLevelAlpha || sawAnimationHeader || animationFrameCount > 0 || sawExif || sawXmp || (extendedFlags & 0x02) !== 0) {
        return undefined;
      }
      payloadDimensions = readVp8lDimensions(bytes, dataStart, length);
      if (!payloadDimensions) return undefined;
      if (payloadDimensions.error) return payloadDimensions;
    } else if (type === "ANIM") {
      if (!canvasDimensions || (extendedFlags & 0x02) === 0 || sawAnimationHeader || animationFrameCount > 0 || payloadDimensions || sawExif || sawXmp || length !== 6) {
        return undefined;
      }
      sawAnimationHeader = true;
    } else if (type === "ANMF") {
      if (!canvasDimensions || (extendedFlags & 0x02) === 0 || !sawAnimationHeader || animationFrameRunEnded || payloadDimensions || sawExif || sawXmp || length < 16) {
        return undefined;
      }
      animationFrameCount += 1;
      if (animationFrameCount > LIMITS.animationFrames) return { error: "asset.animation_frames" };
      const frameDimensions = validateWebpAnimationFrame(bytes, dataStart, dataEnd, canvasDimensions);
      if (!frameDimensions) return undefined;
      if (frameDimensions.error) return frameDimensions;
      decodedAnimationPixels += frameDimensions.width * frameDimensions.height;
      if (decodedAnimationPixels > LIMITS.decodedAnimationPixels) return { error: "asset.decoded_animation_pixels" };
      animationAlphaObserved ||= frameDimensions.alphaObserved;
    } else if (type === "EXIF") {
      if (!canvasDimensions || sawExif || sawXmp || (!payloadDimensions && animationFrameCount === 0) || length < 1) return undefined;
      sawExif = true;
    } else if (type === "XMP ") {
      if (!canvasDimensions || sawXmp || (!payloadDimensions && animationFrameCount === 0) || length < 1) return undefined;
      sawXmp = true;
    } else {
      return undefined;
    }
    offset = chunkEnd;
    chunkIndex += 1;
  }
  if (offset !== bytes.length) return undefined;
  if (pendingTopLevelAlpha) return undefined;
  if (extendedFlags === undefined) return payloadDimensions;
  const animated = (extendedFlags & 0x02) !== 0;
  if (animated) {
    if (!sawAnimationHeader || animationFrameCount === 0 || payloadDimensions) return undefined;
  } else if (sawAnimationHeader || animationFrameCount > 0 || !payloadDimensions) {
    return undefined;
  }
  const alphaObserved = sawTopLevelAlpha || animationAlphaObserved || payloadDimensions?.alphaUsed === true;
  const observedFeatures = (sawIccp ? 0x20 : 0)
    | (alphaObserved ? 0x10 : 0)
    | (sawExif ? 0x08 : 0)
    | (sawXmp ? 0x04 : 0)
    | (animated ? 0x02 : 0);
  if ((extendedFlags & 0x3e) !== observedFeatures) return undefined;
  if (payloadDimensions && (canvasDimensions.width !== payloadDimensions.width || canvasDimensions.height !== payloadDimensions.height)) return undefined;
  return canvasDimensions;
}

function readImageDimensions(mediaType, bytes) {
  if (mediaType === "image/png") return readPngDimensions(bytes);
  if (mediaType === "image/gif") return readGifDimensions(bytes);
  if (mediaType === "image/jpeg") return readJpegDimensions(bytes);
  if (mediaType === "image/webp") return readWebpDimensions(bytes);
  return undefined;
}

function expectedFiles(manifest) {
  const expected = new Map();
  const variants = [];
  for (let resourceIndex = 0; resourceIndex < manifest.resources.length; resourceIndex += 1) {
    const resource = manifest.resources[resourceIndex];
    for (let variantIndex = 0; variantIndex < resource.variants.length; variantIndex += 1) {
      const variant = resource.variants[variantIndex];
      const fragments = [];
      variants.push({ resource, variant, fragments });
      for (let fragmentIndex = 0; fragmentIndex < variant.fragments.length; fragmentIndex += 1) {
        const fragment = variant.fragments[fragmentIndex];
        const descriptor = {
          kind: "fragment",
          descriptor: fragment,
          resource,
          variant,
          path: `$.resources[${resourceIndex}].variants[${variantIndex}].fragments[${fragmentIndex}]`,
        };
        expected.set(fragment.path, descriptor);
        fragments.push(descriptor);
      }
    }
  }
  for (let assetIndex = 0; assetIndex < manifest.assets.length; assetIndex += 1) {
    const asset = manifest.assets[assetIndex];
    expected.set(asset.path, {
      kind: "asset",
      descriptor: asset,
      path: `$.assets[${assetIndex}]`,
    });
  }
  return { expected, variants };
}

export async function validateArtifact(manifestInput, fileEntries, options = {}) {
  const manifestResult = validateManifest(manifestInput, options);
  if (!manifestResult.ok) return manifestResult;
  const manifest = manifestResult.value;
  const context = new ValidationContext();
  const { expected, variants } = expectedFiles(manifest);
  const files = new Map();
  const seenPaths = new Set();
  let entryCount = 0;
  let totalBytes = 0;
  let artifactByteLimitExceeded = false;

  try {
    for (const entry of fileEntries) {
      entryCount += 1;
      if (entryCount > LIMITS.files) {
        context.add("limit.files", "$files", `Artifact may not contain more than ${LIMITS.files} semantic files.`);
        break;
      }
      const entryPath = `$files[${entryCount - 1}]`;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        context.add("file.invalid_entry", entryPath, "File entries must be objects with path and content.");
        continue;
      }
      const normalized = normalizeArtifactPath(entry.path);
      if (!normalized.ok) {
        context.add(normalized.code, `${entryPath}.path`, normalized.message);
        continue;
      }
      if (seenPaths.has(normalized.value)) {
        context.add("duplicate.file_entry", `${entryPath}.path`, `File '${normalized.value}' appears more than once.`);
        continue;
      }
      seenPaths.add(normalized.value);
      const expectedFile = expected.get(normalized.value);
      if (!expectedFile) {
        context.add("file.unexpected", `${entryPath}.path`, `File '${normalized.value}' is not declared by the semantic manifest.`);
        continue;
      }
      const maximumBytes = expectedFile.kind === "fragment" ? LIMITS.fragmentBytes : LIMITS.assetBytes;
      const remainingArtifactBytes = LIMITS.artifactBytes - totalBytes;
      const content = inspectContent(entry.content, maximumBytes, remainingArtifactBytes);
      if (!content) {
        context.add("file.invalid_content", `${entryPath}.content`, "File content must be a string, Uint8Array, or ArrayBuffer.");
        continue;
      }
      if (content.error) {
        context.add(content.error, `${entryPath}.content`, "String file content must contain only well-formed Unicode scalar values.");
        continue;
      }
      if (content.byteLength > remainingArtifactBytes) {
        context.add("limit.artifact_bytes", "$files", `Artifact bytes may not exceed ${LIMITS.artifactBytes}.`);
        artifactByteLimitExceeded = true;
        break;
      }
      totalBytes += content.byteLength;
      if (content.byteLength > maximumBytes) {
        context.add("file.too_large", `${expectedFile.path}.path`, `File '${normalized.value}' exceeds its ${maximumBytes}-byte content bound.`);
        continue;
      }
      if (content.byteLength !== expectedFile.descriptor.bytes) {
        context.add("file.size_drift", `${expectedFile.path}.bytes`, `File '${normalized.value}' has ${content.byteLength} bytes; manifest declares ${expectedFile.descriptor.bytes}.`);
        if (content.byteLength > expectedFile.descriptor.bytes) {
          continue;
        }
      }
      const bytes = materializeContent(content);
      files.set(normalized.value, bytes);
    }
  } catch {
    context.add("file.invalid_iterable", "$files", "Could not enumerate semantic files safely.");
  }

  if (artifactByteLimitExceeded) return context.finish({ manifest, fileCount: files.size, totalBytes });

  const resources = new Map(manifest.resources.map((resource) => [resource.key, resource]));
  const assets = new Map(manifest.assets.map((asset) => [asset.key, asset]));
  for (const [path, expectedFile] of expected) {
    const bytes = files.get(path);
    if (!bytes) {
      if (!seenPaths.has(path)) {
        context.add("file.missing", `${expectedFile.path}.path`, `Declared file '${path}' is missing.`);
      }
      continue;
    }
    const actualHash = await sha256(bytes);
    if (actualHash !== expectedFile.descriptor.sha256) {
      context.add("file.hash_drift", `${expectedFile.path}.sha256`, `File '${path}' does not match its declared SHA-256.`);
    }
    if (expectedFile.kind === "asset") {
      const dimensions = readImageDimensions(expectedFile.descriptor.mediaType, bytes);
      if (!dimensions) {
        context.add("asset.media_mismatch", `${expectedFile.path}.mediaType`, `File '${path}' is not a supported ${expectedFile.descriptor.mediaType} image.`);
      } else if (dimensions.error === "asset.decoded_pixels") {
        context.add(dimensions.error, expectedFile.path, `File '${path}' exceeds the ${LIMITS.decodedPixels}-pixel decoded image bound.`);
      } else if (dimensions.error === "asset.animation_frames") {
        context.add(dimensions.error, expectedFile.path, `File '${path}' exceeds the ${LIMITS.animationFrames}-frame animation bound.`);
      } else if (dimensions.error === "asset.decoded_animation_pixels") {
        context.add(dimensions.error, expectedFile.path, `File '${path}' exceeds the ${LIMITS.decodedAnimationPixels}-pixel cumulative animation bound.`);
      } else if (dimensions.width !== expectedFile.descriptor.width || dimensions.height !== expectedFile.descriptor.height) {
        context.add("asset.dimension_drift", expectedFile.path, `File '${path}' dimensions do not match the manifest.`);
      }
    }
  }

  for (const { variant, fragments } of variants) {
    const actualHeadings = [];
    let actualHeadingCount = 0;
    const maximumCollectedHeadings = variant.headings.length + 1;
    const model = {
      resources,
      assets,
      locale: variant.locale,
      localHeadingIds: new Set(variant.headings.map((heading) => heading.id)),
    };
    for (const fragment of fragments) {
      const bytes = files.get(fragment.descriptor.path);
      if (!bytes) continue;
      let markup;
      try {
        markup = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        context.add("fragment.invalid_utf8", `${fragment.path}.path`, `Fragment '${fragment.descriptor.path}' must be valid UTF-8.`);
        continue;
      }
      const headingResult = validateHtmlFragment(
        markup,
        context,
        `${fragment.path}.path`,
        model,
        Math.max(0, maximumCollectedHeadings - actualHeadings.length),
      );
      actualHeadings.push(...headingResult.headings);
      actualHeadingCount += headingResult.headingCount;
    }
    compareFragmentHeadings(actualHeadings, variant.headings, context, `resource:${variant.route}`, actualHeadingCount);
  }

  return context.finish({ manifest, fileCount: files.size, totalBytes });
}

export async function assertValidArtifact(manifestInput, fileEntries, options = {}) {
  const result = await validateArtifact(manifestInput, fileEntries, options);
  if (!result.ok) throw new DocsArtifactValidationError(result.errors);
  return result.value;
}
