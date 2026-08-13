import { bytesEqual, utf8Bytes } from "./ops.js";
import type { FrozenBytes } from "./types.js";

// This literal is provider-visible Cache ABI. Keep tool names sorted and never
// regenerate it from objects or a schema library.
const CANONICAL_TOOLS_JSON =
  '[{"type":"function","function":{"name":"bash","description":"Run one shell command in the workspace.","parameters":{"type":"object","properties":{"command":{"type":"string"},"timeout":{"type":"number","exclusiveMinimum":0}},"required":["command"],"additionalProperties":false}}},{"type":"function","function":{"name":"edit","description":"Replace old_string using exact UTF-8 byte matching, left-to-right and non-overlapping. Omit replace_all or set it to false to require exactly one match; set it to true to replace all matches. Zero matches fail with edit_no_match and matchCount 0; multiple matches with replace_all false fail with edit_not_unique and their matchCount.","parameters":{"type":"object","properties":{"path":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"},"replace_all":{"type":"boolean"}},"required":["path","old_string","new_string"],"additionalProperties":false}}},{"type":"function","function":{"name":"read","description":"Read a file with line numbers. Reads the whole file unless offset and limit name a slice; offset is the zero-based first line. A result too large to send whole comes back as a head and a tail with truncated true and an artifact_ref holding every byte, which read accepts as a path to take exact ranges from. next_offset is the line to continue from when the slice stopped before the end of the file, and null when it did not.","parameters":{"type":"object","properties":{"path":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1}},"required":["path"],"additionalProperties":false}}},{"type":"function","function":{"name":"web_search","description":"Search the live web for current facts or recent events the workspace cannot verify. Returns a concise search-grounded answer from DeepSeek official web search.","parameters":{"type":"object","properties":{"search_query":{"type":"string"},"search_locale":{"type":"string"}},"required":["search_query"],"additionalProperties":false}}},{"type":"function","function":{"name":"write","description":"Write complete content to a file. Keep content under roughly 8KB of raw text; CJK and multibyte characters count about six times their byte size once JSON-escaped. For larger content or several files at once, use bash instead (cat with a quoted heredoc), which has no size limit.","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"],"additionalProperties":false}}}]';

// Frozen load-only compatibility for the search-v1 ABI, the last one whose
// read tool said only "a bounded file slice". Never reinterpret or regenerate
// these bytes after the active tools ABI changes.
const SEARCH_V1_CANONICAL_TOOLS_JSON =
  '[{"type":"function","function":{"name":"bash","description":"Run one shell command in the workspace.","parameters":{"type":"object","properties":{"command":{"type":"string"},"timeout":{"type":"number","exclusiveMinimum":0}},"required":["command"],"additionalProperties":false}}},{"type":"function","function":{"name":"edit","description":"Replace old_string using exact UTF-8 byte matching, left-to-right and non-overlapping. Omit replace_all or set it to false to require exactly one match; set it to true to replace all matches. Zero matches fail with edit_no_match and matchCount 0; multiple matches with replace_all false fail with edit_not_unique and their matchCount.","parameters":{"type":"object","properties":{"path":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"},"replace_all":{"type":"boolean"}},"required":["path","old_string","new_string"],"additionalProperties":false}}},{"type":"function","function":{"name":"read","description":"Read a bounded file slice with line numbers.","parameters":{"type":"object","properties":{"path":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1}},"required":["path"],"additionalProperties":false}}},{"type":"function","function":{"name":"web_search","description":"Search the live web for current facts or recent events the workspace cannot verify. Returns a concise search-grounded answer from DeepSeek official web search.","parameters":{"type":"object","properties":{"search_query":{"type":"string"},"search_locale":{"type":"string"}},"required":["search_query"],"additionalProperties":false}}},{"type":"function","function":{"name":"write","description":"Write complete content to a file.","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"],"additionalProperties":false}}}]';

