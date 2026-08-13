import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCacheAbiV1,
  buildCacheAbiV2,
  loadCacheAbi,
  loadCacheAbiV1,
  MODEL_TUPLE_BYTES,
  PROJECTOR_VERSION_V1,
  PROTOCOL_VERSION_V1,
  PROTOCOL_VERSION_V2,
  toolResultProfileForCacheAbi,
} from "../../src/lineage/cache-abi.js";
import {
  bytesEqual,
  concatBytes,
  lengthPrefix,
  sha256Hex,
  utf8Bytes,
} from "../../src/bytes/ops.js";
import {
  CANONICAL_TOOLS_BYTES,
  LEGACY_CANONICAL_TOOLS_BYTES,
  PREVIOUS_CANONICAL_TOOLS_BYTES,
} from "../../src/bytes/schemas.js";
import {
  ACTIVE_SYSTEM_MESSAGE_BYTES,
  BASE_SYSTEM_MESSAGE_BYTES,
  BASE_SYSTEM_PROMPT,
  CURRENT_SYSTEM_MESSAGE_BYTES,
  LEGACY_BASE_SYSTEM_PROMPT,
  PRECEDING_SYSTEM_MESSAGE_BYTES,
  PREVIOUS_BASE_SYSTEM_PROMPT,
  PREVIOUS_SYSTEM_MESSAGE_BYTES,
  PRIOR_BASE_SYSTEM_PROMPT,
  RC1_BASE_SYSTEM_PROMPT,
  RC2_BASE_SYSTEM_PROMPT,
  RESOLVE_BASE_SYSTEM_PROMPT,
  materializeLegacySystemMessage,
  materializePreviousSystemMessage,
  materializePriorSystemMessage,
  materializeRc1SystemMessage,
  materializeRc2SystemMessage,
  materializeResolveSystemMessage,
} from "../../src/bytes/system.js";
import { freezeBytes, type FrozenBytes } from "../../src/bytes/types.js";
import { utf8View } from "../../src/bytes/view.js";
import type { CacheAbiId } from "../../src/journal/types.js";

const DOMAIN = new TextEncoder().encode("dsh-cache-abi-v1\0");

function idFor(bytes: FrozenBytes): CacheAbiId {
  return `sha256:${sha256Hex(bytes)}` as CacheAbiId;
}

function framePayloadOffsets(bytes: FrozenBytes): readonly number[] {
  const source = bytes.copy();
  const offsets: number[] = [];
  let offset = DOMAIN.byteLength;
  for (let index = 0; index < 5; index += 1) {
    const length = Number(
      new DataView(source.buffer, source.byteOffset + offset, 8).getBigUint64(
        0,
        false,
      ),
    );
    offset += 8;
    offsets.push(offset);
    offset += length;
  }
  return Object.freeze(offsets);
}

function manifestForSystem(
  systemBlob: FrozenBytes,
  toolsBlob: FrozenBytes = LEGACY_CANONICAL_TOOLS_BYTES,
  protocol: typeof PROTOCOL_VERSION_V1 | typeof PROTOCOL_VERSION_V2 = PROTOCOL_VERSION_V1,
): FrozenBytes {
  return concatBytes([
    DOMAIN,
    lengthPrefix(utf8Bytes(protocol)),
    lengthPrefix(utf8Bytes(PROJECTOR_VERSION_V1)),
    lengthPrefix(MODEL_TUPLE_BYTES),
    lengthPrefix(systemBlob),
    lengthPrefix(toolsBlob),
  ]);
}

