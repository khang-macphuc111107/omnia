import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { advanceCycle, createCycle, validateCycle } from "./workflow.mjs";

const root = process.cwd();
const argv = process.argv.slice(2);
const get = (name, fallback = null) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? fallback : fallback;
};
const has = (name) => argv.includes(name);
const json = async (relative) => JSON.parse(await readFile(path.resolve(root, relative), "utf8"));
const save = async (relative, value) => {
  const target = path.resolve(root, relative);
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
};
const cyclePath = get("--cycle", ".agents/checkpoints/rebuild-cycle.json");
const dod = await json("docs/rebuild/DOD.json");
const register = await json("docs/rebuild/SOURCE_REGISTER.json");

if (has("--new")) {
  const criteria = argv.filter((value, index) => argv[index - 1] === "--criterion");
  if (!criteria.length) throw new Error("--new requires one or more --criterion IDs");
  const cycle = await createCycle(root, {
    id: get("--id", `rebuild-${Date.now()}`),
    author: get("--author", process.env.USERNAME || "unknown"),
    criteria, register, revision: get("--revision"),
  });
  await save(cyclePath, cycle);
  console.log(JSON.stringify({ result: "created", path: cyclePath, stage: cycle.stage, generation: cycle.generation }, null, 2));
} else {
  const cycle = await json(cyclePath);
  if (has("--validate")) {
    const result = await validateCycle(root, cycle, { dod, register }, { milestone: has("--milestone") });
    console.log(JSON.stringify({ result: "passed", path: cyclePath, ...result }, null, 2));
  } else if (has("--advance") || has("--cancel") || has("--failure")) {
    const event = has("--cancel") ? "cancel" : has("--failure") ? "failure" : "advance";
    const next = await advanceCycle(root, cycle, {
      to: get("--advance"), event, reason: get("--reason"),
    }, { dod, register });
    await save(cyclePath, next);
    console.log(JSON.stringify({ result: "advanced", path: cyclePath, stage: next.stage, status: next.status, generation: next.generation }, null, 2));
  } else {
    throw new Error("Use --new, --validate, --advance <stage>, --failure or --cancel");
  }
}
