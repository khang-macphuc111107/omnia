import { EventBridge } from './index.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--input' && i + 1 < argv.length) {
      args.input = argv[++i];
    } else if (token === '--output' && i + 1 < argv.length) {
      args.output = argv[++i];
    } else if (token === '--lock' && i + 1 < argv.length) {
      args.lock = argv[++i];
    } else if (token === '--config' && i + 1 < argv.length) {
      args.config = argv[++i];
    } else if (token === '--batch-size' && i + 1 < argv.length) {
      args.batchSize = Number(argv[++i]);
    } else {
      throw new Error(`Unknown or incomplete argument: ${token}`);
    }
  }
  if (!args.input || !args.output) {
    throw new Error('Usage: node src/cli.mjs --input <jsonl> --output <jsonl> [--lock <path>] [--config <path>] [--batch-size <n>]');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bridge = new EventBridge({
    configPath: args.config,
    lockPath: args.lock,
    outputPath: args.output,
    batchSize: args.batchSize,
  });

  await bridge.start();
  try {
    const count = await bridge.processFile(args.input);
    process.stdout.write(JSON.stringify({ processed: count, output: args.output }) + '\n');
  } finally {
    await bridge.stop();
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exitCode = 1;
});
