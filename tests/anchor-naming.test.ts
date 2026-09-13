/**
 * WHAT NAMES A CONTROL — the rule that decides every target this system mints.
 *
 * A capability is only as stable as the anchor its targets are recorded against,
 * and this project has now shipped BOTH possible readings of that rule and found
 * each one wrong on a different screen. The two rows are nearly identical HTML:
 *
 *   MBR0310, a data grid   `… <td>OPEN</td><td><a>SELECT</a></td>`
 *   MBR0400, label/value   `<td>CARD SERVICES</td><td><a>OPEN</a></td>`
 *
 * Anchoring on the cell to the left put the grid's detail link on `OPEN` — the
 * STATUS column's DATA — welding the target to one member, since the next row
 * reads `FROZEN`. Anchoring on the control's own text fixed that and broke the
 * detail screen, where the link says only the bare verb `OPEN`: the compiler
 * refused the artifact because the binding has no such literal, so a real
 * discovery run of the card capability died at compile AFTER the paid model call.
 *
 * THE SECOND BREAK WAS INVISIBLE TO ALL 321 TESTS. Nothing mints against MBR0400,
 * and the committed discovery evidence stops at the results grid, so the whole
 * suite stayed green while the flagship mutating flow was unreachable. That is
 * the coverage hole this file exists to close — it pins the rule on BOTH screens
 * at once, so neither reading can be restored without the other failing.
 *
 * Real browser, real mock, no model: `describe()` is the function that mints an
 * anchor, so it is what gets asserted rather than a reimplementation of it.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../mock/main.js";
import { tenantA } from "../mock/tenant.js";
import { PlaywrightSurface } from "../src/surface/playwright.js";

let ENTRY: string;
let server: Server;

beforeAll(async () => {
  // Port 0 — the OS picks a free one, for the reason card.integration.test.ts
  // gives: a fixed port that is already held turns these into silent SKIPs.
  server = createServer(tenantA);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  ENTRY = `http://localhost:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** The anchor `describe()` mints for the first link on a screen, by visible name. */
const anchorOfLink = async (url: string, linkName: string): Promise<string | null> => {
  const driver = await PlaywrightSurface.launch(url, { headed: false });
  try {
    const observation = await driver.observe();
    const node = observation.nodes.find((n) => n.role === "link" && n.name.includes(linkName));
    if (node === undefined) {
      throw new Error(
        `no link named "${linkName}" on ${url} — saw: ${observation.nodes
          .filter((n) => n.role === "link")
          .map((n) => n.name)
          .join(" | ")}`,
      );
    }
    const facts = await driver.describe(node.ref);
    if (facts === null) throw new Error(`describe() returned null for ${node.ref}`);
    return facts.anchorText;
  } finally {
    await driver.close();
  }
};

describe("the anchor is whichever cell carries the tenant-bound label", () => {
  it("LABEL/VALUE row: the two-cell detail row names the link by its label cell, not its own verb", async () => {
    // `<td>CARD SERVICES</td><td><a>OPEN</a></td>`. The tenant's label is
    // `labels.CARD_SERVICES_LINK` on the LEFT; the link's own text is a bare verb
    // that names nothing and that the binding cannot resolve.
    const anchor = await anchorOfLink(`${ENTRY}screen/detail?id=400200101`, "OPEN");

    expect(anchor).toBe("CARD SERVICES");
    // Stated as its own assertion because this exact value is what the compiler
    // looks up, and `OPEN` is the regression: it refuses with "binding has no
    // such literal" and throws away a discovery run that already cost a model call.
    expect(anchor).not.toBe("OPEN");
  }, 30_000);

  it("DATA GRID row: the wide results row names the link by its own text, not by the status beside it", async () => {
    // `… <td>OPEN</td><td><a>SELECT</a></td>`. Here the preceding cell is the
    // STATUS column's data and the tenant's label (`labels.OPEN_MEMBER`) rides on
    // the control itself. The grid's header cell is the fixed literal `ACTION`,
    // so the label genuinely exists nowhere else in the row.
    const anchor = await anchorOfLink(`${ENTRY}screen/results?MBRNO=400200101`, "SELECT");

    expect(anchor).toBe("SELECT");
    // The original defect, pinned directly: anchoring on row data welds the
    // target to one member's card status, and the next row reads FROZEN.
    expect(anchor).not.toBe("OPEN");
  }, 30_000);
});