test("historical v1 builder remains the exact previous edit-v5 ABI", () => {
  const built = buildCacheAbiV1();
  const rebuilt = buildCacheAbiV1();
  const loaded = loadCacheAbiV1(built.manifestBytes, built.cacheAbiId);

  assert.equal(built.protocolVersion, PROTOCOL_VERSION_V1);
  assert.equal(built.projectorVersion, PROJECTOR_VERSION_V1);
  assert.equal(
    utf8View(MODEL_TUPLE_BYTES),
    '{"model":"deepseek-v4-flash","thinking":{"type":"enabled"},"reasoning_effort":"max"}',
  );
  assert.equal(bytesEqual(built.systemBlob, PREVIOUS_SYSTEM_MESSAGE_BYTES), true);
  assert.equal(bytesEqual(built.systemBlob, ACTIVE_SYSTEM_MESSAGE_BYTES), false);
  assert.equal(bytesEqual(built.toolsBlob, PREVIOUS_CANONICAL_TOOLS_BYTES), true);
  assert.equal(bytesEqual(built.toolsBlob, CANONICAL_TOOLS_BYTES), false);
  assert.equal(bytesEqual(loaded.manifestBytes, built.manifestBytes), true);
  assert.equal(loaded.cacheAbiId, built.cacheAbiId);
  assert.equal(loaded.headerHash, built.headerHash);
  assert.equal(rebuilt.cacheAbiId, built.cacheAbiId);
  assert.equal(bytesEqual(rebuilt.manifestBytes, built.manifestBytes), true);
  assert.equal(
    built.cacheAbiId,
    "sha256:cba7a5a4740adb9b57b5c87e0257d786193d270462419a3333b30b4eaa808cd3",
  );
  assert.equal(
    built.headerHash,
    "sha256:010e4f3633becf2866b770ba949d0ae4772d85e74afe72c32ce06c15c8459d71",
  );
  assert.equal(built.manifestBytes.byteLength, 2_231);
  assert.equal(buildCacheAbiV1(utf8Bytes("")).cacheAbiId, built.cacheAbiId);
  assert.equal(Object.isFrozen(built), true);

  const exposed = built.manifestBytes.copy();
  exposed[0] = exposed[0] === 0 ? 1 : 0;
  assert.equal(loadCacheAbiV1(built.manifestBytes, built.cacheAbiId).cacheAbiId, built.cacheAbiId);
});

test("protocol v2 changes only the closed protocol frame for new Sessions", () => {
  const v1 = buildCacheAbiV1();
  const v2 = buildCacheAbiV2();
  const loaded = loadCacheAbi(v2.manifestBytes, v2.cacheAbiId);

  assert.equal(v2.protocolVersion, PROTOCOL_VERSION_V2);
  assert.equal(loaded.protocolVersion, PROTOCOL_VERSION_V2);
  assert.equal(toolResultProfileForCacheAbi(v1), "verbose-v1");
  assert.equal(toolResultProfileForCacheAbi(v2), "compact-v2");
  assert.notEqual(v2.cacheAbiId, v1.cacheAbiId);
  // Pinned on purpose. This value moves only when the frozen zone moves, which
  // is the point: a new prompt or tool schema opens a new Lineage, and that has
  // to be a signed act rather than a side effect.
  assert.equal(
    v2.cacheAbiId,
    "sha256:bcb498c8ba9305b1bd57f04f7f719f08a08a25c756ec4e14cc043445bc518db2",
  );
  assert.equal(v2.projectorVersion, PROJECTOR_VERSION_V1);
  assert.equal(bytesEqual(v2.modelTupleBytes, v1.modelTupleBytes), true);
  assert.equal(bytesEqual(v2.systemBlob, ACTIVE_SYSTEM_MESSAGE_BYTES), true);
  assert.equal(bytesEqual(v2.systemBlob, v1.systemBlob), false);
  assert.equal(bytesEqual(v2.toolsBlob, v1.toolsBlob), false);
  assert.equal(bytesEqual(v2.toolsBlob, CANONICAL_TOOLS_BYTES), true);
  assert.equal(bytesEqual(v1.toolsBlob, PREVIOUS_CANONICAL_TOOLS_BYTES), true);
  assert.notEqual(v2.headerHash, v1.headerHash);
  assert.notEqual(v2.manifestBytes.byteLength, v1.manifestBytes.byteLength);
  assert.throws(
    () => loadCacheAbiV1(v2.manifestBytes, v2.cacheAbiId),
    /not canonical v1/u,
  );

  const previousV2 = manifestForSystem(
    PREVIOUS_SYSTEM_MESSAGE_BYTES,
    PREVIOUS_CANONICAL_TOOLS_BYTES,
    PROTOCOL_VERSION_V2,
  );
  assert.doesNotThrow(() => loadCacheAbi(previousV2, idFor(previousV2)));

  const searchV1V2 = manifestForSystem(
    ACTIVE_SYSTEM_MESSAGE_BYTES,
    CANONICAL_TOOLS_BYTES,
    PROTOCOL_VERSION_V2,
  );
  assert.doesNotThrow(() => loadCacheAbi(searchV1V2, idFor(searchV1V2)));

  const legacyV2 = manifestForSystem(
    CURRENT_SYSTEM_MESSAGE_BYTES,
    LEGACY_CANONICAL_TOOLS_BYTES,
    PROTOCOL_VERSION_V2,
  );
  assert.throws(
    () => loadCacheAbi(legacyV2, idFor(legacyV2)),
    /system\/tools pairing is not admitted/u,
  );

  const unknown = concatBytes([
    DOMAIN,
    lengthPrefix(utf8Bytes("dsh-protocol-v3")),
    lengthPrefix(utf8Bytes(PROJECTOR_VERSION_V1)),
    lengthPrefix(MODEL_TUPLE_BYTES),
    lengthPrefix(ACTIVE_SYSTEM_MESSAGE_BYTES),
    lengthPrefix(CANONICAL_TOOLS_BYTES),
  ]);
  assert.throws(
    () => loadCacheAbi(unknown, idFor(unknown)),
    /protocol version is not admitted/u,
  );
});

