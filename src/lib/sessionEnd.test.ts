import { describe, expect, it } from "vitest";
import { createSessionEnd, endedText } from "./sessionEnd";

const texts = { title: "Session ended", close: "Close tab", restart: "Restart session", save: "Save terminal output to file" };

function track() {
  const events: string[] = [];
  const ending = createSessionEnd({ lost: () => events.push("lost"), failed: error => events.push(`failed:${String(error)}`) });
  return { ending, events };
}

describe("session end", () => {
  it("ends a failed connect in the closed state with the error above the hints", () => {
    const { ending, events } = track();
    ending.failed("SSH_CONNECT_TIMEOUT");
    expect(ending.ended).toBe(true);
    expect(events).toEqual(["failed:SSH_CONNECT_TIMEOUT"]);
    const text = endedText(texts, "SSH connection failed: Connection setup timed out");
    const error = text.indexOf("Connection setup timed out");
    expect(error).toBeGreaterThan(-1);
    for (const hint of [texts.title, "<Return>", texts.close, texts.restart, texts.save]) expect(text.indexOf(hint)).toBeGreaterThan(error);
  });
  it("ends a lost connection in the same closed state as a regular exit", () => {
    const { ending, events } = track();
    expect(ending.started()).toBe(true);
    expect(ending.ended).toBe(false);
    ending.exit();
    expect(ending.ended).toBe(true);
    expect(events).toEqual(["lost"]);
    expect(endedText(texts)).toBe(endedText(texts, undefined));
    expect(endedText(texts)).toContain(texts.restart);
    // Failed and lost sessions share the same hint block.
    expect(endedText(texts, "x").endsWith(endedText(texts).slice(2))).toBe(true);
  });
  it("reports the start failure only once when the exit event arrives first", () => {
    const { ending, events } = track();
    ending.exit();
    expect(ending.ended).toBe(false);
    ending.failed("SSH_CHANNEL_REJECTED");
    ending.exit();
    expect(events).toEqual(["failed:SSH_CHANNEL_REJECTED"]);
    expect(ending.started()).toBe(false);
  });
  it("turns an exit during a successful start into a regular end", () => {
    const { ending, events } = track();
    ending.exit();
    expect(ending.started()).toBe(false);
    expect(ending.ended).toBe(true);
    ending.exit(); ending.failed("late");
    expect(events).toEqual(["lost"]);
  });
  it("strips control characters from the failure line", () => {
    expect(endedText(texts, "bad\x1b]0;title\x07name")).toContain("bad ]0;title name");
  });
});
