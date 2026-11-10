import { describe, expect, it } from "vitest";
import { generateText, jsonSchema, tool, type ToolSet } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import {
  applyOpenAiStrictSchemas,
  schemaAllowsNull,
  stripNullOptionals,
  toOpenAiStrictSchema,
} from "@open-managed-agents/agent/harness/openai-tool-schema";

// Prod QA 2026-11-09: on the Responses API (strict omitted → OpenAI applies
// strict mode itself) gpt-6.1-sol sent every optional MCP argument as
// "" / 0 / null and Linear/Slack rejected the calls. We now send strict
// explicitly with optionals as nullable, and drop the placeholder nulls.

/** Shaped like Linear's list_issues: one required field, several optionals. */
const linearListIssues = {
  type: "object",
  properties: {
    teamId: { type: "string", description: "Team UUID" },
    state: { type: "string", enum: ["backlog", "todo", "in_progress", "done"] },
    assigneeId: { type: "string", format: "uuid" },
    limit: { type: "number" },
    includeArchived: { type: "boolean" },
    filter: {
      type: "object",
      properties: {
        label: { type: "string" },
        priority: { type: "integer" },
      },
      required: ["label"],
      additionalProperties: false,
    },
    labels: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, color: { type: "string" } }, required: ["id"], additionalProperties: false },
    },
  },
  required: ["teamId"],
};

describe("stripNullOptionals", () => {
  it("drops nulls for originally-optional properties", () => {
    expect(
      stripNullOptionals(linearListIssues, {
        teamId: "t1",
        state: null,
        assigneeId: null,
        limit: null,
        includeArchived: null,
        filter: null,
        labels: null,
      }),
    ).toEqual({ teamId: "t1" });
  });

  it("keeps a null for a REQUIRED property (the server decides)", () => {
    expect(stripNullOptionals(linearListIssues, { teamId: null })).toEqual({ teamId: null });
  });

  it("keeps 0 / false the model plausibly meant", () => {
    expect(stripNullOptionals(linearListIssues, { teamId: "t1", limit: 0, includeArchived: false })).toEqual({
      teamId: "t1",
      limit: 0,
      includeArchived: false,
    });
  });

  it("drops \"\" only where \"\" can't be valid (enum / format), keeps it for free text", () => {
    expect(stripNullOptionals(linearListIssues, { teamId: "t1", state: "", assigneeId: "" })).toEqual({ teamId: "t1" });
    const free = { type: "object", properties: { note: { type: "string" } } };
    expect(stripNullOptionals(free, { note: "" })).toEqual({ note: "" });
  });

  it("keeps a null the original schema explicitly allows (e.g. 'null to unassign')", () => {
    const update = { type: "object", properties: { assigneeId: { type: ["string", "null"] } } };
    expect(stripNullOptionals(update, { assigneeId: null })).toEqual({ assigneeId: null });
    const anyOf = { type: "object", properties: { a: { anyOf: [{ type: "string" }, { type: "null" }] } } };
    expect(stripNullOptionals(anyOf, { a: null })).toEqual({ a: null });
  });

  it("recurses into nested objects and arrays of objects", () => {
    expect(
      stripNullOptionals(linearListIssues, {
        teamId: "t1",
        filter: { label: "bug", priority: null },
        labels: [{ id: "l1", color: null }, { id: "l2", color: "red" }],
      }),
    ).toEqual({ teamId: "t1", filter: { label: "bug" }, labels: [{ id: "l1" }, { id: "l2", color: "red" }] });
  });

  it("leaves unknown keys and non-object inputs alone, and never mutates", () => {
    const input = { teamId: "t1", extra: null, limit: null };
    expect(stripNullOptionals(linearListIssues, input)).toEqual({ teamId: "t1", extra: null });
    expect(input).toEqual({ teamId: "t1", extra: null, limit: null });
    expect(stripNullOptionals(linearListIssues, "x")).toBe("x");
    expect(stripNullOptionals(undefined, { a: null })).toEqual({ a: null });
  });
});