test("previous, prior, and original systems are finite load-only compatibility", () => {
  const active = buildCacheAbiV2();
  const v4Manifest = manifestForSystem(PREVIOUS_SYSTEM_MESSAGE_BYTES);
  const v4Id = idFor(v4Manifest);
  const loadedV4 = loadCacheAbiV1(v4Manifest, v4Id);
  assert.equal(
    v4Id,
    "sha256:370a676ce35f0ca7daa2480c89c5b9e9a49e7de8c964d2cfda5d25e52c05ec67",
  );
  assert.equal(
    bytesEqual(loadedV4.toolsBlob, LEGACY_CANONICAL_TOOLS_BYTES),
    true,
  );
  const priorManifest = manifestForSystem(CURRENT_SYSTEM_MESSAGE_BYTES);
  const priorId = idFor(priorManifest);
  const loadedPrior = loadCacheAbiV1(priorManifest, priorId);

  assert.equal(PRIOR_BASE_SYSTEM_PROMPT.endsWith("that edit."), true);
  assert.equal(bytesEqual(loadedPrior.systemBlob, CURRENT_SYSTEM_MESSAGE_BYTES), true);
  assert.equal(
    priorId,
    "sha256:5f35a586f7b39e476c2fe59b8085c588d4f863f8eacb0e6393e21cb1d74a7d86",
  );
  assert.equal(
    loadedPrior.headerHash,
    "sha256:5f9cfba68467db747afdb537dc7df3eced41cae67da5471a77b8891f257368a7",
  );

  const originalManifest = manifestForSystem(BASE_SYSTEM_MESSAGE_BYTES);
  const originalId = idFor(originalManifest);
  const loadedOriginal = loadCacheAbiV1(originalManifest, originalId);
  assert.equal(LEGACY_BASE_SYSTEM_PROMPT.endsWith("occurred."), true);
  assert.equal(bytesEqual(loadedOriginal.systemBlob, BASE_SYSTEM_MESSAGE_BYTES), true);
  assert.equal(
    originalId,
    "sha256:3813964e24ba27d336a87eb35e08c01091c887665e673acbe6b9bb4d3d464533",
  );
  assert.equal(
    loadedOriginal.headerHash,
    "sha256:33a24d401390430f87efef9f9136c8200ec6998ad53266ec85102349f8de2ef1",
  );
  assert.notEqual(active.cacheAbiId, priorId);
  assert.notEqual(active.cacheAbiId, v4Id);
  assert.notEqual(active.cacheAbiId, originalId);
  assert.notEqual(priorId, originalId);

  assert.equal(PREVIOUS_BASE_SYSTEM_PROMPT.endsWith("adjacent code."), true);
  assert.equal(
    bytesEqual(buildCacheAbiV1().systemBlob, PREVIOUS_SYSTEM_MESSAGE_BYTES),
    true,
  );

  const instructions = utf8Bytes("closed replay instructions");
  for (const historicalSystem of [
    materializePreviousSystemMessage(instructions),
    materializePriorSystemMessage(instructions),
    materializeLegacySystemMessage(instructions),
  ]) {
    const historicalManifest = manifestForSystem(historicalSystem);
    const loadedProject = loadCacheAbiV1(
      historicalManifest,
      idFor(historicalManifest),
    );
    assert.equal(bytesEqual(loadedProject.systemBlob, historicalSystem), true);
    const isPrevious = bytesEqual(
      historicalSystem,
      materializePreviousSystemMessage(instructions),
    );
    assert.equal(
      bytesEqual(buildCacheAbiV1(instructions).systemBlob, historicalSystem),
      isPrevious,
    );
  }

  const unknownSystem = utf8Bytes(
    '{"role":"system","content":"unknown fifth prompt"}',
  );
  const unknownManifest = manifestForSystem(unknownSystem);
  assert.throws(
    () => loadCacheAbiV1(unknownManifest, idFor(unknownManifest)),
    /does not round-trip canonically/u,
  );
});

