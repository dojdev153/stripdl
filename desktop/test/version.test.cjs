const { test } = require("node:test");
const assert = require("node:assert/strict");

test("Electron package and lockfile use the target patch release", () => {
  assert.equal(require("../package.json").version, "0.3.2");
  assert.equal(require("../package-lock.json").version, "0.3.2");
  assert.equal(require("../package-lock.json").packages[""].version, "0.3.2");
});