describe("schemaAllowsNull", () => {
  it("reads type lists, nullable, anyOf and untyped schemas", () => {
    expect(schemaAllowsNull({ type: "string" })).toBe(false);
    expect(schemaAllowsNull({ type: ["string", "null"] })).toBe(true);
    expect(schemaAllowsNull({ type: "string", nullable: true })).toBe(true);
    expect(schemaAllowsNull({ anyOf: [{ type: "string" }, { type: "null" }] })).toBe(true);
    expect(schemaAllowsNull({ enum: ["a", "b"] })).toBe(false);
    expect(schemaAllowsNull({ description: "anything" })).toBe(true);
  });
});

describe("toOpenAiStrictSchema", () => {
  it("lists every property as required, optionals nullable, additionalProperties:false at every level", () => {
    const strict = toOpenAiStrictSchema(linearListIssues)!;
    expect(strict).not.toBeNull();
    expect(strict.required).toEqual(["teamId", "state", "assigneeId", "limit", "includeArchived", "filter", "labels"]);
    expect(strict.additionalProperties).toBe(false);
    const props = strict.properties as Record<string, Record<string, unknown>>;
    expect(props.teamId).toEqual({ type: "string", description: "Team UUID" }); // required stays non-null
    expect(props.state).toEqual({ anyOf: [{ type: "string", enum: ["backlog", "todo", "in_progress", "done"] }, { type: "null" }] });
    expect(props.limit).toEqual({ type: ["number", "null"] });
    expect(props.includeArchived).toEqual({ type: ["boolean", "null"] });
    // Nested object: nullable via anyOf; inside, the same rules apply.
    const filter = props.filter as { anyOf: Array<Record<string, unknown>> };
    expect(filter.anyOf[1]).toEqual({ type: "null" });
    expect(filter.anyOf[0]).toMatchObject({
      additionalProperties: false,
      required: ["label", "priority"],
      properties: { label: { type: "string" }, priority: { type: ["integer", "null"] } },
    });
    const labels = props.labels as { anyOf: Array<Record<string, unknown>> };
    expect((labels.anyOf[0].items as Record<string, unknown>).additionalProperties).toBe(false);
  });

  it("does not mutate its input", () => {
    const copy = JSON.parse(JSON.stringify(linearListIssues));
    toOpenAiStrictSchema(linearListIssues);
    expect(linearListIssues).toEqual(copy);
  });

  it("drops annotations OpenAI doesn't need ($schema, title)", () => {
    const strict = toOpenAiStrictSchema({
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "Args",
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    });
    expect(strict).toEqual({ type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false });
  });

  it.each([
    ["free-form object", { type: "object", properties: { meta: { type: "object" } } }],
    ["additionalProperties schema", { type: "object", properties: { m: { type: "object", properties: {}, additionalProperties: { type: "string" } } } }],
    ["$ref", { type: "object", properties: { a: { $ref: "#/$defs/A" } }, $defs: { A: { type: "string" } } }],
    ["default keyword", { type: "object", properties: { limit: { type: "number", default: 50 } } }],
    ["minLength", { type: "object", properties: { q: { type: "string", minLength: 1 } }, required: ["q"] }],
    ["pattern", { type: "object", properties: { id: { type: "string", pattern: "^(?=.*\\d)" } }, required: ["id"] }],
    ["nested object without additionalProperties:false (open)", { type: "object", properties: { o: { type: "object", properties: { a: { type: "string" } } } }, required: ["o"] }],
    ["union of objects", {
      type: "object",
      properties: {
        parent: {
          anyOf: [
            { type: "object", properties: { page_id: { type: "string" }, kind: { type: "string" } }, required: ["page_id"], additionalProperties: false },
            { type: "object", properties: { database_id: { type: "string" } }, required: ["database_id"], additionalProperties: false },
          ],
        },
      },
      required: ["parent"],
    }],
    ["type beside anyOf", { type: "object", properties: { d: { type: "string", anyOf: [{ type: "string", format: "date" }, { type: "string", format: "date-time" }] } } }],
    ["root anyOf", { type: "object", properties: { a: { type: "string" } }, anyOf: [{ required: ["a"] }] }],
    ["over 1000 enum values", { type: "object", properties: { tz: { type: "string", enum: Array.from({ length: 1001 }, (_, i) => `z${i}`) } }, required: ["tz"] }],
    ["unsupported format", { type: "object", properties: { u: { type: "string", format: "uri" } }, required: ["u"] }],
    ["array without items", { type: "object", properties: { xs: { type: "array" } }, required: ["xs"] }],
    ["optional that already accepts null", { type: "object", properties: { assigneeId: { type: ["string", "null"] } } }],
    ["untyped property", { type: "object", properties: { v: { description: "any" } }, required: ["v"] }],
    ["non-object root", { type: "string" }],
  ])("returns null (→ strict:false) for %s", (_label, schema) => {
    expect(toOpenAiStrictSchema(schema)).toBeNull();
  });
});

