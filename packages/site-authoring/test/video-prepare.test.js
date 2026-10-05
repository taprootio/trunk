import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ALL_FORMATS,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  FilePathSource,
  Input,
  Mp4OutputFormat,
  Output,
} from "mediabunny";

import { indexComesFirst, isAac, isH264, mp4Name, prepareVideoFile } from "../src/video-prepare.js";

const fixturePath = (name) => path.join(import.meta.dirname, "fixtures", "video", name);
const bytesOf = (name) => readFileSync(fixturePath(name));

function indexFirstIn(bytes) {
  let offset = 0;
  while (offset + 8 <= bytes.byteLength) {
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (type === "moov") return true;
    if (type === "mdat") return false;
    offset += bytes.readUInt32BE(offset);
  }
  return false;
}

const prepare = (name, options = {}) =>
  prepareVideoFile({ filePath: fixturePath(name), byteLength: bytesOf(name).byteLength, ...options });

test("only H.264 is video this upload keeps, and AAC or no audio is sound it keeps", () => {
  for (const codec of ["avc1.640028", "avc3.4d401e", "AVC1.42E01E"]) assert.equal(isH264(codec), true, codec);
  for (const codec of ["hvc1.1.6.L93.B0", "av01.0.04M.08", "vp09.00.10.08", "", "unknown"]) {
    assert.equal(isH264(codec), false, codec);
  }
  for (const codec of ["mp4a.40.2", "mp4a.40.5", "mp4a.67", ""]) assert.equal(isAac(codec), true, codec);
  for (const codec of ["ac-3", "opus", "mp4a.69", "mp4a.40.34", "unknown"]) assert.equal(isAac(codec), false, codec);
});

test("a rewritten upload is named .mp4", () => {
  assert.equal(mp4Name("Holiday.MOV"), "Holiday.mp4");
  assert.equal(mp4Name("clip.mp4"), "clip.mp4");
  assert.equal(mp4Name("a.b.mov"), "a.b.mp4");
  assert.equal(mp4Name("noext"), "noext.mp4");
});

test("the index check reads the box order of the file", async () => {
  assert.equal(await indexComesFirst(fixturePath("faststart.mp4")), true);
  assert.equal(await indexComesFirst(fixturePath("index-at-end.mp4")), false);
});

test("the index check refuses garbage and empty files without throwing", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "video-prepare-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "zeros"), Buffer.alloc(64));
  await writeFile(path.join(dir, "empty"), Buffer.alloc(0));
  assert.equal(await indexComesFirst(path.join(dir, "zeros")), false);
  assert.equal(await indexComesFirst(path.join(dir, "empty")), false);
});

test("a faststart H.264 file with no audio is sent as it is and declared", async () => {
  const prepared = await prepare("faststart.mp4");
  assert.equal(prepared.remuxed, null);
  assert.match(prepared.videoCodec, /^avc[13]\./u);
  assert.equal(prepared.audioCodec, "");
});

test("a faststart H.264 and AAC file is sent as it is with its real AAC string", async () => {
  const prepared = await prepare("with-aac.mp4");
  assert.equal(prepared.remuxed, null);
  assert.equal(prepared.audioCodec, "mp4a.40.2");
});

test("an index-at-the-end H.264 and AAC file is rewritten with the index first and keeps both tracks", async () => {
  const prepared = await prepare("with-aac-index-at-end.mp4");
  assert.ok(prepared.remuxed);
  assert.equal(indexFirstIn(prepared.remuxed), true);
  assert.equal(prepared.audioCodec, "mp4a.40.2");
  assert.match(prepared.videoCodec, /^avc[13]\./u);
  // The rewritten file still holds the sound: reading it back finds the AAC track.
  const dir = await mkdtemp(path.join(os.tmpdir(), "video-prepare-"));
  try {
    await writeFile(path.join(dir, "out.mp4"), prepared.remuxed);
    const again = await prepareVideoFile({ filePath: path.join(dir, "out.mp4"), byteLength: prepared.remuxed.byteLength });
    assert.equal(again.remuxed, null);
    assert.equal(again.audioCodec, "mp4a.40.2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a MOV is rewritten as an MP4", async () => {
  const prepared = await prepare("quick.mov");
  assert.ok(prepared.remuxed);
  assert.equal(prepared.remuxed.toString("latin1", 4, 8), "ftyp");
  assert.equal(indexFirstIn(prepared.remuxed), true);
});

test("a file over the remux ceiling is described, never rewritten", async () => {
  const prepared = await prepare("index-at-end.mp4", { maxRemuxBytes: 1 });
  assert.equal(prepared.remuxed, null);
  assert.match(prepared.videoCodec, /^avc[13]\./u);
});

test("an unreadable file is declared with no codecs", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "video-prepare-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "notes.mp4"), "not a video");
  const prepared = await prepareVideoFile({ filePath: path.join(dir, "notes.mp4"), byteLength: 11 });
  assert.deepEqual(prepared, { videoCodec: "", audioCodec: "", remuxed: null });
});

/** The AAC fixture with a second, Opus audio track the server would refuse, written beside it. */
async function writeWithExtraOpusTrack(filePath) {
  const input = new Input({ source: new FilePathSource(fixturePath("with-aac.mp4")), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getPrimaryAudioTrack();
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  const videoSource = new EncodedVideoPacketSource(video.codec);
  const audioSource = new EncodedAudioPacketSource(audio.codec);
  const opusSource = new EncodedAudioPacketSource("opus");
  output.addVideoTrack(videoSource);
  output.addAudioTrack(audioSource);
  output.addAudioTrack(opusSource);
  await output.start();
  const copy = async (track, source) => {
    const decoderConfig = await track.getDecoderConfig();
    let first = true;
    for await (const packet of new EncodedPacketSink(track).packets()) {
      await source.add(packet, first ? { decoderConfig } : undefined);
      first = false;
    }
  };
  await copy(video, videoSource);
  await copy(audio, audioSource);
  const opusHead = new Uint8Array(19);
  opusHead.set(new TextEncoder().encode("OpusHead"));
  opusHead.set([1, 2], 8);
  await opusSource.add(new EncodedPacket(new Uint8Array([1, 2, 3, 4]), "key", 0, 0.02), {
    decoderConfig: { codec: "opus", numberOfChannels: 2, sampleRate: 48_000, description: opusHead },
  });
  await output.finalize();
  await writeFile(filePath, new Uint8Array(target.buffer));
  input.dispose();
}

test("a secondary track the server would refuse is dropped by the rewrite, and the primaries are declared", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "video-prepare-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "extra.mp4");
  await writeWithExtraOpusTrack(filePath);
  const byteLength = readFileSync(filePath).byteLength;

  const prepared = await prepareVideoFile({ filePath, byteLength });

  assert.ok(prepared.remuxed);
  assert.equal(prepared.audioCodec, "mp4a.40.2");
  assert.match(prepared.videoCodec, /^avc[13]\./u);
  await writeFile(path.join(dir, "out.mp4"), prepared.remuxed);
  const again = new Input({ source: new FilePathSource(path.join(dir, "out.mp4")), formats: ALL_FORMATS });
  assert.equal((await again.getAudioTracks()).length, 1);
  again.dispose();

  // Over the remux ceiling the track cannot be dropped, so the file is declared as it is.
  const described = await prepareVideoFile({ filePath, byteLength, maxRemuxBytes: 1 });
  assert.equal(described.remuxed, null);
  assert.equal(described.audioCodec, "opus");
});
