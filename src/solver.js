export const MAX_SCORE_TYPES = 20;
export const MAX_GAMES = 20;
export const DEFAULT_RESULT_LIMIT = 100_000;
export const SORT_METRICS = Object.freeze(["games", "stamina", "scoreTypes"]);
export const SORT_PRIORITY_PERMUTATIONS = Object.freeze([
  Object.freeze(["games", "stamina", "scoreTypes"]),
  Object.freeze(["games", "scoreTypes", "stamina"]),
  Object.freeze(["stamina", "games", "scoreTypes"]),
  Object.freeze(["stamina", "scoreTypes", "games"]),
  Object.freeze(["scoreTypes", "games", "stamina"]),
  Object.freeze(["scoreTypes", "stamina", "games"]),
]);

export const MULTIPLIER_RULES = Object.freeze([
  Object.freeze({ multiplier: 1, stamina: 0 }),
  Object.freeze({ multiplier: 5, stamina: 1 }),
  Object.freeze({ multiplier: 10, stamina: 2 }),
  Object.freeze({ multiplier: 15, stamina: 3 }),
]);

export class CalculatorInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CalculatorInputError";
    this.code = code;
  }
}

function parseSafeInteger(rawValue, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const text = String(rawValue ?? "").trim();

  if (!/^\d+$/u.test(text)) {
    throw new CalculatorInputError("INVALID_INTEGER", `${label}必須是整數。`);
  }

  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    const range = maximum === Number.MAX_SAFE_INTEGER
      ? `${minimum} 以上的安全整數`
      : `${minimum}～${maximum} 的整數`;
    throw new CalculatorInputError("INTEGER_OUT_OF_RANGE", `${label}必須是${range}。`);
  }

  return value;
}

export function parseScoreList(rawScores) {
  const text = String(rawScores ?? "").trim();
  if (!text) {
    throw new CalculatorInputError("EMPTY_SCORES", "請至少輸入一個可打出的分數。");
  }

  const tokens = text.split(/[\s,，]+/u).filter(Boolean);
  const uniqueScores = new Set();

  for (const token of tokens) {
    const score = parseSafeInteger(token, `分數「${token}」`, { minimum: 1 });
    if (!Number.isSafeInteger(score * 15)) {
      throw new CalculatorInputError(
        "SCORE_MULTIPLICATION_OVERFLOW",
        `分數「${token}」乘以 15 後超出安全整數範圍。`,
      );
    }
    uniqueScores.add(score);
  }

  if (uniqueScores.size > MAX_SCORE_TYPES) {
    throw new CalculatorInputError(
      "TOO_MANY_SCORES",
      `最多只能輸入 ${MAX_SCORE_TYPES} 種不同分數，目前共有 ${uniqueScores.size} 種。`,
    );
  }

  return [...uniqueScores].sort((left, right) => left - right);
}

export function normalizeCalculatorInput({ scoreText, currentScore, targetScore, maxGames }) {
  const scores = parseScoreList(scoreText);
  const current = parseSafeInteger(currentScore, "目前分數", { minimum: 0 });
  const target = parseSafeInteger(targetScore, "目標分數", { minimum: 0 });
  const games = parseSafeInteger(maxGames, "最多場數", { minimum: 1, maximum: MAX_GAMES });

  if (current > target) {
    throw new CalculatorInputError("CURRENT_OVER_TARGET", "目前分數已高於目標分數，無法計算正向分差。");
  }

  return Object.freeze({
    scores: Object.freeze(scores),
    currentScore: current,
    targetScore: target,
    difference: target - current,
    maxGames: games,
  });
}

