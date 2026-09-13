/**
 * THE PROVIDER ADAPTER — the one file whose failures cost a real run.
 *
 * There was no test for it at all, which is why three of its four failure modes
 * escaped the retry loop it exists for. Every case here is driven by an injected
 * `fetchImpl`: no network, no key, no cost, and the retry/backoff behaviour
 * DECISIONS.md calls mandatory becomes something a change can break loudly.
 *
 * The measured justification for retrying at all — ~2 in 8 calls returning 429 on
 * the free tier — applies identically to a dropped connection and to a gateway
 * answering 200 with an HTML error page. Those two used to throw out of the first
 * attempt with no retry and no backoff, ending a 30-turn discovery run.
 */
import { describe, expect, it } from "vitest";
import { OpenAICompatProvider, type OpenAICompatConfig } from "../src/model/openai-compat.js";
import type { ConverseOptions } from "../src/model/provider.js";

const OPTS: ConverseOptions = { tools: [], toolChoice: "required", maxTokens: 512 };

const body = (over: Record<string, unknown> = {}) => ({
  choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 3 },
  ...over,
});

const ok = (payload: Record<string, unknown> = body()): Response =>
  new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });

const status = (code: number, text = "overloaded"): Response => new Response(text, { status: code });

/** Never sleeps: the backoff schedule is not what these tests are about. */
const provider = (fetchImpl: typeof fetch, over: Partial<OpenAICompatConfig> = {}): OpenAICompatProvider =>
  new OpenAICompatProvider({
    id: "test-model",
    baseUrl: "https://example.invalid/v1",
    apiKey: "sk-not-a-real-key-0123456789",
    model: "test",
    sleep: async () => {},
    fetchImpl,
    ...over,
  });

/**
 * THE WIRE PAIRING RULE — every declared tool call must be answered.
 *
 * The loop executes exactly ONE call per turn on purpose: a second call's `ref`
 * was chosen from the observation taken before the first action ran, and acting on
 * a stale ref could hit a different control on a screen rated irreversible. But the
 * assistant turn's opaque `raw` still declares every call the model made, and
 * `toWire` replays it verbatim — so a batched turn put an unanswered id on the wire.
 *
 * Measured against an endpoint applying the real rule: HTTP 400, "The following
 * tool_call_ids did not have response messages: call_B", which this adapter treats
 * as terminal. The run died, and because `discover/main.ts` writes `trace.jsonl`
 * and `transcript.jsonl` only after `runDiscovery` returns, it took the evidence of
 * the genuine run with it.
 */
describe("reconciling tool calls before they reach the wire", () => {
  const sent = (fetchImpl: typeof fetch) => fetchImpl;

  /** An assistant turn that declared two calls, of which the loop answered one. */
  const batched = [
    { role: "user" as const, content: "GOAL: look up a member" },
    {
      role: "assistant" as const,
      content: "",
      toolCalls: [
        { id: "call_A", name: "type_text", args: {} },
        { id: "call_B", name: "click", args: {} },
      ],
      raw: {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_A", type: "function", function: { name: "type_text", arguments: "{}" } },
          { id: "call_B", type: "function", function: { name: "click", arguments: "{}" } },
        ],
      },
    },
    { role: "tool" as const, callId: "call_A", content: "SCREEN: MEMBER_SEARCH" },
  ];

  const captureBody = (): { readonly seen: Record<string, unknown>[]; readonly impl: typeof fetch } => {
    const seen: Record<string, unknown>[] = [];
    const impl: typeof fetch = async (_url, init) => {
      seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return ok();
    };
    return { seen, impl };
  };

  type WireMsg = { role: string; tool_calls?: { id: string }[]; tool_call_id?: string };

  it("drops a declared call that nothing answered, instead of letting the endpoint 400", async () => {
    const { seen, impl } = captureBody();
    await provider(sent(impl)).converse(batched, OPTS);

    const messages = seen[0]?.["messages"] as WireMsg[];
    const assistant = messages.find((m) => m.role === "assistant");
    const declared = (assistant?.tool_calls ?? []).map((c) => c.id);
    const answered = messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);

    // The invariant, asserted directly rather than via a status code: nothing is
    // declared on the wire that no tool message answers.
    expect(declared).toEqual(["call_A"]);
    expect(declared.every((id) => answered.includes(id))).toBe(true);
  });

  it("leaves an ordinary single-call turn byte-identical", async () => {
    const { seen, impl } = captureBody();
    const single = [
      batched[0]!,
      {
        role: "assistant" as const,
        content: "",
        toolCalls: [{ id: "call_A", name: "type_text", args: {} }],
        raw: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_A", type: "function", function: { name: "type_text", arguments: "{}" } }],
        },
      },
      batched[2]!,
    ];
    await provider(sent(impl)).converse(single, OPTS);

    // This runs on every request the adapter makes, so "changed nothing when
    // nothing was orphaned" matters as much as the drop itself.
    const messages = seen[0]?.["messages"] as WireMsg[];
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.tool_calls).toEqual([
      { id: "call_A", type: "function", function: { name: "type_text", arguments: "{}" } },
    ]);
  });

  it("does not mutate the caller's history, which is replayed on every later turn", async () => {
    const { impl } = captureBody();
    await provider(sent(impl)).converse(batched, OPTS);

    // `raw` is the provider's own object, held in the loop's history and written
    // verbatim into transcript.jsonl. A mutating reconcile would make the drop
    // permanent and invisible, and would silently rewrite the recorded evidence.
    const raw = batched[1]?.raw as { tool_calls: { id: string }[] };
    expect(raw.tool_calls.map((c) => c.id)).toEqual(["call_A", "call_B"]);
  });
});

