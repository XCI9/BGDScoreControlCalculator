import {
  CalculatorInputError,
  DEFAULT_RESULT_LIMIT,
  normalizeCalculatorInput,
} from "./solver.js";

const PAGE_SIZE = 50;
const numberFormatter = new Intl.NumberFormat("zh-TW");

const elements = {
  form: document.querySelector("#calculator-form"),
  scoreList: document.querySelector("#score-list"),
  currentScore: document.querySelector("#current-score"),
  targetScore: document.querySelector("#target-score"),
  maxGames: document.querySelector("#max-games"),
  differencePreview: document.querySelector("#difference-preview"),
  formError: document.querySelector("#form-error"),
  calculateButton: document.querySelector("#calculate-button"),
  cancelButton: document.querySelector("#cancel-button"),
  searchStatus: document.querySelector("#search-status"),
  progressCopy: document.querySelector("#progress-copy"),
  resultsSection: document.querySelector("#results-section"),
  resultsSummary: document.querySelector("#results-summary"),
  resultWarning: document.querySelector("#result-warning"),
  resultEmpty: document.querySelector("#result-empty"),
  resultList: document.querySelector("#result-list"),
  pagination: document.querySelector("#pagination"),
  previousPage: document.querySelector("#previous-page"),
  nextPage: document.querySelector("#next-page"),
  pageStatus: document.querySelector("#page-status"),
  sortControl: document.querySelector(".sort-control"),
  sortButtons: [...document.querySelectorAll("[data-sort]")],
};

const state = {
  worker: null,
  requestId: 0,
  busy: false,
  input: null,
  actions: [],
  results: [],
  orders: {
    games: new Uint32Array(),
    stamina: new Uint32Array(),
  },
  sortMode: "games",
  page: 1,
};

function formatNumber(value) {
  return numberFormatter.format(value);
}

function setError(message = "") {
  elements.formError.textContent = message;
  elements.formError.hidden = !message;
}

function setBusy(isBusy) {
  state.busy = isBusy;
  elements.calculateButton.disabled = isBusy;
  elements.cancelButton.hidden = !isBusy;
  elements.cancelButton.disabled = false;
  elements.cancelButton.textContent = "取消計算";
  elements.searchStatus.hidden = !isBusy;
}