test("Unicode project instructions deterministically create a distinct Cache ABI", () => {
  const projectInstructions = utf8Bytes("规则🙂\ne\u0301 与 中\n不要改写历史");
  const first = buildCacheAbiV1(projectInstructions);
  const second = buildCacheAbiV1(projectInstructions);
  const base = buildCacheAbiV1();

  assert.equal(first.cacheAbiId, second.cacheAbiId);
  assert.equal(first.headerHash, second.headerHash);
  assert.equal(bytesEqual(first.manifestBytes, second.manifestBytes), true);
  assert.notEqual(first.cacheAbiId, base.cacheAbiId);
  assert.notEqual(first.headerHash, base.headerHash);
  assert.equal(
    first.cacheAbiId,
    "sha256:69b38fc0cbaffbc39b75115b11f127b3382ed2e1a1f0c9e2d804e2cdc04f54ad",
  );
  assert.match(utf8View(first.systemBlob), /规则🙂\\né 与 中/u);
  assert.equal(
    loadCacheAbiV1(first.manifestBytes, first.cacheAbiId).cacheAbiId,
    first.cacheAbiId,
  );
});

test("Cache ABI loader admits only the closed compatibility matrix", () => {
  const acceptedV1 = [
    manifestForSystem(PREVIOUS_SYSTEM_MESSAGE_BYTES, CANONICAL_TOOLS_BYTES),
    manifestForSystem(PREVIOUS_SYSTEM_MESSAGE_BYTES, PREVIOUS_CANONICAL_TOOLS_BYTES),
    manifestForSystem(PREVIOUS_SYSTEM_MESSAGE_BYTES),
    manifestForSystem(CURRENT_SYSTEM_MESSAGE_BYTES),
    manifestForSystem(BASE_SYSTEM_MESSAGE_BYTES),
  ];
  for (const manifest of acceptedV1) {
    assert.doesNotThrow(() => loadCacheAbiV1(manifest, idFor(manifest)));
  }
  const acceptedV2 = [
    manifestForSystem(ACTIVE_SYSTEM_MESSAGE_BYTES, CANONICAL_TOOLS_BYTES, PROTOCOL_VERSION_V2),
    manifestForSystem(PREVIOUS_SYSTEM_MESSAGE_BYTES, CANONICAL_TOOLS_BYTES, PROTOCOL_VERSION_V2),
    manifestForSystem(PREVIOUS_SYSTEM_MESSAGE_BYTES, PREVIOUS_CANONICAL_TOOLS_BYTES, PROTOCOL_VERSION_V2),
    manifestForSystem(PRECEDING_SYSTEM_MESSAGE_BYTES, PREVIOUS_CANONICAL_TOOLS_BYTES, PROTOCOL_VERSION_V2),
  ];
  for (const manifest of acceptedV2) {
    assert.doesNotThrow(() => loadCacheAbi(manifest, idFor(manifest)));
  }

  const rejectedV1 = [
    manifestForSystem(ACTIVE_SYSTEM_MESSAGE_BYTES, CANONICAL_TOOLS_BYTES),
    manifestForSystem(ACTIVE_SYSTEM_MESSAGE_BYTES),
    manifestForSystem(CURRENT_SYSTEM_MESSAGE_BYTES, CANONICAL_TOOLS_BYTES),
    manifestForSystem(BASE_SYSTEM_MESSAGE_BYTES, CANONICAL_TOOLS_BYTES),
  ];
  for (const rejected of rejectedV1) {
    assert.throws(
      () => loadCacheAbiV1(rejected, idFor(rejected)),
      /system\/tools pairing is not admitted/u,
    );
  }
  const rejectedV2 = [
    manifestForSystem(ACTIVE_SYSTEM_MESSAGE_BYTES, LEGACY_CANONICAL_TOOLS_BYTES, PROTOCOL_VERSION_V2),
    manifestForSystem(PRECEDING_SYSTEM_MESSAGE_BYTES, CANONICAL_TOOLS_BYTES, PROTOCOL_VERSION_V2),
    manifestForSystem(CURRENT_SYSTEM_MESSAGE_BYTES, CANONICAL_TOOLS_BYTES, PROTOCOL_VERSION_V2),
    manifestForSystem(CURRENT_SYSTEM_MESSAGE_BYTES, LEGACY_CANONICAL_TOOLS_BYTES, PROTOCOL_VERSION_V2),
    manifestForSystem(BASE_SYSTEM_MESSAGE_BYTES, CANONICAL_TOOLS_BYTES, PROTOCOL_VERSION_V2),
  ];
  for (const rejected of rejectedV2) {
    assert.throws(
      () => loadCacheAbi(rejected, idFor(rejected)),
      /system\/tools pairing is not admitted/u,
    );
  }
  const unknownTools = manifestForSystem(
    PREVIOUS_SYSTEM_MESSAGE_BYTES,
    utf8Bytes("[]"),
  );
  assert.throws(
    () => loadCacheAbiV1(unknownTools, idFor(unknownTools)),
    /tools blob is not an admitted closed ABI/u,
  );
});

