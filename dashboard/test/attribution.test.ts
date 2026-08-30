import { expect, test } from "bun:test";
import { PUBLIC_ATTRIBUTION as VIEWER } from "../../runner/viewer/public-projection";
import { PUBLIC_ATTRIBUTION } from "../src/lib/attribution";

test("the dashboard's copy of the attribution is the viewer's, verbatim", () => {
  expect(PUBLIC_ATTRIBUTION).toBe(VIEWER);
});
