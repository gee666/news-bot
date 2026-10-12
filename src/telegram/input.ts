import { emitKeypressEvents, type Key } from "node:readline";
import type { Readable, Writable } from "node:stream";

export class TelegramSetupError extends Error {}

export interface TerminalInput extends Readable {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode(mode: boolean): unknown;
}

/** Do not echo input, including phone numbers, codes, hashes and passwords. */
export function hiddenInput(
  label: string,
  input: TerminalInput = process.stdin,
  output: Writable = process.stderr,
): Promise<string> {
  if (!input.isTTY) {
    return Promise.reject(new TelegramSetupError("Login requires an interactive terminal."));
  }
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw ?? false;
    const restorePaused = input.readableFlowing !== true;
    const characters: string[] = [];
    const cleanup = () => {
      input.removeListener("keypress", onKey);
      input.removeListener("end", cancel);
      process.removeListener("SIGTERM", cancel);
      process.removeListener("SIGINT", cancel);
      input.setRawMode(wasRaw);
      if (restorePaused) input.pause();
      characters.length = 0;
      output.write("\n");
    };
    const cancel = () => {
      cleanup();
      reject(new TelegramSetupError("Login cancelled."));
    };
    const onKey = (text: string | undefined, key: Key) => {
      if (key.ctrl && (key.name === "c" || key.name === "d")) {
        cancel();
      } else if (key.name === "return" || key.name === "enter") {
        const value = characters.join("");
        characters.length = 0;
        cleanup();
        resolve(value);
      } else if (key.name === "backspace") {
        characters.pop();
      } else if (key.ctrl && key.name === "u") {
        characters.length = 0;
      } else if (!key.ctrl && !key.meta && text && ![...text].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
        characters.push(...text);
      }
    };
    output.write(label + " [hidden]: ");
    emitKeypressEvents(input);
    input.on("keypress", onKey);
    input.once("end", cancel);
    process.once("SIGTERM", cancel);
    process.once("SIGINT", cancel);
    input.setRawMode(true);
    input.resume();
  });
}
