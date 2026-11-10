// OpenAI tool schemas — explicit strict mode with optional → nullable.
//
// Root cause of "every optional MCP argument arrives as '' / 0 / null"
// (prod QA 2026-11-09, gpt-6.1-sol on the Responses API): we sent function
// tools with `strict` omitted, and the Responses API then applies strict
// validation on its own ("If omitted, Responses attempts to use strict
// validation when the schema is compatible"). Strict mode has no notion of
// an optional property — every property is required — so the model fills
// the ones it meant to skip with placeholder values, and Linear / Slack
// reject the call (invalid enum, invalid ID).
//
// Fix, on the tool definitions we send to the Responses API:
//   1. Convert each schema to OpenAI's strict dialect OURSELVES, encoding
//      "optional" the documented way: the property is listed in
//      `required` but its type also admits null. The model now has an
//      explicit way to say "not provided" — null — instead of inventing
//      a value, and we send `strict: true`.
//   2. In that tool's input validation, drop nulls for properties that
//      were optional in the ORIGINAL schema and never allowed null — on a
//      strict tool, null can only mean "omitted". The tool, the persisted
//      tool_use event, and an approved re-run all see the cleaned call.
//      Only strict tools are stripped: anywhere else (other providers,
//      strict:false tools, call_mcp_tool's free-form arguments) a null is
//      the model's own choice and is passed through.
//   3. Schemas we can't express in strict mode go out with an explicit
//      `strict: false`: OpenAI then never forces optionals, so the model
//      may simply omit them — the original bug can't recur on that path.
//      That makes the fallback the conservative choice whenever in doubt
//      (a wrong strict:true is a 400 on every turn, or silently closes an
//      open object): free-form or implicitly-open nested objects, unions
//      of objects, $ref, `pattern`, keywords outside OpenAI's strict
//      subset, enum/size limits, optional properties that already accept
//      null.
//
// Values are never rewritten other than dropping those nulls (and "" for
// an optional enum/format/minLength field where "" can't be valid): a 0
// or false the model sends is passed through, since it may be meant.

import { asSchema, jsonSchema, type ToolSet } from "ai";

type JsonSchema = Record<string, unknown>;

const isObj = (v: unknown): v is JsonSchema => !!v && typeof v === "object" && !Array.isArray(v);

function typesOf(s: JsonSchema): string[] {
  const t = s.type;
  return typeof t === "string" ? [t] : Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [];
}

/** Does the schema (as written by the server) accept a JSON null? */
export function schemaAllowsNull(s: unknown): boolean {
  if (!isObj(s)) return true; // `true` / {} / missing → anything goes
  if (Object.keys(s).length === 0) return true;
  if (typesOf(s).includes("null")) return true;
  if (s.nullable === true) return true;
  if (s.const === null) return true;
  if (Array.isArray(s.enum) && s.enum.includes(null)) return true;
  for (const k of ["anyOf", "oneOf"] as const) {
    const branches = s[k];
    if (Array.isArray(branches) && branches.some(schemaAllowsNull)) return true;
  }
  // No type constraint at all (e.g. just a description) → null is valid.
  if (!("type" in s) && !("enum" in s) && !("const" in s) && !("anyOf" in s) && !("oneOf" in s) && !("allOf" in s)) {
    return true;
  }
  return false;
}

/** "" can't satisfy this (optional) string field, so it's a placeholder. */
function emptyStringInvalid(s: JsonSchema): boolean {
  if (Array.isArray(s.enum)) return !s.enum.includes("");
  if ("const" in s) return s.const !== "";
  if (typeof s.minLength === "number" && s.minLength >= 1) return true;
  if (typeof s.format === "string") return true;
  return false;
}

/** The one object-shaped branch of `s` (itself, or a lone non-null anyOf/oneOf branch). */
function objectShape(s: unknown): JsonSchema | null {
  if (!isObj(s)) return null;
  if (isObj(s.properties)) return s;
  for (const k of ["anyOf", "oneOf"] as const) {
    const branches = s[k];
    if (!Array.isArray(branches)) continue;
    const nonNull = branches.filter((b) => !(isObj(b) && typesOf(b).length === 1 && typesOf(b)[0] === "null"));
    if (nonNull.length === 1) return objectShape(nonNull[0]);
  }
  return null;
}

function itemsShape(s: unknown): unknown {
  if (!isObj(s)) return undefined;
  if (s.items !== undefined) return s.items;
  for (const k of ["anyOf", "oneOf"] as const) {
    const branches = s[k];
    if (!Array.isArray(branches)) continue;
    const arrays = branches.filter((b) => isObj(b) && b.items !== undefined);
    if (arrays.length === 1) return (arrays[0] as JsonSchema).items;
  }
  return undefined;
}

