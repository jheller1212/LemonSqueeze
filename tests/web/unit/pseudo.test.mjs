import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256Hex, newSalt, validSalt, loadOrCreateSalt, importSalt, createPseudonymiser, KEEP_AS_IS } from "../../../web/lib/pseudo.js";

const stub = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) }; };

test("same function as the CLI: sha256(salt + name), hex", async () => {
  const salt = "ab".repeat(32);
  const expected = createHash("sha256").update(salt + "some_user").digest("hex");
  assert.equal(await sha256Hex(salt + "some_user"), expected);
  const p = createPseudonymiser(salt);
  await p.learn(["some_user", "ünï_cødé"]);
  assert.equal(p.of("some_user"), expected);
  assert.equal(p.of("ünï_cødé"), createHash("sha256").update(salt + "ünï_cødé", "utf8").digest("hex"));
});

test("placeholders are kept, as in the CLI", async () => {
  const p = createPseudonymiser(newSalt());
  await p.learn(KEEP_AS_IS);
  for (const k of KEEP_AS_IS) assert.equal(p.of(k), k);
});

test("apply(): every author field replaced, nothing else touched, input not mutated", async () => {
  const salt = newSalt();
  const posts = [{ id: "a", author: "ann", title: "t", comments: [{ id: "c1", author: "bob", body: "ann said hi" }, { id: "c2", author: "[deleted]", body: "x" }] }];
  const out = await createPseudonymiser(salt).apply(posts);
  assert.equal(posts[0].author, "ann");
  assert.match(out[0].author, /^[0-9a-f]{64}$/);
  assert.match(out[0].comments[0].author, /^[0-9a-f]{64}$/);
  assert.equal(out[0].comments[1].author, "[deleted]");
  assert.equal(out[0].comments[0].body, "ann said hi"); // bodies are not rewritten: names inside text stay
  assert.notEqual(out[0].author, out[0].comments[0].author);
  // a different salt gives different pseudonyms; the same salt the same ones
  assert.equal((await createPseudonymiser(salt).apply(posts))[0].author, out[0].author);
  assert.notEqual((await createPseudonymiser(newSalt()).apply(posts))[0].author, out[0].author);
});

test("salt: created once, reused, importable, validated", () => {
  const s = stub();
  const a = loadOrCreateSalt(s), b = loadOrCreateSalt(s);
  assert.equal(a.created, true); assert.equal(b.created, false); assert.equal(a.salt, b.salt);
  assert.match(a.salt, /^[0-9a-f]{64}$/);
  assert.equal(importSalt(s, "CD".repeat(32)), "cd".repeat(32));
  assert.equal(loadOrCreateSalt(s).salt, "cd".repeat(32));
  assert.throws(() => importSalt(s, "not hex"));
  assert.equal(validSalt("abc"), false);
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  const c = loadOrCreateSalt(blocked);
  assert.equal(c.persistent, false); assert.match(c.salt, /^[0-9a-f]{64}$/);
});
