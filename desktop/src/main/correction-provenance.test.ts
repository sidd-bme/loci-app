// @vitest-environment node

import { describe, expect, it } from "vitest";
import { correctionOperationIds } from "./correction-provenance";

describe("correction operation identity", () => {
  it("preserves both possible URL-safe leading characters and operation order", () => {
    // secrets.token_urlsafe, used for every engine correction, may start with
    // either character. Rejecting one rolls a valid edit back before save.
    const ids = ["-OzDy4OQkv-_rsgQ", "_QxY0123456789ab", "A2hNAcqWr98vT6yz"];
    expect(correctionOperationIds({
      appliedOperations: ids.map((operation_id) => ({ operation_id })),
    })).toEqual(ids);
  });

  it.each(["", "../outside", "/absolute", "name/path", "two words", "x\n", "x".repeat(129), null, 123])(
    "rejects an invalid operation identity %j",
    (operation_id) => {
      expect(() => correctionOperationIds({ appliedOperations: [{ operation_id }] }))
        .toThrow("invalid correction operation provenance");
    },
  );

  it("rejects duplicate identities even when their spelling is valid", () => {
    expect(() => correctionOperationIds({
      appliedOperations: [{ operation_id: "_same" }, { operation_id: "_same" }],
    })).toThrow("invalid correction operation provenance");
  });
});
