import { readFile } from "node:fs/promises";
import path from "node:path";
import { guardArchitecture } from "./architecture-guard.mjs";
import { validateDod, validateCycle, validateSourceRegister } from "./workflow.mjs";

const root = process.cwd();
const dod = JSON.parse(await readFile(path.join(root, "docs/rebuild/DOD.json"), "utf8"));
const register = JSON.parse(await readFile(path.join(root, "docs/rebuild/SOURCE_REGISTER.json"), "utf8"));
const counts = await validateDod(root, dod);
const research = await validateSourceRegister(root, register);
await guardArchitecture(root, { requireRebuildImport: false });
const cycle = await validateCycle(root, JSON.parse(await readFile(path.join(root, ".agents/checkpoints/rebuild-cycle.json"), "utf8")), { dod, register });
console.log(JSON.stringify({ schemaVersion: 1, result: "passed", scope: "current-cycle", dod: counts, cycle, architecture: "passed", sourceCount: register.sources.length, research }, null, 2));
