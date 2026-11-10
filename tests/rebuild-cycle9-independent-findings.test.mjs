import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("ask-user UI gates free-text submission by the native capability", () => {
  const source = readFileSync(join(root, "src", "rebuild", "chat", "chat-view.tsx"), "utf8");
  assert.match(
    source,
    /allowFreeText/,
    "ChatView must read allowFreeText before rendering or submitting the free-text answer",
  );
  assert.match(
    source,
    /question\.allowFreeText\s*!==\s*false|question\.allowFreeText\s*===\s*true/,
    "ChatView must fail closed when native ask-user metadata disallows free text",
  );
});
