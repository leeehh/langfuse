import { describe, expect, it } from "vitest";

import {
  OtelIngestionProcessor,
  type ResourceSpan,
} from "./OtelIngestionProcessor";

const TRACE_SEED_PARENT_SPAN_ID = "0123456789abcdef";
const TURN_ID = "019ffdfa-241e-7a41-b5ae-db30995303d8";
const THREAD_ID = "019ffdf9-fb06-7870-8ba6-252ba661df74";

const attribute = (key: string, value: string) => ({
  key,
  value: { stringValue: value },
});

const idBuffer = (id: string) => Buffer.from(id, "hex");
type IdEncoding = "buffer" | "json-buffer" | "string";

const encodeId = (id: string, encoding: IdEncoding) => {
  const buffer = idBuffer(id);
  if (encoding === "string") return id;
  if (encoding === "json-buffer") {
    return { type: "Buffer" as const, data: [...buffer] };
  }
  return buffer;
};

const buildCodexBatch = ({
  traceId,
  turnSpanId,
  generationSpanId,
  toolSpanId,
  turnId = TURN_ID,
  seeded = false,
  turnEndTime = "1752384003000000000",
  idEncoding = "buffer",
}: {
  traceId: string;
  turnSpanId: string;
  generationSpanId: string;
  toolSpanId: string;
  turnId?: string;
  seeded?: boolean;
  turnEndTime?: string;
  idEncoding?: IdEncoding;
}): ResourceSpan[] => [
  {
    scopeSpans: [
      {
        scope: { name: "langfuse-sdk", version: "5.4.1" },
        spans: [
          {
            traceId: encodeId(traceId, idEncoding),
            spanId: encodeId(turnSpanId, idEncoding),
            ...(seeded
              ? {
                  parentSpanId: encodeId(TRACE_SEED_PARENT_SPAN_ID, idEncoding),
                }
              : {}),
            name: "Codex Turn",
            kind: 1,
            startTimeUnixNano: "1752384000000000000",
            endTimeUnixNano: turnEndTime,
            attributes: [
              attribute("langfuse.observation.type", "agent"),
              attribute("langfuse.observation.metadata.codex.turn_id", turnId),
              attribute(
                "langfuse.observation.metadata.codex.thread_id",
                THREAD_ID,
              ),
              attribute("session.id", THREAD_ID),
            ],
          },
          {
            traceId: encodeId(traceId, idEncoding),
            spanId: encodeId(generationSpanId, idEncoding),
            parentSpanId: encodeId(turnSpanId, idEncoding),
            name: "LLM",
            kind: 1,
            startTimeUnixNano: "1752384001000000000",
            endTimeUnixNano: "1752384002000000000",
            attributes: [
              attribute("langfuse.observation.type", "generation"),
              attribute("langfuse.observation.metadata.codex.step_index", "0"),
            ],
          },
          {
            traceId: encodeId(traceId, idEncoding),
            spanId: encodeId(toolSpanId, idEncoding),
            parentSpanId: encodeId(generationSpanId, idEncoding),
            name: "exec_command",
            kind: 1,
            startTimeUnixNano: "1752384001500000000",
            endTimeUnixNano: "1752384001800000000",
            attributes: [
              attribute("langfuse.observation.type", "tool"),
              attribute(
                "langfuse.observation.metadata.codex.call_id",
                "call_M7D3",
              ),
            ],
          },
        ],
      },
    ],
  },
];

const process = (batch: ResourceSpan[], sdkName = "javascript") =>
  new OtelIngestionProcessor({
    projectId: "project-1",
    publicKey: "pk-test",
    sdkName,
    sdkVersion: "5.4.1",
  }).processToEvent(batch);

const eventIdentities = (events: any[]) =>
  events.map(({ name, traceId, spanId, parentSpanId }) => ({
    name,
    traceId,
    spanId,
    parentSpanId,
  }));

