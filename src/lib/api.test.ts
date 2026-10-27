import { describe, expect, it } from "vitest";
import { msgFromRow } from "./api";

describe("persisted proposal messages", () => {
  it("renders a linked agent proposal as a diff so its evidence can be reviewed", () => {
    const message = msgFromRow({ id: "message", thread_id: "thread", kind: "agent", meta: "diff", diff_id: "revision" });
    expect(message.kind).toBe("diff");
    expect(message.diffId).toBe("revision");
  });

  it("keeps an unlinked agent update as a message", () => {
    expect(msgFromRow({ kind: "agent", meta: "diff" }).kind).toBe("agent");
  });

  it("preserves explicitly stored diff messages", () => {
    expect(msgFromRow({ kind: "diff", diff_id: "revision" }).kind).toBe("diff");
  });
});
