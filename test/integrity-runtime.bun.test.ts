import { expect, test } from "bun:test";
import { sha256 } from "../src/integrity.ts";

// integrity.ts uses Bun.CryptoHasher under Bun (sync) and Web Crypto elsewhere;
// both must produce byte-identical digests or chains would not verify across runtimes.
test("native SHA-256 path agrees with Web Crypto", async () => {
  for (const input of ["", "abc", "évènement 🔐", "x".repeat(10_000)]) {
    const web = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
    );
    const hex = Array.from(web, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(await sha256(input)).toBe(`sha256:${hex}`);
  }
});