function readPreviewInteger(input) {
  const text = input.value.trim();
  if (!/^\d+$/u.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function updateDifferencePreview() {
  const current = readPreviewInteger(elements.currentScore);
  const target = readPreviewInteger(elements.targetScore);

  if (current === null || target === null) {
    elements.differencePreview.textContent = "—";
  } else if (current > target) {
    elements.differencePreview.textContent = "已超過目標";
  } else {
    elements.differencePreview.textContent = `${formatNumber(target - current)} 分`;
  }
}

function ensureWorker() {
  if (state.worker) return state.worker;

  const worker = new Worker(new URL("./solver.worker.js", import.meta.url), { type: "module" });
  worker.addEventListener("message", handleWorkerMessage);
  worker.addEventListener("error", () => {
    if (!state.busy) return;
    setBusy(false);
    setError("背景計算器無法啟動，請重新整理頁面後再試一次。");
  });
  state.worker = worker;
  return worker;
}

function resetResults() {
  state.actions = [];
  state.results = [];
  state.orders.games = new Uint32Array();
  state.orders.stamina = new Uint32Array();
  state.page = 1;
  elements.resultsSection.hidden = true;
  elements.resultWarning.hidden = true;
  elements.resultList.replaceChildren();
}

function showZeroDifference() {
  state.actions = [];
  state.results = [{ games: 0, stamina: 0, entries: [] }];
  state.orders.games = Uint32Array.of(0);
  state.orders.stamina = Uint32Array.of(0);
  state.page = 1;

  elements.resultsSummary.textContent = "分差 0 分・你已經抵達目標，不需要再進行遊戲。";
  elements.resultWarning.hidden = true;
  elements.resultEmpty.hidden = true;
  elements.sortControl.hidden = true;
  elements.resultsSection.hidden = false;
  renderResults();
  revealResults();
}

function startCalculation(event) {
  event.preventDefault();
  setError();

  let input;
  try {
    input = normalizeCalculatorInput({
      scoreText: elements.scoreList.value,
      currentScore: elements.currentScore.value,
      targetScore: elements.targetScore.value,
      maxGames: elements.maxGames.value,
    });
  } catch (error) {
    if (error instanceof CalculatorInputError) {
      setError(error.message);
      return;
    }
    throw error;
  }

  resetResults();
  state.input = input;
  elements.differencePreview.textContent = `${formatNumber(input.difference)} 分`;

  if (input.difference === 0) {
    showZeroDifference();
    return;
  }

  const requestId = state.requestId + 1;
  state.requestId = requestId;
  elements.progressCopy.textContent = "已找到 0 筆";
  setBusy(true);

  ensureWorker().postMessage({
    type: "search",
    requestId,
    scores: [...input.scores],
    difference: input.difference,
    maxGames: input.maxGames,
    resultLimit: DEFAULT_RESULT_LIMIT,
  });
}

function cancelCalculation() {
  if (!state.busy || !state.worker) return;
  elements.cancelButton.disabled = true;
  elements.cancelButton.textContent = "正在取消…";
  state.worker.postMessage({ type: "cancel", requestId: state.requestId });
}

function handleWorkerMessage(event) {
  const message = event.data;
  if (message.requestId !== state.requestId) return;

  if (message.type === "progress") {
    elements.progressCopy.textContent = `已找到 ${formatNumber(message.found)} 筆・檢查 ${formatNumber(message.explored)} 個分支`;
    return;
  }

  if (message.type === "cancelled") {
    setBusy(false);
    setError("計算已取消。你可以縮小最多場數或調整輸入後重新計算。");
    return;
  }

  if (message.type === "error") {
    setBusy(false);
    setError(`計算失敗：${message.message}`);
    return;
  }

  if (message.type !== "complete") return;

  setBusy(false);
  state.actions = message.actions;
  state.results = message.results;
  state.orders.games = message.gamesOrder;
  state.orders.stamina = message.staminaOrder;
  state.page = 1;

  const count = state.results.length;
  elements.resultsSummary.textContent = `分差 ${formatNumber(state.input.difference)} 分・找到 ${formatNumber(count)} 種精確打法・限制 ${state.input.maxGames} 場內`;
  elements.sortControl.hidden = count <= 1;
  elements.resultEmpty.hidden = count !== 0;
  elements.resultWarning.hidden = !message.stats.limitReached;
  elements.resultWarning.textContent = message.stats.limitReached
    ? `搜尋已達 ${formatNumber(DEFAULT_RESULT_LIMIT)} 筆安全上限，可能還有其他打法未列出。請縮小最多場數以取得完整結果。`
    : "";
  elements.resultsSection.hidden = false;

  renderResults();
  revealResults();
}

function revealResults() {
  window.requestAnimationFrame(() => {
    const top = elements.resultsSection.getBoundingClientRect().top;
    if (top > window.innerHeight * 0.7) {
      elements.resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
}

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function createMetric(value, label) {
  const metric = createElement("div", "metric");
  metric.append(createElement("strong", "", formatNumber(value)), createElement("span", "", label));
  return metric;
}

function createRouteRow(action, count) {
  const row = document.createElement("tr");
  const settingCell = document.createElement("td");
  settingCell.dataset.label = "使用分數設定";
  settingCell.className = "route-table__setting";
  settingCell.append(
    createElement("strong", "route-number route-number--highlight", formatNumber(action.baseScore)),
    createElement("span", "multiplier-tag", `×${action.multiplier}`),
  );

  const staminaCell = document.createElement("td");
  staminaCell.dataset.label = "使用體力";
  staminaCell.append(
    createElement("strong", "route-number route-number--highlight", formatNumber(action.stamina)),
    createElement("span", "route-unit", "體"),
  );

  const countCell = document.createElement("td");
  countCell.dataset.label = "場數";
  countCell.append(
    createElement("strong", "route-number route-number--highlight", formatNumber(count)),
    createElement("span", "route-unit", "場"),
  );

  const totalCell = document.createElement("td");
  totalCell.dataset.label = "總分數";
  totalCell.className = "route-table__total";
  totalCell.textContent = formatNumber(action.score * count);

  row.append(settingCell, staminaCell, countCell, totalCell);
  return row;
}

function createRouteTable(displayEntries) {
  const table = createElement("table", "route-table");
  const header = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const label of ["使用分數設定", "使用體力", "場數", "總分數"]) {
    headerRow.append(createElement("th", "", label));
  }
  header.append(headerRow);

  const body = document.createElement("tbody");
  for (const { action, count } of displayEntries) {
    body.append(createRouteRow(action, count));
  }
  table.append(header, body);
  return table;
}

function createResultCard(result, rank) {
  const card = createElement("article", "result-card");
  card.setAttribute("aria-label", `第 ${rank} 個打法，${result.games} 場，${result.stamina} 體`);

  const summary = createElement("div", "result-card__summary");
  const metrics = createElement("div", "result-card__metrics");
  metrics.append(createMetric(result.games, "場數"), createMetric(result.stamina, "體力"));
  summary.append(createElement("span", "result-card__rank", `Route ${String(rank).padStart(2, "0")}`), metrics);

  const routes = createElement("div", "result-card__routes");
  if (result.entries.length === 0) {
    routes.append(createElement("p", "zero-route", "目前分數已等於目標分數，不需要安排場次。"));
  } else {
    const displayEntries = result.entries
      .map(([actionIndex, count]) => ({ action: state.actions[actionIndex], count }))
      .sort((left, right) => (
        left.action.baseScore - right.action.baseScore
        || left.action.multiplier - right.action.multiplier
      ));

    routes.append(createRouteTable(displayEntries));
  }

  card.append(summary, routes);
  return card;
}

function renderResults() {
  const order = state.orders[state.sortMode];
  const totalResults = order.length;
  const totalPages = Math.max(1, Math.ceil(totalResults / PAGE_SIZE));
  state.page = Math.min(Math.max(1, state.page), totalPages);

  const startIndex = (state.page - 1) * PAGE_SIZE;
  const endIndex = Math.min(startIndex + PAGE_SIZE, totalResults);
  const cards = [];

  for (let orderIndex = startIndex; orderIndex < endIndex; orderIndex += 1) {
    const resultIndex = order[orderIndex];
    cards.push(createResultCard(state.results[resultIndex], orderIndex + 1));
  }

  elements.resultList.replaceChildren(...cards);
  elements.pagination.hidden = totalResults <= PAGE_SIZE;
  elements.previousPage.disabled = state.page === 1;
  elements.nextPage.disabled = state.page === totalPages;
  elements.pageStatus.textContent = `第 ${formatNumber(state.page)} / ${formatNumber(totalPages)} 頁`;
}

function changeSortMode(event) {
  const mode = event.currentTarget.dataset.sort;
  if (mode === state.sortMode) return;

  state.sortMode = mode;
  state.page = 1;
  for (const button of elements.sortButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.sort === mode));
  }
  renderResults();
}

function changePage(direction) {
  state.page += direction;
  renderResults();
  elements.resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

elements.form.addEventListener("submit", startCalculation);
elements.cancelButton.addEventListener("click", cancelCalculation);
elements.currentScore.addEventListener("input", updateDifferencePreview);
elements.targetScore.addEventListener("input", updateDifferencePreview);
elements.previousPage.addEventListener("click", () => changePage(-1));
elements.nextPage.addEventListener("click", () => changePage(1));
for (const button of elements.sortButtons) button.addEventListener("click", changeSortMode);
document.documentElement.dataset.appReady = "true";