function greatestCommonDivisor(left, right) {
  let a = left;
  let b = right;
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

export function buildActions(scores) {
  const actions = scores.flatMap((baseScore) => MULTIPLIER_RULES.map(({ multiplier, stamina }) => ({
    baseScore,
    multiplier,
    stamina,
    score: baseScore * multiplier,
  })));

  actions.sort((left, right) => (
    left.score - right.score
    || left.baseScore - right.baseScore
    || left.multiplier - right.multiplier
  ));

  return actions.map((action, index) => Object.freeze({ ...action, index }));
}

function makeResult(selectedEntries, actions) {
  let games = 0;
  let stamina = 0;
  const scoreTypeValues = new Set();
  const entries = selectedEntries.map(([actionIndex, count]) => {
    const action = actions[actionIndex];
    games += count;
    stamina += action.stamina * count;
    scoreTypeValues.add(action.baseScore);
    return Object.freeze([actionIndex, count]);
  });

  return Object.freeze({
    games,
    stamina,
    scoreTypes: scoreTypeValues.size,
    entries: Object.freeze(entries),
  });
}

/**
 * Enumerates exact, order-independent combinations.
 *
 * The generator yields checkpoints as well as results so a Web Worker can give
 * control back to its event loop. Its final return value contains search stats.
 */
export function* enumerateCombinationEvents({
  scores,
  difference,
  maxGames,
  resultLimit = DEFAULT_RESULT_LIMIT,
  checkpointInterval = 2_048,
}) {
  if (!Number.isSafeInteger(difference) || difference <= 0) {
    throw new TypeError("difference must be a positive safe integer");
  }
  if (!Number.isInteger(maxGames) || maxGames < 1 || maxGames > MAX_GAMES) {
    throw new TypeError(`maxGames must be between 1 and ${MAX_GAMES}`);
  }
  if (!Number.isInteger(resultLimit) || resultLimit < 1) {
    throw new TypeError("resultLimit must be a positive integer");
  }

  const actions = buildActions(scores);
  const actionCount = actions.length;
  const suffixGreatestCommonDivisor = new Array(actionCount);
  const suffixMaximumScore = new Array(actionCount);
  const deadStates = new Set();
  const selectedEntries = [];

  let suffixGcd = 0;
  let suffixMax = 0;
  for (let index = actionCount - 1; index >= 0; index -= 1) {
    suffixGcd = greatestCommonDivisor(suffixGcd, actions[index].score);
    suffixMax = Math.max(suffixMax, actions[index].score);
    suffixGreatestCommonDivisor[index] = suffixGcd;
    suffixMaximumScore[index] = suffixMax;
  }

  let explored = 0;
  let found = 0;
  let limitReached = false;

  function canReach(startIndex, remaining, slotsLeft) {
    if (startIndex >= actionCount || slotsLeft <= 0) return false;
    if (actions[startIndex].score > remaining) return false;
    if (Math.ceil(remaining / suffixMaximumScore[startIndex]) > slotsLeft) return false;
    return remaining % suffixGreatestCommonDivisor[startIndex] === 0;
  }

  function* search(startIndex, remaining, slotsLeft) {
    const stateKey = `${startIndex}|${remaining}|${slotsLeft}`;
    if (deadStates.has(stateKey) || !canReach(startIndex, remaining, slotsLeft)) return;

    const foundBeforeState = found;

    for (let actionIndex = startIndex; actionIndex < actionCount; actionIndex += 1) {
      const action = actions[actionIndex];
      if (action.score > remaining || limitReached) break;

      const maximumCount = Math.min(slotsLeft, Math.floor(remaining / action.score));
      for (let count = 1; count <= maximumCount; count += 1) {
        explored += 1;
        if (explored % checkpointInterval === 0) {
          yield Object.freeze({ type: "checkpoint", explored, found });
        }

        const nextRemaining = remaining - action.score * count;
        const nextSlots = slotsLeft - count;
        selectedEntries.push([actionIndex, count]);

        if (nextRemaining === 0) {
          found += 1;
          yield Object.freeze({ type: "result", result: makeResult(selectedEntries, actions) });
          if (found >= resultLimit) limitReached = true;
        } else if (!limitReached && canReach(actionIndex + 1, nextRemaining, nextSlots)) {
          yield* search(actionIndex + 1, nextRemaining, nextSlots);
        }

        selectedEntries.pop();
        if (limitReached) break;
      }
    }

    if (found === foundBeforeState && !limitReached) deadStates.add(stateKey);
  }

  if (actions.length > 0 && canReach(0, difference, maxGames)) {
    yield* search(0, difference, maxGames);
  }

  return Object.freeze({
    actions,
    explored,
    found,
    limitReached,
    deadStateCount: deadStates.size,
  });
}

export function solveExactCombinations(options) {
  const results = [];
  const iterator = enumerateCombinationEvents(options);
  let next = iterator.next();

  while (!next.done) {
    if (next.value.type === "result") results.push(next.value.result);
    next = iterator.next();
  }

  return Object.freeze({ ...next.value, results: Object.freeze(results) });
}

function compareEntries(leftEntries, rightEntries) {
  const sharedLength = Math.min(leftEntries.length, rightEntries.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const actionDifference = leftEntries[index][0] - rightEntries[index][0];
    if (actionDifference !== 0) return actionDifference;
    const countDifference = leftEntries[index][1] - rightEntries[index][1];
    if (countDifference !== 0) return countDifference;
  }
  return leftEntries.length - rightEntries.length;
}

function normalizeSortPriorities(priorities) {
  if (typeof priorities === "string") {
    if (!SORT_METRICS.includes(priorities)) throw new TypeError(`Unknown sort metric: ${priorities}`);
    return [priorities, ...SORT_METRICS.filter((metric) => metric !== priorities)];
  }

  if (
    !Array.isArray(priorities)
    || priorities.length !== SORT_METRICS.length
    || new Set(priorities).size !== SORT_METRICS.length
    || priorities.some((metric) => !SORT_METRICS.includes(metric))
  ) {
    throw new TypeError("Sort priorities must contain games, stamina and scoreTypes exactly once.");
  }

  return priorities;
}

export function getSortOrderKey(priorities) {
  return normalizeSortPriorities(priorities).join("-");
}

function compareResultsWithNormalizedPriorities(left, right, normalizedPriorities) {
  for (const metric of normalizedPriorities) {
    const difference = left[metric] - right[metric];
    if (difference !== 0) return difference;
  }
  return compareEntries(left.entries, right.entries);
}

export function compareResults(left, right, priorities = SORT_METRICS) {
  return compareResultsWithNormalizedPriorities(left, right, normalizeSortPriorities(priorities));
}

export function createResultOrder(results, priorities = SORT_METRICS) {
  const normalizedPriorities = normalizeSortPriorities(priorities);
  const indexes = Uint32Array.from({ length: results.length }, (_, index) => index);
  indexes.sort((leftIndex, rightIndex) => compareResultsWithNormalizedPriorities(
    results[leftIndex],
    results[rightIndex],
    normalizedPriorities,
  ));
  return indexes;
}
