import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { hiddenInput } from "./input.js";

class FakeTerminal extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(mode: boolean) { this.isRaw = mode; return this; }
}

afterEach(() => {
  // A cancelled prompt must not keep process-level signal handlers alive.
  expect(process.listenerCount("SIGTERM")).toBe(0);
});

describe("hidden terminal input", () => {
  it("does not echo phone numbers, codes or passwords and restores terminal state", async () => {
    const input = new FakeTerminal();
    const output = new PassThrough();
    let printed = "";
    output.on("data", (chunk: Buffer) => { printed += chunk.toString(); });
    const answer = hiddenInput("Login code", input, output);
    input.write("12345\r");
    expect(await answer).toBe("12345");
    expect(printed).toBe("Login code [hidden]: \n");
    expect(input.isRaw).toBe(false);
    expect(input.isPaused()).toBe(true);
    expect(input.listenerCount("keypress")).toBe(0);
  });

  it("handles unicode passwords and backspace without displaying them", async () => {
    const input = new FakeTerminal();
    const output = new PassThrough();
    const answer = hiddenInput("Password", input, output);
    input.write("a😀x\x7f\r");
    expect(await answer).toBe("a😀");
  });

  it("cancels on Ctrl-C and restores a pre-existing raw mode", async () => {
    const input = new FakeTerminal();
    input.isRaw = true;
    const answer = hiddenInput("Password", input, new PassThrough());
    input.write("never echoed\x03");
    await expect(answer).rejects.toThrow("cancelled");
    expect(input.isRaw).toBe(true);
    expect(input.listenerCount("keypress")).toBe(0);
  });

  it("refuses non-interactive input", async () => {
    const input = new FakeTerminal();
    input.isTTY = false;
    await expect(hiddenInput("Password", input, new PassThrough())).rejects.toThrow("interactive");
    expect(input.isRaw).toBe(false);
  });
});