describe("applyOpenAiStrictSchemas", () => {
  async function prepared(t: unknown) {
    const out = applyOpenAiStrictSchemas({ t } as unknown as ToolSet) as Record<string, any>;
    return out.t;
  }

  it("MCP-style JSON schema tool: strict:true, converted schema, nulls stripped at validation", async () => {
    const t = await prepared({ description: "list", inputSchema: jsonSchema(linearListIssues as never), execute: async () => "ok" });
    expect(t.strict).toBe(true);
    expect(t.inputSchema.jsonSchema.required).toHaveLength(7);
    const res = await t.inputSchema.validate({ teamId: "t1", state: null, limit: null, filter: null, labels: null, assigneeId: null, includeArchived: null });
    expect(res).toEqual({ success: true, value: { teamId: "t1" } });
  });

  it("zod tool: optional fields become nullable on the wire, and zod still validates the cleaned input", async () => {
    const t = await prepared(
      tool({
        description: "search",
        inputSchema: z.object({ query: z.string(), max_results: z.number().optional() }),
        execute: async () => "ok",
      }),
    );
    expect(t.strict).toBe(true);
    expect(t.inputSchema.jsonSchema.properties.max_results).toEqual({ type: ["number", "null"] });
    expect(await t.inputSchema.validate({ query: "x", max_results: null })).toEqual({ success: true, value: { query: "x" } });
    expect((await t.inputSchema.validate({ query: 1 })).success).toBe(false);
  });

  it("zod .email() (format + lookahead pattern) falls back to strict:false instead of risking a 400", async () => {
    const t = await prepared(
      tool({ inputSchema: z.object({ to: z.string(), cc: z.string().email().optional() }), execute: async () => "ok" }),
    );
    expect(t.strict).toBe(false);
  });

  it("schemas strict mode can't express go out as strict:false, untouched (no null stripping)", async () => {
    const original = { type: "object", properties: { meta: { type: "object" }, n: { type: "number" } } };
    const inputSchema = jsonSchema(original as never);
    const t = await prepared({ inputSchema, execute: async () => "ok" });
    expect(t.strict).toBe(false);
    // Same schema object: on a non-strict tool a null is the model's own
    // choice (OpenAI doesn't force optionals there), so nothing is stripped.
    expect(t.inputSchema).toBe(inputSchema);
  });

  it("end to end through the AI SDK: the provider gets strict tools, execute gets the cleaned call", async () => {
    const seen: unknown[] = [];
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (opts) => {
        seen.push(opts.tools);
        call++;
        if (call === 1) {
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "c1",
                toolName: "mcp__linear__list_issues",
                // What a strict-mode model sends for "only teamId".
                input: JSON.stringify({ teamId: "t1", state: null, assigneeId: null, limit: null, includeArchived: null, filter: null, labels: null }),
              },
            ],
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
            warnings: [],
          };
        }
        return {
          content: [{ type: "text", text: "done" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          warnings: [],
        };
      },
    } as never);
    const received: unknown[] = [];
    const tools = applyOpenAiStrictSchemas({
      mcp__linear__list_issues: {
        description: "List issues",
        inputSchema: jsonSchema(linearListIssues as never),
        execute: async (args: unknown) => {
          received.push(args);
          return "[]";
        },
      },
    } as unknown as ToolSet);
    const { stepCountIs } = await import("ai");
    const result = await generateText({ model, tools, prompt: "list", stopWhen: stepCountIs(3) });
    expect(received).toEqual([{ teamId: "t1" }]);
    const sent = (seen[0] as Array<Record<string, unknown>>)[0];
    expect(sent).toMatchObject({ type: "function", name: "mcp__linear__list_issues", strict: true });
    expect((sent.inputSchema as { required: string[] }).required).toHaveLength(7);
    // The recorded call (what the harness persists as tool_use input) is the cleaned one too.
    expect(result.steps[0].toolCalls[0].input).toEqual({ teamId: "t1" });
  });
});