describe("retrying what actually fails", () => {
  it("retries a 429 and reports EVERY HTTP attempt in its call count", async () => {
    let calls = 0;
    const flaky: typeof fetch = async () => {
      calls += 1;
      return calls <= 4 ? status(429) : ok();
    };

    const p = provider(flaky);
    const res = await p.converse([{ role: "user", content: "hi" }], OPTS);

    expect(res.text).toBe("hello");
    expect(calls).toBe(5);
    // `calls` counted logical requests, so one converse() over five HTTP requests
    // reported 1 — under-reporting exactly the traffic a rate limit is judged on.
    expect(p.calls).toBe(5);
  });

  it("retries a TRANSPORT error, which used to escape the loop on its first occurrence", async () => {
    let calls = 0;
    const dropped: typeof fetch = async () => {
      calls += 1;
      if (calls < 3) throw new TypeError("fetch failed");
      return ok();
    };

    const p = provider(dropped);
    await expect(p.converse([{ role: "user", content: "hi" }], OPTS)).resolves.toMatchObject({ text: "hello" });
    expect(p.calls).toBe(3);
  });

  it("retries a 200 whose body is not JSON — a gateway error page", async () => {
    let calls = 0;
    const gateway: typeof fetch = async () => {
      calls += 1;
      return calls < 2
        ? new Response("<html><body>502 Bad Gateway</body></html>", { status: 200, headers: { "content-type": "text/html" } })
        : ok();
    };

    await expect(provider(gateway).converse([{ role: "user", content: "hi" }], OPTS)).resolves.toMatchObject({ text: "hello" });
    expect(calls).toBe(2);
  });

  it("does NOT retry a 400, and names what went wrong", async () => {
    let calls = 0;
    const bad: typeof fetch = async () => {
      calls += 1;
      return status(400, "invalid tool schema");
    };

    const p = provider(bad);
    await expect(p.converse([{ role: "user", content: "hi" }], OPTS)).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(1);
    expect(p.calls).toBe(1);
  });

  it("gives up after the configured number of attempts rather than forever", async () => {
    let calls = 0;
    const down: typeof fetch = async () => {
      calls += 1;
      return status(503);
    };

    const p = provider(down, { maxRetries: 3 });
    await expect(p.converse([{ role: "user", content: "hi" }], OPTS)).rejects.toThrow(/3 HTTP attempt/);
    expect(calls).toBe(3);

    // The count in that message is per CALL. It used to interpolate the
    // provider's LIFETIME request total, so the second failing call claimed
    // "6 HTTP attempt(s)" for a call that made three — and creating a fresh
    // provider in every test is exactly what kept it hidden.
    await expect(p.converse([{ role: "user", content: "hi" }], OPTS)).rejects.toThrow(/3 HTTP attempt\(s\) for this call/);
    // ...while `calls`, which claims the lifetime total, still reports all six.
    expect(p.calls).toBe(6);
  });
});

describe("a hung endpoint", () => {
  it("carries a deadline on every attempt, because the run's own ceiling cannot interrupt an await", async () => {
    // `StopController.beginStep` checks elapsed time BETWEEN turns. With no signal
    // here, a socket that accepts and never answers blocked the loop forever while
    // the 300-second ceiling was never evaluated.
    let sawSignal = false;
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        sawSignal = signal instanceof AbortSignal;
        signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      });

    const p = provider(hang, { requestTimeoutMs: 20, maxRetries: 1 });
    await expect(p.converse([{ role: "user", content: "hi" }], OPTS)).rejects.toThrow(/no response within 20ms/);
    expect(sawSignal).toBe(true);
  });
});

describe("reading what came back", () => {
  it("surfaces tool calls, and unparseable arguments as empty rather than crashing", async () => {
    const withTools: typeof fetch = async () =>
      ok(
        body({
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  { id: "call_1", type: "function", function: { name: "click", arguments: '{"ref":"f2e13"}' } },
                  { id: "call_2", type: "function", function: { name: "click", arguments: "{not json" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      );

    const res = await provider(withTools).converse([{ role: "user", content: "hi" }], OPTS);

    expect(res.stopReason).toBe("tool_calls");
    expect(res.toolCalls[0]?.args).toEqual({ ref: "f2e13" });
    // Handed back to the loop as a correction rather than thrown.
    expect(res.toolCalls[1]?.args).toEqual({});
  });

  it("reports truncation as truncation, which reads as refusal otherwise", async () => {
    const truncated: typeof fetch = async () =>
      ok(body({ choices: [{ message: { role: "assistant", content: "", reasoning_content: "thinking..." }, finish_reason: "length" }] }));

    const res = await provider(truncated).converse([{ role: "user", content: "hi" }], OPTS);

    expect(res.stopReason).toBe("max_tokens");
    expect(res.usage.reasoningChars).toBe("thinking...".length);
  });

  it("never puts the api key anywhere but the authorization header", async () => {
    let seen = "";
    const capture: typeof fetch = async (_url, init) => {
      seen = JSON.stringify({ headers: init?.headers, body: init?.body });
      return ok();
    };

    const p = provider(capture, { apiKey: "sk-secret-value-0123456789" });
    await p.converse([{ role: "user", content: "hi" }], OPTS);

    expect(seen).toContain("Bearer sk-secret-value-0123456789");
    const failing: typeof fetch = async () => status(400, "nope");
    await expect(provider(failing, { apiKey: "sk-secret-value-0123456789" }).converse([], OPTS)).rejects.toThrow(
      /^(?!.*sk-secret-value).*$/s,
    );
  });
});
