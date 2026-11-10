import process from "node:process";

const host = process.env.OMNIA_PREVIEW_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.OMNIA_PREVIEW_PORT ?? "1420", 10);
const url = `http://${host}:${port}/`;

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  process.stderr.write("OMNIA_SMOKE_ERROR invalid preview port\n");
  process.exitCode = 1;
} else {
  try {
    const response = await fetch(url, { redirect: "manual" });
    const body = await response.text();
    const hasOmnia = /omnia/i.test(body);
    const hasHmr = /vite|@vite\/client/i.test(body);
    if (!response.ok || !hasOmnia) {
      process.stderr.write(`OMNIA_SMOKE_ERROR ${url} status=${response.status} omnia=${hasOmnia}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`OMNIA_SMOKE_OK ${url} status=${response.status} omnia=${hasOmnia} hmr=${hasHmr}\n`);
    }
  } catch (error) {
    process.stderr.write(`OMNIA_SMOKE_ERROR ${url} ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
