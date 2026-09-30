/** Checks the exact request shape each reply model gets, against a local stub API. */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bodies: Record<string, unknown>[] = [];
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const body = JSON.parse(data);
      bodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [
            { type: "thinking", thinking: "", signature: "x" },
            { type: "text", text: "Thanks! Demo soon." },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 7 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(4998, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4998";
  process.env.ANTHROPIC_API_KEY = "sk-test";
});
afterAll(() => server.close());

describe("generateReplyText", () => {
  it("sends the right settings for each model", async () => {
    const { generateReplyText } = await import("@/services/llm");
    const haiku = await generateReplyText({ model: "haiku", system: "s", prompt: "p" });
    const sonnet = await generateReplyText({ model: "sonnet", system: "s", prompt: "p" });
    const opus = await generateReplyText({ model: "opus", system: "s", prompt: "p" });
    expect([haiku.text, sonnet.text, opus.text]).toEqual(["Thanks! Demo soon.", "Thanks! Demo soon.", "Thanks! Demo soon."]);

    const [h, s, o] = bodies;
    expect(h.model).toBe("claude-haiku-4-5");
    expect(h.thinking).toBeUndefined(); // Haiku 4.5: no adaptive thinking
    expect(h.output_config).toBeUndefined(); // ...and no effort
    expect(s.model).toBe("claude-sonnet-5-5");
    expect(s.thinking).toEqual({ type: "adaptive" });
    expect(s.output_config).toEqual({ effort: "medium" });
    expect(o.model).toBe("claude-opus-5-5");
    expect(o.thinking).toEqual({ type: "adaptive" });
    expect(o.output_config).toEqual({ effort: "high" });
  });
});
