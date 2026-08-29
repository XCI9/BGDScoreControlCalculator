import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function findChrome() {
  const configuredPath = process.env.CHROME_PATH;
  const candidates = [
    configuredPath,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate));
}

function startStaticServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const requestedPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
      const filePath = path.resolve(projectRoot, `.${requestedPath}`);

      if (!filePath.startsWith(`${projectRoot}${path.sep}`)) {
        response.writeHead(403).end("Forbidden");
        return;
      }

      const fileStats = await stat(filePath);
      if (!fileStats.isFile()) throw new Error("Not a file");

      response.writeHead(200, {
        "Content-Type": mimeTypes.get(path.extname(filePath)) ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(await readFile(filePath));
    } catch {
      response.writeHead(404).end("Not found");
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function waitForDevToolsUrl(processHandle) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("Chrome DevTools did not start in time.")), 10_000);

    processHandle.stderr.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/u);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    });
    processHandle.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited before DevTools was ready (code ${code}).`));
    });
  });
}

async function connectToPage(browserWebSocketUrl, expectedUrl) {
  const debugOrigin = browserWebSocketUrl.replace(/^ws:/u, "http:").replace(/\/devtools\/browser\/.*$/u, "");

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const targets = await fetch(`${debugOrigin}/json/list`).then((response) => response.json());
    const page = targets.find((target) => target.type === "page" && target.url === expectedUrl);
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("No debuggable page target was found.");
}

function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 0;

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });

  return {
    ready: new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("Could not connect to Chrome DevTools.")), { once: true });
    }),
    send(method, params = {}) {
      const id = nextId + 1;
      nextId = id;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    const detail = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text;
    throw new Error(detail);
  }
  return response.result.value;
}

async function waitFor(client, expression, message) {
  let lastError;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if (await evaluate(client, expression)) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const detail = lastError ? ` Last browser error: ${lastError.message}` : "";
  throw new Error(`${message}${detail}`);
}

async function removeTemporaryProfile(profilePath) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(profilePath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "EBUSY" || attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const chromePath = findChrome();
if (!chromePath) {
  console.error("找不到 Chrome／Edge。可透過 CHROME_PATH 指定瀏覽器執行檔。");
  process.exitCode = 1;
} else {
  const server = await startStaticServer();
  const address = server.address();
  const siteUrl = `http://127.0.0.1:${address.port}/`;
  const profilePath = await mkdtemp(path.join(os.tmpdir(), "bgd-score-browser-"));
  const chrome = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-sandbox",
    "--remote-debugging-port=0",
    `--user-data-dir=${profilePath}`,
    siteUrl,
  ], { stdio: ["ignore", "ignore", "pipe"] });

  let client;
  try {
    const browserWebSocketUrl = await waitForDevToolsUrl(chrome);
    const pageWebSocketUrl = await connectToPage(browserWebSocketUrl, siteUrl);
    client = createCdpClient(pageWebSocketUrl);
    await client.ready;
    await client.send("Runtime.enable");
    await waitFor(client, "document.readyState === 'complete'", "Page did not finish loading.");
    await waitFor(client, "document.documentElement?.dataset.appReady === 'true'", "Application module did not initialize.");

    await evaluate(client, `(() => {
      const setValue = (selector, value) => {
        const element = document.querySelector(selector);
        element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setValue('#score-list', '100, 500');
      setValue('#current-score', '0');
      setValue('#target-score', '500');
      setValue('#max-games', '5');
      document.querySelector('#calculator-form').requestSubmit();
      return true;
    })()`);

    await waitFor(
      client,
      "!document.querySelector('#results-section').hidden",
      "The worker calculation did not produce results.",
    );

    const calculation = await evaluate(client, `({
      summary: document.querySelector('#results-summary').textContent,
      cards: document.querySelectorAll('.result-card').length,
      firstCard: document.querySelector('.result-card').textContent,
      errorHidden: document.querySelector('#form-error').hidden,
    })`);
    assert(calculation.summary.includes("找到 3 種精確打法"), "Expected three exact routes.");
    assert(calculation.cards === 3, "Expected three rendered result cards.");
    assert(calculation.firstCard.includes("1場數") && calculation.firstCard.includes("0體力"), "Game-first sorting is incorrect.");
    assert(calculation.errorHidden, "Unexpected form error after a valid calculation.");

    const routeTable = await evaluate(client, `({
      headings: [...document.querySelectorAll('.result-card:first-child .route-table th')].map((cell) => cell.textContent),
      cells: [...document.querySelectorAll('.result-card:first-child .route-table tbody td')].map((cell) => cell.textContent),
      highlighted: document.querySelectorAll('.result-card:first-child .route-number--highlight').length,
    })`);
    assert(
      routeTable.headings.join("|") === "使用分數設定|使用體力|場數|總分數",
      "Route table headings are incorrect.",
    );
    assert(routeTable.cells.join("|") === "500×1|0體|1場|500", "Route table values are incorrect.");
    assert(routeTable.highlighted === 3, "The first three route values should be highlighted.");

    if (process.env.SCREENSHOT_PATH) {
      await client.send("Page.enable");
      await client.send("Emulation.setDeviceMetricsOverride", {
        width: 1200,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const screenshot = await client.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
      });
      await writeFile(path.resolve(process.env.SCREENSHOT_PATH), screenshot.data, "base64");
    }

    await evaluate(client, "document.querySelector('[data-sort=\"stamina\"]').click()");
    const staminaCards = await evaluate(client, "[...document.querySelectorAll('.result-card')].map((card) => card.textContent)");
    assert(staminaCards[1].includes("5場數") && staminaCards[1].includes("0體力"), "Stamina-first sorting is incorrect.");

    await evaluate(client, `(() => {
      document.querySelector('#score-list').value = '1, 2, 3';
      document.querySelector('#current-score').value = '0';
      document.querySelector('#target-score').value = '30';
      document.querySelector('#max-games').value = '20';
      document.querySelector('#calculator-form').requestSubmit();
      return true;
    })()`);
    await waitFor(
      client,
      "document.querySelector('#results-summary').textContent.includes('找到 592 種精確打法')",
      "The paginated calculation did not finish.",
    );
    const firstPage = await evaluate(client, `({
      cards: document.querySelectorAll('.result-card').length,
      paginationHidden: document.querySelector('#pagination').hidden,
      pageStatus: document.querySelector('#page-status').textContent,
    })`);
    assert(firstPage.cards === 50, "Expected 50 cards on the first page.");
    assert(!firstPage.paginationHidden && firstPage.pageStatus.includes("1 / 12"), "Pagination state is incorrect.");
    await evaluate(client, "document.querySelector('#next-page').click()");
    const secondPageRank = await evaluate(client, "document.querySelector('.result-card__rank').textContent");
    assert(secondPageRank === "Route 51", "Next-page rendering is incorrect.");

    await evaluate(client, `(() => {
      document.querySelector('#current-score').value = '30';
      document.querySelector('#target-score').value = '30';
      document.querySelector('#calculator-form').requestSubmit();
      return true;
    })()`);
    const zeroDifference = await evaluate(client, "document.querySelector('.result-card').textContent");
    assert(zeroDifference.includes("0場數") && zeroDifference.includes("0體力"), "Zero-difference rendering is incorrect.");

    await evaluate(client, `(() => {
      document.querySelector('#score-list').value = Array.from({ length: 20 }, (_, index) => index + 1).join(',');
      document.querySelector('#current-score').value = '0';
      document.querySelector('#target-score').value = '200';
      document.querySelector('#max-games').value = '20';
      document.querySelector('#calculator-form').requestSubmit();
      document.querySelector('#cancel-button').click();
      return true;
    })()`);
    await waitFor(
      client,
      "document.querySelector('#form-error').textContent.includes('計算已取消')",
      "Worker cancellation did not complete.",
    );

    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    const mobileLayout = await evaluate(client, `({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    })`);
    assert(mobileLayout.viewport === 390, "Mobile viewport emulation failed.");
    assert(mobileLayout.content <= mobileLayout.viewport, "Mobile layout has horizontal overflow.");

    console.log("Browser smoke test passed: worker, cancellation, sorting, pagination and 390px layout.");
  } finally {
    await client?.send("Browser.close").catch(() => {});
    client?.close();
    if (chrome.exitCode === null) {
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 2_000);
        chrome.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        chrome.kill();
      });
    }
    await new Promise((resolve) => server.close(resolve));
    await removeTemporaryProfile(profilePath);
  }
}