describe("OtelIngestionProcessor Codex duplicate normalization", () => {
  it.each<IdEncoding>(["buffer", "json-buffer", "string"])(
    "maps replayed Codex turns and children onto stable ids for %s ids",
    (idEncoding) => {
      const first = process(
        buildCodexBatch({
          traceId: "11111111111111111111111111111111",
          turnSpanId: "1111111111111111",
          generationSpanId: "2222222222222222",
          toolSpanId: "3333333333333333",
          // Mirrors the premature Stop-hook upload before task_complete.
          turnEndTime: "1752384002900000000",
          idEncoding,
        }),
      );
      const finalizedReplay = process(
        buildCodexBatch({
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          turnSpanId: "aaaaaaaaaaaaaaaa",
          generationSpanId: "bbbbbbbbbbbbbbbb",
          toolSpanId: "cccccccccccccccc",
          idEncoding,
        }),
      );

      expect(eventIdentities(first)).toEqual(eventIdentities(finalizedReplay));
      expect(first.map((event) => event.traceId)).not.toContain(
        "11111111111111111111111111111111",
      );

      const turn = first.find((event) => event.name === "Codex Turn");
      const generation = first.find((event) => event.name === "LLM");
      const tool = first.find((event) => event.name === "exec_command");
      expect(generation.parentSpanId).toBe(turn.spanId);
      expect(tool.parentSpanId).toBe(generation.spanId);
    },
  );

  it("does not merge distinct Codex turns", () => {
    const first = process(
      buildCodexBatch({
        traceId: "11111111111111111111111111111111",
        turnSpanId: "1111111111111111",
        generationSpanId: "2222222222222222",
        toolSpanId: "3333333333333333",
      }),
    );
    const second = process(
      buildCodexBatch({
        traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        turnSpanId: "aaaaaaaaaaaaaaaa",
        generationSpanId: "bbbbbbbbbbbbbbbb",
        toolSpanId: "cccccccccccccccc",
        turnId: "019ffdfa-241e-7a41-b5ae-db30995303d9",
      }),
    );

    expect(first[0].traceId).not.toBe(second[0].traceId);
    expect(first[0].spanId).not.toBe(second[0].spanId);
  });

  it("maps collector-forwarded Codex replays onto stable ids", () => {
    const first = process(
      buildCodexBatch({
        traceId: "11111111111111111111111111111111",
        turnSpanId: "1111111111111111",
        generationSpanId: "2222222222222222",
        toolSpanId: "3333333333333333",
      }),
      "unknown",
    );
    const replay = process(
      buildCodexBatch({
        traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        turnSpanId: "aaaaaaaaaaaaaaaa",
        generationSpanId: "bbbbbbbbbbbbbbbb",
        toolSpanId: "cccccccccccccccc",
      }),
      "unknown",
    );

    expect(eventIdentities(first)).toEqual(eventIdentities(replay));
  });

  it("preserves trace ids explicitly pinned by the plugin trace_seed option", () => {
    const seededTraceId = "1234567890abcdef1234567890abcdef";
    const first = process(
      buildCodexBatch({
        traceId: seededTraceId,
        turnSpanId: "1111111111111111",
        generationSpanId: "2222222222222222",
        toolSpanId: "3333333333333333",
        seeded: true,
      }),
    );
    const replay = process(
      buildCodexBatch({
        traceId: seededTraceId,
        turnSpanId: "aaaaaaaaaaaaaaaa",
        generationSpanId: "bbbbbbbbbbbbbbbb",
        toolSpanId: "cccccccccccccccc",
        seeded: true,
      }),
    );

    expect(first.every((event) => event.traceId === seededTraceId)).toBe(true);
    expect(eventIdentities(first)).toEqual(eventIdentities(replay));
    expect(first[0].parentSpanId).toBe(TRACE_SEED_PARENT_SPAN_ID);
  });

  it("leaves non-JavaScript SDK traffic untouched", () => {
    const originalTraceId = "11111111111111111111111111111111";
    const events = process(
      buildCodexBatch({
        traceId: originalTraceId,
        turnSpanId: "1111111111111111",
        generationSpanId: "2222222222222222",
        toolSpanId: "3333333333333333",
      }),
      "python",
    );

    expect(events.every((event) => event.traceId === originalTraceId)).toBe(
      true,
    );
    expect(events[0].spanId).toBe("1111111111111111");
  });
});
