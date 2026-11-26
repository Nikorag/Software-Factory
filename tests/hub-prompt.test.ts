import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { readKeyFromStdin } from "../src/hub/prompt.js";
import { looksLikeHubKey } from "../src/hub/settings.js";

// Synthetic, but the same shape as a real key (sfh_<uuid>.<43 base64url chars>, including _ and -).
const KEY = "sfh_00000000-1111-4222-8333-444444444444.Fake_Key-Fake_Key-Fake_Key-Fake_Key-0123456";
const sink = () => { const s = new PassThrough(); let text = ""; s.on("data", (c) => (text += c)); return { s, text: () => text }; };

describe("hub connect key prompt", () => {
  it("returns the pasted line (it used to return an empty string)", async () => {
    const input = new PassThrough(), out = sink();
    const p = readKeyFromStdin(input, out.s);
    input.write(`${KEY}\n`);
    const got = await p;
    expect(got).toBe(KEY);
    expect(looksLikeHubKey(got)).toBe(true);
  });
  it("works with piped input that ends right after the key (pbpaste | ...)", async () => {
    const input = new PassThrough(); const p = readKeyFromStdin(input, sink().s);
    input.end(KEY);
    expect(await p).toBe(KEY);
  });
  it("takes only the first line", async () => {
    const input = new PassThrough(); const p = readKeyFromStdin(input, sink().s);
    input.write(`${KEY}\nsecond line\n`);
    expect(await p).toBe(KEY);
  });
  it("resolves empty only when there is no input at all", async () => {
    const input = new PassThrough(); const p = readKeyFromStdin(input, sink().s);
    input.end();
    expect(await p).toBe("");
  });
  it("on a terminal it prompts, does not echo the key, and still returns it", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input }), out = sink();
    const p = readKeyFromStdin(input, out.s);
    input.write(`${KEY}\r`);
    expect(await p).toBe(KEY);
    expect(out.text()).toContain("Hub API key:");
    expect(out.text()).not.toContain(KEY.slice(10, 30));
  });
});