test("Cache ABI mutation rejects hash-valid non-canonical system JSON", () => {
  const nonCanonicalSystem = utf8Bytes(
    `{"role":"system", "content":${JSON.stringify(BASE_SYSTEM_PROMPT)}}`,
  );
  const bytes = concatBytes([
    DOMAIN,
    lengthPrefix(utf8Bytes(PROTOCOL_VERSION_V1)),
    lengthPrefix(utf8Bytes(PROJECTOR_VERSION_V1)),
    lengthPrefix(MODEL_TUPLE_BYTES),
    lengthPrefix(nonCanonicalSystem),
    lengthPrefix(CANONICAL_TOOLS_BYTES),
  ]);

  assert.throws(
    () => loadCacheAbiV1(bytes, idFor(bytes)),
    /does not round-trip canonically/u,
  );
});

test("Cache ABI mutation rejects hash-valid non-canonical domain and fields", () => {
  const built = buildCacheAbiV1();
  const offsets = framePayloadOffsets(built.manifestBytes);
  for (const [label, offset] of [
    ["protocol", offsets[0]],
    ["projector", offsets[1]],
    ["model", offsets[2]],
    ["system", offsets[3]],
    ["tools", offsets[4]],
  ] as const) {
    assert.notEqual(offset, undefined);
    const mutated = built.manifestBytes.copy();
    const concreteOffset = offset as number;
    mutated[concreteOffset] = (mutated[concreteOffset] ?? 0) ^ 1;
    const bytes = freezeBytes(mutated);
    assert.throws(() => loadCacheAbiV1(bytes, idFor(bytes)), TypeError, label);
  }

  const wrongDomain = built.manifestBytes.copy();
  wrongDomain[0] = (wrongDomain[0] ?? 0) ^ 1;
  const wrongDomainBytes = freezeBytes(wrongDomain);
  assert.throws(
    () => loadCacheAbiV1(wrongDomainBytes, idFor(wrongDomainBytes)),
    /wrong domain/u,
  );
});