/**
 * Drop placeholder values for properties that were OPTIONAL in `schema`:
 * null when the property doesn't accept null, and "" when the property
 * can't accept "". Recurses into nested objects and arrays of objects.
 * Required properties and every other value (incl. 0 / false) are kept.
 * Returns a new value; never mutates the input.
 */
export function stripNullOptionals(schema: unknown, value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = itemsShape(schema);
    return items === undefined ? value : value.map((v) => stripNullOptionals(items, v));
  }
  if (!isObj(value)) return value;
  const shape = objectShape(schema);
  if (!shape) return value;
  const props = shape.properties as Record<string, unknown>;
  const required = new Set(Array.isArray(shape.required) ? (shape.required as string[]) : []);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const prop = props[key];
    if (prop === undefined) {
      out[key] = v;
      continue;
    }
    if (!required.has(key) && isObj(prop)) {
      if (v === null && !schemaAllowsNull(prop)) continue;
      if (v === "" && emptyStringInvalid(prop)) continue;
    }
    out[key] = stripNullOptionals(prop, v);
  }
  return out;
}

// ── Strict conversion ───────────────────────────────────────────────────

/** Keywords OpenAI's strict mode accepts (structured-outputs subset). */
const STRICT_KEYWORDS = new Set([
  "type", "properties", "required", "items", "enum", "const", "anyOf",
  "additionalProperties", "description",
  "format",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minItems", "maxItems",
]);
/** Annotations safe to drop. */
const DROP_KEYWORDS = new Set(["$schema", "examples", "$comment", "title"]);
const STRICT_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "ipv4", "ipv6", "uuid"]);
const STRICT_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
// OpenAI strict-mode limits (structured outputs): nesting, property count,
// total enum values, enum string size for large enums, total string size.
const MAX_DEPTH = 10;
const MAX_PROPERTIES = 5000;
const MAX_ENUM_VALUES = 1000;
const LARGE_ENUM = 250;
const MAX_LARGE_ENUM_CHARS = 15_000;
const MAX_TOTAL_CHARS = 120_000;

class NotStrict extends Error {}

function makeNullable(node: JsonSchema): JsonSchema {
  if (Array.isArray(node.anyOf)) {
    return { ...node, anyOf: [...node.anyOf, { type: "null" }] };
  }
  const types = typesOf(node);
  // enum/const can't share a type list with null without also listing null
  // as a value; objects/arrays use the anyOf form OpenAI documents for
  // nullable nested schemas. Plain scalars take a type list.
  if ("const" in node || Array.isArray(node.enum) || types.includes("object") || types.includes("array")) {
    const { description, ...rest } = node;
    return { anyOf: [rest, { type: "null" }], ...(description !== undefined ? { description } : {}) };
  }
  return { ...node, type: [...types, "null"] };
}

interface Budget {
  props: number;
  enumValues: number;
  chars: number;
}

