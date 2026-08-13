import { concatBytes, joinBytes, lengthPrefix, sha256Hex, utf8Bytes } from "./ops.js";
import { CANONICAL_TOOLS_BYTES } from "./schemas.js";
import { ACTIVE_SYSTEM_MESSAGE_BYTES } from "./system.js";
import type { FrozenBytes } from "./types.js";

export const DEEPSEEK_MODEL = "deepseek-v4-flash";
export const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";

/**
 * Flash maps requested effort to three actual levels: low, high, and max
 * (xhigh is documented to collapse into high). Values outside this set are
 * silently ignored by the API, so the closed set is enforced here instead.
 */
export const REASONING_EFFORTS = Object.freeze(["low", "high", "max"] as const);
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "max";

export function assertReasoningEffort(value: string): ReasoningEffort {
  if (!(REASONING_EFFORTS as readonly string[]).includes(value)) {
    throw new TypeError(
      `reasoning_effort must be one of ${REASONING_EFFORTS.join("|")}`,
    );
  }
  return value as ReasoningEffort;
}

const REQUEST_PREFIX = utf8Bytes(
  '{"model":"deepseek-v4-flash","messages":[',
);
const REQUEST_SUFFIX_PREFIX = utf8Bytes('],"tools":');
// The effort sits inside the frozen suffix, so each level has its own byte
// string and therefore its own Cache ABI. Built once per level, never joined
// from parts at request time.
const REQUEST_SUFFIX_BY_EFFORT: Readonly<Record<ReasoningEffort, FrozenBytes>> =
  Object.freeze(
    Object.fromEntries(
      REASONING_EFFORTS.map((effort) => [
        effort,
        utf8Bytes(
          ',"stream":true,"stream_options":{"include_usage":true},"thinking":{"type":"enabled"},"reasoning_effort":"' +
            effort +
            '","max_tokens":65536}',
        ),
      ]),
    ) as Record<ReasoningEffort, FrozenBytes>,
  );
const COMMA = utf8Bytes(",");

export interface DeepSeekRequestSnapshot {
  readonly body: FrozenBytes;
  readonly bodySha256: string;
  readonly byteCount: number;
}

function snapshotFromBody(body: FrozenBytes): DeepSeekRequestSnapshot {
  return Object.freeze({
    body,
    bodySha256: sha256Hex(body),
    byteCount: body.byteLength,
  });
}

export function buildDeepSeekRequestSnapshot(
  messages: readonly FrozenBytes[],
  effort: ReasoningEffort = DEFAULT_REASONING_EFFORT,
): DeepSeekRequestSnapshot {
  return buildDeepSeekRequestSnapshotWithTools(
    messages,
    CANONICAL_TOOLS_BYTES,
    effort,
  );
}

export function buildDeepSeekRequestSnapshotWithTools(
  messages: readonly FrozenBytes[],
  tools: FrozenBytes,
  effort: ReasoningEffort = DEFAULT_REASONING_EFFORT,
): DeepSeekRequestSnapshot {
  if (messages.length === 0) {
    throw new TypeError("at least one frozen message is required");
  }
  const suffix = REQUEST_SUFFIX_BY_EFFORT[assertReasoningEffort(effort)];
  if (suffix === undefined) throw new TypeError("unknown reasoning effort");

  const body = concatBytes([
    REQUEST_PREFIX,
    joinBytes(messages, COMMA),
    REQUEST_SUFFIX_PREFIX,
    tools,
    suffix,
  ]);
  return snapshotFromBody(body);
}

export function restoreDeepSeekRequestSnapshot(
  body: FrozenBytes,
  expected: { readonly bodySha256: string; readonly byteCount: number },
): DeepSeekRequestSnapshot {
  const restored = snapshotFromBody(body);
  if (
    restored.bodySha256 !== expected.bodySha256 ||
    restored.byteCount !== expected.byteCount
  ) {
    throw new TypeError("durable DeepSeek request snapshot integrity mismatch");
  }
  return restored;
}

export const BASE_FROZEN_ZONE_BYTES = concatBytes([
  lengthPrefix(ACTIVE_SYSTEM_MESSAGE_BYTES),
  lengthPrefix(CANONICAL_TOOLS_BYTES),
]);

// Changing this value is an explicit Cache ABI change and requires review.
export const BASE_FROZEN_ZONE_SHA256 =
  "148c4336ddc24556aef2462e650040949690b1e66f35e7ebadfc9e75aa68c25b";

// Request containing only the canonical base system message.
export const BASE_REQUEST_GOLDEN_SHA256 =
  "24c30715c9dad33736b46116316f7d59df575c14e1c16289bc7fb0ca3b2161e5";
