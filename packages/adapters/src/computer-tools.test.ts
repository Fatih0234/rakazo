import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { computerObservation } from "./computer-support.js";
import { observationToolResult, parseComputerActions } from "./computer-tools.js";

describe("computer tool bridge", () => {
  it("normalizes a bounded batch into provider-neutral actions", () => {
    expect(
      parseComputerActions([
        { kind: "click", x: 20.4, y: 30.6 },
        { kind: "type", text: "hello" },
        { kind: "scroll", direction: "up", amount: 999 },
        { kind: "focus", application: "xterm" },
      ]),
    ).toEqual([
      { kind: "pointer", x: 20, y: 31, type: "click", button: "left" },
      { kind: "clipboard", text: "hello" },
      { kind: "scroll", direction: "up", amount: 20 },
      { kind: "focus", application: "xterm" },
    ]);
  });

  it("keeps an optional URI on focus actions and rejects a missing application", () => {
    expect(
      parseComputerActions([
        { kind: "focus", application: "chromium", uri: "https://example.test" },
      ]),
    ).toEqual([{ kind: "focus", application: "chromium", uri: "https://example.test" }]);
    expect(() => parseComputerActions([{ kind: "focus" }])).toThrow(/application/);
    expect(() => parseComputerActions([{ kind: "focus", application: "   " }])).toThrow(
      /application/,
    );
  });

  it("requires a non-blank application on the focus tool variant", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "computer_act");
    const schema = tool?.inputSchema as {
      properties?: {
        actions?: {
          items?: {
            oneOf?: Array<{
              required?: string[];
              properties?: {
                kind?: { enum?: string[] };
                application?: { minLength?: number; pattern?: string };
              };
            }>;
          };
        };
      };
    };
    const items = schema?.properties?.actions?.items ?? {};
    const focus = items.oneOf?.find((branch) => branch.properties?.kind?.enum?.includes("focus"));
    const other = items.oneOf?.find((branch) => branch !== focus);
    expect(focus?.required).toEqual(["kind", "application"]);
    expect(focus?.properties?.application).toMatchObject({ minLength: 1, pattern: "\\S" });
    expect(other?.required).toEqual(["kind"]);
    expect(other?.properties?.kind?.enum).not.toContain("focus");
  });

  it("rejects batches whose expanded double-click actions exceed the limit", () => {
    expect(() =>
      parseComputerActions(
        Array.from({ length: 13 }, () => ({ kind: "click", x: 10, y: 10, double: true })),
      ),
    ).toThrow(/more than 24/);
  });

  it("returns observations as model-visible image content", () => {
    const observation = computerObservation(Uint8Array.from([1, 2, 3]), {
      mimeType: "image/png",
      width: 1280,
      height: 800,
    });
    const result = observationToolResult(observation);
    expect(result.content).toEqual([
      expect.objectContaining({ type: "text" }),
      { type: "image", data: "AQID", mimeType: "image/png" },
    ]);
  });

  it("does not resend an unchanged screenshot", () => {
    const observation = computerObservation(Uint8Array.from([1, 2, 3]), {
      mimeType: "image/png",
      width: 1280,
      height: 800,
    });
    const result = observationToolResult(observation, "observed", observation.frameId);

    expect(result.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("unchanged") }),
    ]);
  });
});
