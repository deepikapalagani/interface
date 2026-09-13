/**
 * THE CASSETTE — and the check that keeps it honest.
 *
 * §6 asks for a way to run without live services. The cassette provides one by
 * replaying a recorded run's assistant turns, so the real loop drives the real
 * browser with no API key.
 *
 * The risk it carries is specific: a fake that always succeeds is worse than no
 * offline path, because it passes forever regardless of the code it is supposed
 * to be exercising. A cassette recorded against markup that has since changed
 * would happily replay a conversation describing screens that no longer exist.
 *
 * So the divergence check is the thing under test here, not the happy path.
 */
import { describe, expect, it } from "vitest";
import { CassetteDiverged, CassetteProvider } from "../src/model/cassette.js";
import type { ConverseOptions, Turn } from "../src/model/provider.js";

const OPTS: ConverseOptions = { tools: [], toolChoice: "required", maxTokens: 512 };

const call = (id: string, name: string) => ({ id, name, args: { ref: "f2e16" } });

/** A recorded run: two actions, each followed by the screen it produced. */
const recorded: Turn[] = [
  { role: "system", content: "system" },
  { role: "user", content: "GOAL: look up a member\n\nSCREEN: MEMBER_SEARCH" },
  { role: "assistant", content: "", toolCalls: [call("c1", "type_text")], raw: { role: "assistant" } },
  { role: "tool", callId: "c1", content: "SCREEN: MEMBER_SEARCH\nCONTROLS (2):" },
  { role: "assistant", content: "", toolCalls: [call("c2", "click")], raw: { role: "assistant" } },
  { role: "tool", callId: "c2", content: "SCREEN: MEMBER_RESULTS\nCONTROLS (1):" },
  { role: "assistant", content: "", toolCalls: [call("c3", "finish")], raw: { role: "assistant" } },
];

describe("cassette", () => {
  it("replays the recorded assistant turns in order", async () => {
    const c = new CassetteProvider(recorded);

    const first = await c.converse([{ role: "user", content: "start" }], OPTS);
    expect(first.toolCalls[0]?.name).toBe("type_text");
    expect(first.stopReason).toBe("tool_calls");

    const second = await c.converse(
      [{ role: "tool", callId: "c1", content: "SCREEN: MEMBER_SEARCH\nCONTROLS (2):" }],
      OPTS,
    );
    expect(second.toolCalls[0]?.name).toBe("click");
  });

  it("costs nothing, and says so in its usage", async () => {
    const c = new CassetteProvider(recorded);
    const r = await c.converse([], OPTS);
    expect(r.usage.promptTokens).toBe(0);
    expect(r.usage.completionTokens).toBe(0);
  });

  it("FAILS LOUDLY when the surface no longer matches the recording", async () => {
    const c = new CassetteProvider(recorded);
    await c.converse([{ role: "user", content: "start" }], OPTS);

    // The recording saw MEMBER_SEARCH after the first action. This run is on a
    // different screen, so the conversation being replayed no longer describes
    // reality — which must stop the run rather than sail past it.
    await expect(
      c.converse([{ role: "tool", callId: "c1", content: "SCREEN: SEC0403\nCONTROLS (0):" }], OPTS),
    ).rejects.toBeInstanceOf(CassetteDiverged);
  });

  it("names both screens in the divergence, so the drift is obvious", async () => {
    const c = new CassetteProvider(recorded);
    await c.converse([{ role: "user", content: "start" }], OPTS);
    try {
      await c.converse([{ role: "tool", callId: "c1", content: "SCREEN: SEC0403" }], OPTS);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as CassetteDiverged).expected).toBe("MEMBER_SEARCH");
      expect((e as CassetteDiverged).actual).toBe("SEC0403");
    }
  });

  it("runs out of tape rather than inventing a turn", async () => {
    const c = new CassetteProvider([{ role: "system", content: "s" }]);
    const r = await c.converse([], OPTS);
    expect(r.toolCalls).toHaveLength(0);
    expect(r.stopReason).toBe("end_turn");
  });

  /**
   * WHAT A REAL RECORDING ACTUALLY CONTAINS.
   *
   * The fixtures above use the full `SCREEN:` rendering on both sides, which is
   * the one shape a genuine run never records: the loop prunes every tool result
   * but the newest to `(${tool} ok) ${summary}`. Measured against the committed
   * transcript, the divergence guard therefore fired on turn 1 of a run that had
   * not diverged at all — a check that could not pass, hidden by unrepresentative
   * fixtures. These two pin both halves: it accepts the pruned form, and it still
   * refuses a genuinely different screen.
   */
  const pruned: Turn[] = [
    { role: "system", content: "system" },
    { role: "user", content: "GOAL: look up a member\n\nSCREEN: MEMBER_SEARCH" },
    { role: "assistant", content: "", toolCalls: [call("c1", "type_text")], raw: { role: "assistant" } },
    { role: "tool", callId: "c1", content: "(type_text ok) MEMBER_SEARCH — 4 control(s)" },
    { role: "assistant", content: "", toolCalls: [call("c2", "click")], raw: { role: "assistant" } },
  ];

  it("accepts a PRUNED recording, which is the only kind a real run produces", async () => {
    const c = new CassetteProvider(pruned);
    await c.converse([{ role: "user", content: "start" }], OPTS);

    const second = await c.converse(
      [{ role: "tool", callId: "c1", content: "SCREEN: MEMBER_SEARCH\nCONTROLS (4):" }],
      OPTS,
    );
    expect(second.toolCalls[0]?.name).toBe("click");
  });

  it("still diverges when a pruned recording disagrees with the live screen", async () => {
    const c = new CassetteProvider(pruned);
    await c.converse([{ role: "user", content: "start" }], OPTS);

    // The fix must widen what the guard can READ, never what it will accept.
    await expect(
      c.converse([{ role: "tool", callId: "c1", content: "SCREEN: SEC0403\nCONTROLS (0):" }], OPTS),
    ).rejects.toBeInstanceOf(CassetteDiverged);
  });

  /**
   * THE SCOPE OF THE GUARD, PINNED SO THE HEADER CANNOT OVERSTATE IT AGAIN.
   *
   * The module header used to say each turn asserts "the tool result being handed
   * back matches the one recorded at that point... a renamed field, a slower
   * screen" — while the implementation compares one screen token. This test is
   * that difference made explicit: same screen, different everything else, and the
   * cassette keeps going. It is a screen-level drift detector, and the header now
   * says so.
   */
  it("does NOT detect drift within a screen — different controls on the same screen pass", async () => {
    const c = new CassetteProvider(recorded);
    await c.converse([{ role: "user", content: "start" }], OPTS);

    const next = await c.converse(
      [{ role: "tool", callId: "c1", content: "SCREEN: MEMBER_SEARCH\nCONTROLS (0):\n  (every control renamed or gone)" }],
      OPTS,
    );

    expect(next.toolCalls[0]?.name).toBe("click");
  });
});
