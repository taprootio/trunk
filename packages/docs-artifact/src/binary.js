const PlainArrayBuffer = ArrayBuffer;
const PlainUint8Array = Uint8Array;
const typedArrayPrototype = Object.getPrototypeOf(PlainUint8Array.prototype);
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer").get;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset").get;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength").get;
const typedArrayName = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag).get;
const typedArraySet = PlainUint8Array.prototype.set;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(PlainArrayBuffer.prototype, "byteLength").get;
const sharedArrayBufferByteLength = typeof SharedArrayBuffer === "undefined"
  ? undefined
  : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength").get;

export function classifyBinaryInput(input) {
  if (input === null || (typeof input !== "object" && typeof input !== "function")) return { kind: "other" };
  try {
    const name = typedArrayName.call(input);
    if (name !== undefined) return { kind: name === "Uint8Array" ? "uint8array" : "unsupported_binary" };
  } catch {
    // Continue with the remaining internal-slot probes.
  }
  try {
    arrayBufferByteLength.call(input);
    return { kind: "arraybuffer" };
  } catch {
    // Continue with the remaining internal-slot probes.
  }
  if (sharedArrayBufferByteLength) {
    try {
      sharedArrayBufferByteLength.call(input);
      return { kind: "unsupported_binary" };
    } catch {
      // Continue with ordinary object classification.
    }
  }
  return { kind: "other" };
}

export function snapshotBinaryInput(input, maximumBytes, classification = classifyBinaryInput(input)) {
  try {
    if (classification.kind === "uint8array") {
      const byteLength = typedArrayByteLength.call(input);
      if (byteLength > maximumBytes) return { kind: "too_large", byteLength };
      const buffer = typedArrayBuffer.call(input);
      const byteOffset = typedArrayByteOffset.call(input);
      const bufferByteLength = arrayBufferByteLength.call(buffer);
      if (byteOffset + byteLength > bufferByteLength) return { kind: "invalid" };
      const source = new PlainUint8Array(buffer, byteOffset, byteLength);
      const bytes = new PlainUint8Array(byteLength);
      typedArraySet.call(bytes, source);
      if (typedArrayByteLength.call(bytes) !== byteLength) return { kind: "invalid" };
      return { kind: "bytes", bytes, byteLength };
    }
    if (classification.kind === "arraybuffer") {
      const byteLength = arrayBufferByteLength.call(input);
      if (byteLength > maximumBytes) return { kind: "too_large", byteLength };
      const source = new PlainUint8Array(input);
      const bytes = new PlainUint8Array(byteLength);
      typedArraySet.call(bytes, source);
      if (typedArrayByteLength.call(bytes) !== byteLength) return { kind: "invalid" };
      return { kind: "bytes", bytes, byteLength };
    }
  } catch {
    return { kind: "invalid" };
  }
  return { kind: "invalid" };
}