test("Cache ABI loader rejects identity mismatch, every truncation, and trailing bytes", () => {
  const built = buildCacheAbiV1();
  assert.throws(
    () =>
      loadCacheAbiV1(
        built.manifestBytes,
        `sha256:${"0".repeat(64)}` as CacheAbiId,
      ),
    /hash does not match/u,
  );

  const source = built.manifestBytes.copy();
  for (let byteLength = 0; byteLength < source.byteLength; byteLength += 1) {
    const truncated = freezeBytes(source.slice(0, byteLength));
    assert.throws(
      () => loadCacheAbiV1(truncated, idFor(truncated)),
      TypeError,
      `truncation at ${byteLength}`,
    );
  }

  const trailing = concatBytes([built.manifestBytes, new Uint8Array([0])]);
  assert.throws(
    () => loadCacheAbiV1(trailing, idFor(trailing)),
    /trailing bytes/u,
  );
});

test("Cache ABI loader rejects unsafe u64 lengths before allocation", () => {
  const built = buildCacheAbiV1();
  const unsafe = built.manifestBytes.copy();
  unsafe.fill(0xff, DOMAIN.byteLength, DOMAIN.byteLength + 8);
  const bytes = freezeBytes(unsafe);
  assert.throws(() => loadCacheAbiV1(bytes, idFor(bytes)), /length is unsafe/u);
});

test("Cache ABI builder and loader reject invalid UTF-8 system instructions", () => {
  assert.throws(
    () => buildCacheAbiV1(freezeBytes(new Uint8Array([0xff]))),
    TypeError,
  );
});

test("a Lineage opened under the retired one-paragraph prompt still loads", () => {
  // Replacing the canonical prompt opens a new Lineage for new Sessions. It
  // must not orphan the Sessions already running on the old one: their bytes
  // are durable and they keep sending exactly what they were opened with.
  assert.equal(RESOLVE_BASE_SYSTEM_PROMPT.endsWith("final response."), true);
  assert.notEqual(BASE_SYSTEM_PROMPT, RESOLVE_BASE_SYSTEM_PROMPT);

  const retired = manifestForSystem(
    materializeResolveSystemMessage(),
    CANONICAL_TOOLS_BYTES,
    PROTOCOL_VERSION_V2,
  );
  const retiredId = idFor(retired);
  const loaded = loadCacheAbi(retired, retiredId);
  assert.equal(
    bytesEqual(loaded.systemBlob, materializeResolveSystemMessage()),
    true,
  );
  assert.notEqual(retiredId, buildCacheAbiV2().cacheAbiId);

  // Project instructions ride in the same blob, so that shape has to load too.
  const withInstructions = manifestForSystem(
    materializeResolveSystemMessage(utf8Bytes("project rules")),
    CANONICAL_TOOLS_BYTES,
    PROTOCOL_VERSION_V2,
  );
  assert.doesNotThrow(() =>
    loadCacheAbi(withInstructions, idFor(withInstructions)),
  );
});

test("every released prompt still loads under the current one", () => {
  // Every frozen prompt has to keep round-tripping forever: a session created
  // by an older binary carries its system blob in the manifest, and losing the
  // profile turns that session into "no such session".
  for (const materialize of [
    materializeRc1SystemMessage,
    materializeRc2SystemMessage,
  ]) {
    const manifest = manifestForSystem(
      materialize(),
      CANONICAL_TOOLS_BYTES,
      PROTOCOL_VERSION_V2,
    );
    assert.doesNotThrow(() => loadCacheAbi(manifest, idFor(manifest)));
  }
  // What each frozen profile exists for: rc.1 predates batched searches, rc.2
  // is the last one that called the agent SimpleDSH.
  assert.match(RC1_BASE_SYSTEM_PROMPT, /Independent reads issued/u);
  assert.match(RC2_BASE_SYSTEM_PROMPT, /Independent reads and web_searches/u);
  assert.match(RC2_BASE_SYSTEM_PROMPT, /You are SimpleDSH/u);
  assert.match(BASE_SYSTEM_PROMPT, /You are FlashCoder/u);
  assert.notEqual(RC2_BASE_SYSTEM_PROMPT, BASE_SYSTEM_PROMPT);
});
