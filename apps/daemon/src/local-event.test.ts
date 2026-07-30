import { describe, expect, it } from "vitest";
import { localEventSchema } from "./local-event.js";

describe("local event schema", () => {
  it("accepts a real task.created event", () => {
    const event = {
      type: "task.created",
      payload: { id: "t1", title: "Do the thing", ownerId: "actor", status: "active", paths: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    };
    expect(() => localEventSchema.parse(event)).not.toThrow();
  });

  it("rejects an unknown event type", () => {
    expect(() => localEventSchema.parse({ type: "task.deleted", payload: {} })).toThrow();
  });

  it("rejects a known event type with a payload shape mismatch", () => {
    expect(() => localEventSchema.parse({ type: "task.created", payload: { id: "t1" } })).toThrow();
  });

  it("rejects an extra, undeclared field on a strict payload", () => {
    const event = {
      type: "checkpoint.restored",
      payload: { ref: "refs/crosscode/checkpoints/x", path: "a.txt", extra: "not allowed" }
    };
    expect(() => localEventSchema.parse(event)).toThrow();
  });
});
