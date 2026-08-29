import {
  buildActions,
  createResultOrder,
  DEFAULT_RESULT_LIMIT,
  enumerateCombinationEvents,
} from "./solver.js";

let activeTask = null;

function postProgress(requestId, found, explored) {
  self.postMessage({ type: "progress", requestId, found, explored });
}

async function runSearch(message, task) {
  const {
    requestId,
    scores,
    difference,
    maxGames,
    resultLimit = DEFAULT_RESULT_LIMIT,
  } = message;

  const actions = buildActions(scores);
  const iterator = enumerateCombinationEvents({ scores, difference, maxGames, resultLimit });
  const results = [];
  let explored = 0;
  let lastProgressAt = 0;

  try {
    while (!task.cancelled) {
      const chunkStartedAt = performance.now();
      let next;

      do {
        next = iterator.next();
        if (next.done) break;

        if (next.value.type === "result") {
          results.push(next.value.result);
        } else {
          explored = next.value.explored;
        }
      } while (performance.now() - chunkStartedAt < 14);

      const now = performance.now();
      if (now - lastProgressAt >= 100) {
        postProgress(requestId, results.length, explored);
        lastProgressAt = now;
      }

      if (next.done) {
        const gamesOrder = createResultOrder(results, "games");
        const staminaOrder = createResultOrder(results, "stamina");
        const { actions: unusedActions, ...stats } = next.value;
        self.postMessage({
          type: "complete",
          requestId,
          actions,
          results,
          gamesOrder,
          staminaOrder,
          stats,
        }, [gamesOrder.buffer, staminaOrder.buffer]);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    iterator.return?.();
    self.postMessage({ type: "cancelled", requestId });
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId,
      message: error instanceof Error ? error.message : "計算時發生未知錯誤。",
    });
  } finally {
    if (activeTask === task) activeTask = null;
  }
}

self.addEventListener("message", (event) => {
  const message = event.data;

  if (message.type === "cancel") {
    if (activeTask?.requestId === message.requestId) activeTask.cancelled = true;
    return;
  }

  if (message.type !== "search") return;

  if (activeTask) activeTask.cancelled = true;
  const task = { requestId: message.requestId, cancelled: false };
  activeTask = task;
  runSearch(message, task);
});
