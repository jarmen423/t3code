import { describe, expect, it } from "vite-plus/test";

import { describeAgentSessionImport } from "./importAgentThreads.ts";

describe("describeAgentSessionImport", () => {
  it("treats an empty result as up to date, not a failure", () => {
    expect(describeAgentSessionImport({ importedCount: 0, skippedCount: 0 })).toEqual({
      type: "success",
      title: "No new threads found",
      description: "No new Claude Code or Codex conversations for this project.",
    });
  });

  it("reports a complete import", () => {
    expect(describeAgentSessionImport({ importedCount: 1, skippedCount: 0 }).title).toBe(
      "Imported 1 thread",
    );
    expect(describeAgentSessionImport({ importedCount: 3, skippedCount: 0 })).toMatchObject({
      type: "success",
      title: "Imported 3 threads",
    });
  });

  it("keeps a mixed result distinct from a total failure", () => {
    expect(describeAgentSessionImport({ importedCount: 2, skippedCount: 1 })).toEqual({
      type: "warning",
      title: "Imported 2 threads",
      description: "1 thread could not be imported.",
    });
    expect(describeAgentSessionImport({ importedCount: 0, skippedCount: 4 })).toMatchObject({
      type: "error",
      title: "4 threads could not be imported",
    });
  });
});