function convert(node: unknown, depth: number, counter: Budget, root = false): JsonSchema {
  if (!isObj(node)) throw new NotStrict("non-object schema");
  if (depth > MAX_DEPTH) throw new NotStrict("too deep");
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(node)) {
    if (DROP_KEYWORDS.has(k)) continue;
    if (!STRICT_KEYWORDS.has(k)) throw new NotStrict(`keyword ${k}`);
    out[k] = v;
  }
  const types = typesOf(out);
  if (!("type" in out) && !Array.isArray(out.anyOf)) throw new NotStrict("untyped schema");
  // A sibling `type` would keep ruling out the null branch makeNullable adds.
  if ("type" in out && Array.isArray(out.anyOf)) throw new NotStrict("type beside anyOf");
  if (Array.isArray(out.enum) || "const" in out) {
    const values = Array.isArray(out.enum) ? out.enum : [out.const];
    counter.enumValues += values.length;
    const chars = values.reduce<number>((n, v) => n + String(v).length, 0);
    counter.chars += chars;
    if (counter.enumValues > MAX_ENUM_VALUES) throw new NotStrict("too many enum values");
    if (values.length > LARGE_ENUM && chars > MAX_LARGE_ENUM_CHARS) throw new NotStrict("large enum");
  }
  if ("type" in out && (types.length === 0 || types.some((t) => !STRICT_TYPES.has(t)))) throw new NotStrict("type");
  if (typeof out.format === "string" && !STRICT_FORMATS.has(out.format)) throw new NotStrict("format");
  if (Array.isArray(out.anyOf)) {
    // Unions of objects: which branch a value took is ambiguous, so its
    // placeholder nulls couldn't be stripped reliably.
    if (out.anyOf.some((b) => isObj(b) && (typesOf(b).includes("object") || "properties" in b))) {
      throw new NotStrict("union of objects");
    }
    out.anyOf = out.anyOf.map((b) => convert(b, depth + 1, counter));
  }
  if (types.includes("array") || "items" in out) {
    if (!isObj(out.items)) throw new NotStrict("array without items schema");
    out.items = convert(out.items, depth + 1, counter);
  }
  if (types.includes("object") || "properties" in out) {
    if (!isObj(out.properties)) throw new NotStrict("free-form object");
    if (out.additionalProperties !== undefined && out.additionalProperties !== false) {
      throw new NotStrict("additionalProperties");
    }
    // A nested object without additionalProperties:false accepts extra keys;
    // closing it would silently drop them. (Root extras aren't arguments.)
    if (!root && out.additionalProperties !== false) throw new NotStrict("open nested object");
    const required = new Set(Array.isArray(out.required) ? (out.required as string[]) : []);
    const props: JsonSchema = {};
    for (const [key, prop] of Object.entries(out.properties)) {
      if (++counter.props > MAX_PROPERTIES) throw new NotStrict("too many properties");
      counter.chars += key.length;
      if (counter.chars > MAX_TOTAL_CHARS) throw new NotStrict("schema too large");
      let converted = convert(prop, depth + 1, counter);
      if (!required.has(key)) {
        // null must unambiguously mean "omitted" — a field that already
        // accepts null (e.g. "set to null to unassign") can't be encoded.
        if (schemaAllowsNull(prop)) throw new NotStrict(`optional nullable ${key}`);
        converted = makeNullable(converted);
      }
      props[key] = converted;
    }
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  } else if (out.additionalProperties !== undefined) {
    throw new NotStrict("additionalProperties on non-object");
  }
  return out;
}

/**
 * OpenAI strict-mode version of `schema` (all properties required,
 * optionals nullable, additionalProperties:false everywhere), or null when
 * the schema can't be expressed in strict mode.
 */
export function toOpenAiStrictSchema(schema: unknown): JsonSchema | null {
  if (!isObj(schema)) return null;
  const types = typesOf(schema);
  if (!(types.length === 1 && types[0] === "object") && !(types.length === 0 && isObj(schema.properties))) return null;
  // Strict mode requires a plain object root.
  if ("anyOf" in schema || "oneOf" in schema || "allOf" in schema) return null;
  try {
    const out = convert({ type: "object", ...schema }, 0, { props: 0, enumValues: 0, chars: 0 }, true);
    out.type = "object";
    return out;
  } catch (err) {
    if (err instanceof NotStrict) return null;
    throw err;
  }
}

/**
 * Rewrite a tool dict for the OpenAI Responses API: every tool gets an
 * explicit `strict` flag — true with the converted schema when possible
 * (its input validation then first drops placeholder nulls for
 * originally-optional properties, so the tool and the persisted tool_use
 * event see the call without them), false with its original schema and
 * validation otherwise.
 * Tools whose schema can't be read synchronously pass through untouched.
 */
export function applyOpenAiStrictSchemas<T extends ToolSet>(tools: T): T {
  const out: Record<string, unknown> = {};
  for (const [name, t] of Object.entries(tools)) {
    out[name] = toStrictTool(t);
  }
  return out as T;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toStrictTool(t: any): any {
  if (!t || t.inputSchema == null) return t;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let schema: any;
  let original: unknown;
  try {
    schema = asSchema(t.inputSchema);
    original = schema.jsonSchema;
  } catch {
    return t;
  }
  if (!isObj(original) || typeof (original as { then?: unknown }).then === "function") return t;
  const strictSchema = toOpenAiStrictSchema(original);
  // strict:false → the original schema and validation as-is; only the
  // explicit flag changes, so OpenAI doesn't strictify it on its own.
  if (!strictSchema) return { ...t, strict: false };
  const validate = async (value: unknown) => {
    const cleaned = stripNullOptionals(original, value);
    return typeof schema.validate === "function"
      ? schema.validate(cleaned)
      : { success: true as const, value: cleaned };
  };
  return {
    ...t,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputSchema: jsonSchema(strictSchema as any, { validate }),
    strict: true,
  };
}
