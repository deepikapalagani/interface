/**
 * THE TOOL SURFACE — and the duplication it deliberately carries.
 *
 * Each tool is declared twice: a Zod schema that validates what the model sends
 * back, and a JSON Schema that goes out on the wire. Writing both by hand avoids
 * a dependency for eight tiny objects, but hand-maintained duplication is exactly
 * what drifts silently — a field added to one and forgotten in the other would
 * produce a model that confidently sends an argument the validator rejects.
 *
 * So the two are pinned to each other here. If they ever disagree about a tool's
 * required arguments, this fails rather than the run.
 *
 * The other thing under test is the retry path. No provider we target enforces a
 * tool's schema, so malformed arguments are routine rather than exceptional; the
 * validator has to return a message good enough to hand straight back to the
 * model as a correction.
 */
import { describe, expect, it } from "vitest";
import { TERMINAL_TOOLS, TOOL_SPECS, ToolArgs, isToolName, parseToolArgs, type ToolName } from "../src/discover/tools.js";

const requiredOf = (name: ToolName): string[] => {
  const spec = TOOL_SPECS.find((s) => s.name === name);
  return [...((spec?.parameters as { required?: string[] }).required ?? [])].sort();
};

/** The Zod object's keys, which is what the validator will actually demand. */
const zodKeysOf = (name: ToolName): string[] => Object.keys(ToolArgs[name].shape).sort();

describe("tool specs", () => {
  it("every tool has both a Zod schema and a wire schema", () => {
    const zodNames = Object.keys(ToolArgs).sort();
    const wireNames = TOOL_SPECS.map((s) => s.name).sort();
    expect(wireNames).toEqual(zodNames);
    expect(TOOL_SPECS).toHaveLength(7);
  });

  it("offers NO screenshot tool, because no image ever reached the model", () => {
    // It was declared and described as "request an image of the screen", and the
    // executor answered it with the same text observation `observe` returns — the
    // wire format between the loop and the provider carries strings only. A tool
    // whose description promises something its implementation cannot do burns a
    // turn and teaches the model nothing. Vision is recorded as a cut instead.
    expect(TOOL_SPECS.map((s) => s.name)).not.toContain("screenshot");
    expect(Object.keys(ToolArgs)).not.toContain("screenshot");
    expect(parseToolArgs("screenshot", { reason: "the text was not enough" }).ok).toBe(false);
  });

  it("the two declarations agree on every tool's arguments — the anti-drift pin", () => {
    for (const name of Object.keys(ToolArgs) as ToolName[]) {
      expect(zodKeysOf(name), `tool "${name}" disagrees between its Zod and wire schemas`).toEqual(requiredOf(name));
    }
  });

  it("is sorted and frozen, so the prompt prefix is byte-stable for caching", () => {
    const names = TOOL_SPECS.map((s) => s.name);
    expect(names).toEqual([...names].sort());
    expect(Object.isFrozen(TOOL_SPECS)).toBe(true);
  });

  it("every wire schema refuses arguments it did not declare", () => {
    for (const spec of TOOL_SPECS) {
      expect((spec.parameters as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    }
  });

  it("targets are named by ref, and the model never supplies a selector", () => {
    // If a tool ever grows a `selector` or `xpath` argument, the model would be
    // contributing the locator — which is the one thing the executor must own.
    for (const name of Object.keys(ToolArgs) as ToolName[]) {
      const keys = zodKeysOf(name);
      expect(keys).not.toContain("selector");
      expect(keys).not.toContain("xpath");
      expect(keys).not.toContain("css");
    }
    expect(zodKeysOf("click")).toContain("ref");
  });

  it("acting on a target always demands a restated screen id and a stability claim", () => {
    // The restated screen is a cheap drift check; why_stable is captured as the
    // model's BELIEF and recorded as such, never as verified fact.
    for (const name of ["click", "type_text", "read"] as ToolName[]) {
      expect(zodKeysOf(name)).toContain("screen_id");
      expect(zodKeysOf(name)).toContain("why_stable");
    }
  });

  it("finish and stuck are the only terminal tools", () => {
    expect([...TERMINAL_TOOLS].sort()).toEqual(["finish", "stuck"]);
  });
});

describe("argument validation", () => {
  it("accepts a well-formed call", () => {
    const r = parseToolArgs("click", { ref: "f2e13", screen_id: "MBR0300", why_stable: "anchored on the MEMBER ID label" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name).toBe("click");
    expect(r.args["ref"]).toBe("f2e13");
  });

  it("rejects an unknown tool and lists what is available", () => {
    const r = parseToolArgs("navigate_to_url", {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // The message goes straight back to the model, so it has to be actionable.
    expect(r.error).toContain("unknown tool");
    expect(r.error).toContain("click");
  });

  it("names the missing field, so the model can correct itself", () => {
    const r = parseToolArgs("click", { ref: "f2e13" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("screen_id");
    expect(r.error).toContain("why_stable");
  });

  it("rejects an out-of-range enum rather than coercing it", () => {
    const r = parseToolArgs("dialog", { action: "maybe", reason: "unsure" });
    expect(r.ok).toBe(false);
  });

  it("isToolName narrows a raw string from the wire", () => {
    expect(isToolName("finish")).toBe(true);
    expect(isToolName("definitely_not_a_tool")).toBe(false);
  });
});
