import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const workspace = process.cwd();
const capabilityPath = "src-tauri/capabilities/default.json";
const generatedCapabilitiesPath = "src-tauri/gen/schemas/capabilities.json";
const aclManifestsPath = "src-tauri/gen/schemas/acl-manifests.json";
const configPath = "src-tauri/tauri.conf.json";

const expectedPermissions = new Map([
  ["core:event:allow-listen", "listen"],
  ["core:event:allow-unlisten", "unlisten"],
  ["core:window:allow-internal-toggle-maximize", "internal_toggle_maximize"],
  ["core:window:allow-start-dragging", "start_dragging"],
  ["core:window:allow-minimize", "minimize"],
  ["core:window:allow-toggle-maximize", "toggle_maximize"],
  ["core:window:allow-close", "close"],
]);

function fail(message) {
  throw new Error(message);
}

async function readJson(relativePath) {
  const contents = await readFile(path.join(workspace, relativePath), "utf8");
  try {
    return JSON.parse(contents);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail(`${relativePath} is not valid JSON: ${reason}`);
  }
}

function assertExactKeys(label, value, expectedKeys) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }

  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} keys must be exactly [${expected.join(", ")}], received [${actual.join(", ")}].`);
  }
}

function assertExactArray(label, value, expectedValues) {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array.`);
  }

  const duplicates = value.filter((item, index) => value.indexOf(item) !== index);
  if (duplicates.length > 0) {
    fail(`${label} contains duplicate values: ${[...new Set(duplicates)].join(", ")}.`);
  }

  const actual = [...value].sort();
  const expected = [...expectedValues].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const unexpected = actual.filter((item) => !expected.includes(item));
    const missing = expected.filter((item) => !actual.includes(item));
    fail(
      `${label} does not match the reviewed allowlist. Missing: ${missing.join(", ") || "none"}. ` +
        `Unexpected: ${unexpected.join(", ") || "none"}.`,
    );
  }
}

export function assertCapability(label, capability, { generated }) {
  assertExactKeys(
    label,
    capability,
    generated
      ? ["description", "identifier", "local", "permissions", "webviews"]
      : ["$schema", "description", "identifier", "permissions", "webviews"],
  );

  if (capability.identifier !== "default") {
    fail(`${label}.identifier must be "default".`);
  }
  if (generated && capability.local !== true) {
    fail(`${label}.local must be true.`);
  }

  // A windows selector also grants permissions to every child webview in that
  // window. Match only the trusted main document, independent of child origins.
  assertExactArray(`${label}.webviews`, capability.webviews, ["main"]);
  assertExactArray(`${label}.permissions`, capability.permissions, expectedPermissions.keys());
}

function directiveSources(label, csp, directive) {
  if (typeof csp !== "string") fail(`${label} must be a CSP string.`);
  const matches = csp.split(";")
    .map((part) => part.trim().split(/\s+/))
    .filter(([name]) => name.toLowerCase() === directive);
  if (matches.length !== 1) fail(`${label} must contain exactly one ${directive} directive.`);
  return matches[0].slice(1);
}

export function assertFramePolicies(config) {
  const security = config?.app?.security;
  const artifactSources = ["http://omnia-artifact.localhost", "omnia-artifact:"];
  assertExactArray(
    `${configPath}.app.security.csp frame-src`,
    directiveSources("release CSP", security?.csp, "frame-src"),
    artifactSources,
  );
  assertExactArray(
    `${configPath}.app.security.devCsp frame-src`,
    directiveSources("development CSP", security?.devCsp, "frame-src"),
    [...artifactSources, "http://127.0.0.1:1430"],
  );
}

function resolvePermission(aclManifests, identifier) {
  const separator = identifier.lastIndexOf(":");
  if (separator < 0) fail(`Invalid permission identifier ${identifier}.`);

  const plugin = identifier.slice(0, separator);
  const permission = identifier.slice(separator + 1);
  const manifest = aclManifests[plugin];
  if (typeof manifest !== "object" || manifest === null) {
    fail(`${aclManifestsPath} does not contain plugin ${plugin}.`);
  }

  const definition = manifest.permissions?.[permission];
  if (typeof definition !== "object" || definition === null) {
    fail(`${aclManifestsPath} does not define ${identifier}.`);
  }
  return definition;
}

export async function checkTauriAcl() {
  const [capability, generatedCapabilities, aclManifests, config] = await Promise.all([
    readJson(capabilityPath),
    readJson(generatedCapabilitiesPath),
    readJson(aclManifestsPath),
    readJson(configPath),
  ]);

  assertCapability(capabilityPath, capability, { generated: false });
  assertFramePolicies(config);
  assertExactKeys(generatedCapabilitiesPath, generatedCapabilities, ["default"]);
  assertCapability(`${generatedCapabilitiesPath}.default`, generatedCapabilities.default, {
    generated: true,
  });

  assertExactArray(
    "source/generated permission synchronization",
    generatedCapabilities.default.permissions,
    capability.permissions,
  );

  for (const [identifier, expectedCommand] of expectedPermissions) {
    const definition = resolvePermission(aclManifests, identifier);
    assertExactArray(`${identifier}.commands.allow`, definition.commands?.allow, [expectedCommand]);
    assertExactArray(`${identifier}.commands.deny`, definition.commands?.deny, []);
  }

  process.stdout.write(
    `Tauri renderer ACL OK: one main-webview capability, ${expectedPermissions.size} reviewed permissions; release/development frame policies checked.\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await checkTauriAcl();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Tauri renderer ACL check failed: ${reason}\n`);
    process.exitCode = 1;
  }
}
