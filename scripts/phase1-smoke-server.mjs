import http from "node:http";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.OMNIA_SMOKE_PORT ?? "18765", 10);

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("OMNIA_SMOKE_PORT must be an integer between 1024 and 65535");
}

function writeJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256 * 1024) {
      throw new Error("request_too_large");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function streamChat(response, requestBody) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const prompt = requestBody.messages?.at(-1)?.content ?? "";
  const cancellationRun = typeof prompt === "string" && prompt.toLowerCase().includes("cancel");
  const chunks = cancellationRun
    ? Array.from({ length: 80 }, (_, index) => `chunk-${index + 1} `)
    : ["Omnia ", "Phase 1 ", "local gateway smoke passed."];
  let index = 0;

  sse(response, {
    id: "chatcmpl-omnia-smoke",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });

  const timer = setInterval(() => {
    if (response.destroyed || response.writableEnded) {
      clearInterval(timer);
      return;
    }
    const text = chunks[index];
    if (text !== undefined) {
      sse(response, {
        id: "chatcmpl-omnia-smoke",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      });
      index += 1;
      return;
    }

    clearInterval(timer);
    sse(response, {
      id: "chatcmpl-omnia-smoke",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: cancellationRun ? chunks.length : 9,
        total_tokens: cancellationRun ? chunks.length + 12 : 21,
      },
    });
    response.write("data: [DONE]\n\n");
    response.end();
  }, cancellationRun ? 75 : 120);

  response.on("close", () => clearInterval(timer));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (request.method === "GET" && url.pathname === "/v1/models") {
    writeJson(response, 200, {
      object: "list",
      data: [
        {
          id: "omnia-smoke-model",
          object: "model",
          owned_by: "omnia-local-smoke",
        },
      ],
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    try {
      const body = await readJson(request);
      streamChat(response, body);
    } catch (error) {
      writeJson(response, error instanceof SyntaxError ? 400 : 413, {
        error: { message: "Invalid bounded smoke request" },
      });
    }
    return;
  }

  writeJson(response, 404, { error: { message: "Not found" } });
});

server.listen(port, host, () => {
  process.stdout.write(`OMNIA_SMOKE_READY http://${host}:${port}/v1\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
