import { createInterface } from "node:readline";
import { Writable } from "node:stream";

/**
 * Reads a key without echoing it when `input` is a terminal; otherwise takes the first line of stdin (e.g.
 * `pbpaste | software-factory hub connect ...`). Resolves "" only if the input ends with no line at all.
 *
 * The line MUST be handed back before the interface is closed: `rl.close()` emits "close" synchronously, and if that
 * handler resolved first the real line would be dropped (this once made every interactive connect read an empty key).
 */
export function readKeyFromStdin(input: NodeJS.ReadableStream & { isTTY?: boolean }, output: NodeJS.WritableStream): Promise<string> {
  const tty = Boolean(input.isTTY);
  let muted = false;
  const out = new Writable({ write(chunk, _enc, cb) { if (!muted) output.write(chunk); cb(); } });
  const rl = createInterface({ input, output: out, terminal: tty });
  return new Promise((resolve) => {
    if (tty) { output.write("Hub API key: "); muted = true; }
    let done = false;
    const finish = (value: string) => { if (done) return; done = true; resolve(value); };
    rl.once("line", (line) => { finish(line); rl.close(); if (tty) output.write("\n"); });
    rl.once("close", () => finish(""));
  });
}
