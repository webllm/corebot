import test from "node:test";
import assert from "node:assert/strict";
import { isChannelIdentityAllowed } from "../src/channels/allowlist.js";

test("isChannelIdentityAllowed allows all when allowlist is empty", () => {
  assert.equal(isChannelIdentityAllowed([], "any-user"), true);
});

test("isChannelIdentityAllowed matches id and username forms", () => {
  assert.equal(isChannelIdentityAllowed(["12345"], "12345"), true);
  assert.equal(isChannelIdentityAllowed(["@alice"], "alice"), true);
  assert.equal(isChannelIdentityAllowed(["@alice"], "123|alice"), true);
  assert.equal(isChannelIdentityAllowed(["12345|alice"], "12345|alice"), true);
  assert.equal(isChannelIdentityAllowed(["12345|alice"], "12345"), true);
  assert.equal(isChannelIdentityAllowed(["12345|alice"], "alice"), true);
});

test("isChannelIdentityAllowed denies unmatched identities", () => {
  assert.equal(isChannelIdentityAllowed(["99999", "@bob"], "123|alice"), false);
});