// Frozen load-only compatibility for the previous edit-v5 ABI. Never
// reinterpret or regenerate these bytes after the active tools ABI changes.
const PREVIOUS_CANONICAL_TOOLS_JSON =
  '[{"type":"function","function":{"name":"bash","description":"Run one shell command in the workspace.","parameters":{"type":"object","properties":{"command":{"type":"string"},"timeout":{"type":"number","exclusiveMinimum":0}},"required":["command"],"additionalProperties":false}}},{"type":"function","function":{"name":"edit","description":"Replace old_string using exact UTF-8 byte matching, left-to-right and non-overlapping. Omit replace_all or set it to false to require exactly one match; set it to true to replace all matches. Zero matches fail with edit_no_match and matchCount 0; multiple matches with replace_all false fail with edit_not_unique and their matchCount.","parameters":{"type":"object","properties":{"path":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"},"replace_all":{"type":"boolean"}},"required":["path","old_string","new_string"],"additionalProperties":false}}},{"type":"function","function":{"name":"read","description":"Read a bounded file slice with line numbers.","parameters":{"type":"object","properties":{"path":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1}},"required":["path"],"additionalProperties":false}}},{"type":"function","function":{"name":"write","description":"Write complete content to a file.","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"],"additionalProperties":false}}}]';

// Frozen load-only compatibility for v4 -> v1 Journals and Snapshots. Never
// reinterpret or regenerate these bytes after the active edit ABI changes.
const LEGACY_CANONICAL_TOOLS_JSON =
  '[{"type":"function","function":{"name":"bash","description":"Run one shell command in the workspace.","parameters":{"type":"object","properties":{"command":{"type":"string"},"timeout":{"type":"number","exclusiveMinimum":0}},"required":["command"],"additionalProperties":false}}},{"type":"function","function":{"name":"edit","description":"Replace exact text in a file.","parameters":{"type":"object","properties":{"path":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"},"replace_all":{"type":"boolean"}},"required":["path","old_string","new_string","replace_all"],"additionalProperties":false}}},{"type":"function","function":{"name":"read","description":"Read a bounded file slice with line numbers.","parameters":{"type":"object","properties":{"path":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1}},"required":["path"],"additionalProperties":false}}},{"type":"function","function":{"name":"write","description":"Write complete content to a file.","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"],"additionalProperties":false}}}]';

export const CANONICAL_TOOLS_BYTES = utf8Bytes(CANONICAL_TOOLS_JSON);
export const SEARCH_V1_CANONICAL_TOOLS_BYTES = utf8Bytes(
  SEARCH_V1_CANONICAL_TOOLS_JSON,
);
export const PREVIOUS_CANONICAL_TOOLS_BYTES = utf8Bytes(
  PREVIOUS_CANONICAL_TOOLS_JSON,
);
export const LEGACY_CANONICAL_TOOLS_BYTES = utf8Bytes(
  LEGACY_CANONICAL_TOOLS_JSON,
);

export type ToolSchemaProfile =
  | "read-v2"
  | "search-v1"
  | "edit-v5"
  | "edit-v4";

export function toolSchemaProfileForBytes(
  bytes: FrozenBytes,
): ToolSchemaProfile {
  if (bytesEqual(bytes, CANONICAL_TOOLS_BYTES)) return "read-v2";
  if (bytesEqual(bytes, SEARCH_V1_CANONICAL_TOOLS_BYTES)) return "search-v1";
  if (bytesEqual(bytes, PREVIOUS_CANONICAL_TOOLS_BYTES)) return "edit-v5";
  if (bytesEqual(bytes, LEGACY_CANONICAL_TOOLS_BYTES)) return "edit-v4";
  throw new TypeError("tools blob is not an admitted closed ABI");
}

/**
 * Profiles whose edit ABI carries the active match-count semantics. The
 * read-v2 and search-v1 profiles kept the edit-v5 edit tool bytes
 * unchanged; only the
 * legacy edit-v4 ABI predates the active edit-match behavior.
 */
export function activeEditProfile(profile: ToolSchemaProfile): boolean {
  return (
    profile === "read-v2" ||
    profile === "search-v1" ||
    profile === "edit-v5"
  );
}
