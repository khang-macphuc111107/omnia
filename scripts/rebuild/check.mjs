import { readFile } from "node:fs/promises";
import path from "node:path";
import { guardArchitecture } from "./architecture-guard.mjs";
import { validateDod, validateCycle, validateSourceRegister } from "./workflow.mjs";

const root = process.cwd();
const complete = process.argv.includes("--complete");
const structuralOnly = process.argv.includes("--structural-only");
const milestone = process.argv.includes("--milestone");
if (structuralOnly && (complete || milestone)) throw new Error("Structural-only diagnostics cannot claim completion or milestone eligibility");
const read = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));

const dod = await read("docs/rebuild/DOD.json");
const register = await read("docs/rebuild/SOURCE_REGISTER.json");
const counts = await validateDod(root, dod, { complete, skipEvidence: structuralOnly });
const research = await validateSourceRegister(root, register);
const architecture = await guardArchitecture(root, { requireRebuildImport: false });
const cycle = structuralOnly ? null : await validateCycle(root, await read(".agents/checkpoints/rebuild-cycle.json"), { dod, register }, { milestone });
console.log(JSON.stringify({ schemaVersion: 1, result: "passed", scope: structuralOnly ? "structural-only" : "current-cycle", complete, dod: counts, cycle, architecture, sourceCount: register.sources.length, research }, null, 2));
