import assert from "node:assert/strict";
import test from "node:test";

import {
  CalculatorInputError,
  compareResults,
  createResultOrder,
  normalizeCalculatorInput,
  parseScoreList,
  solveExactCombinations,
} from "../src/solver.js";

function findOnlyResult(options) {
  const solution = solveExactCombinations(options);
  assert.equal(solution.results.length, 1);
  return solution.results[0];
}

test("parseScoreList accepts supported separators, sorts and removes duplicates", () => {
  assert.deepEqual(parseScoreList("300, 100，200\n100\t300"), [100, 200, 300]);
});

test("normalizeCalculatorInput calculates the difference", () => {
  const input = normalizeCalculatorInput({
    scoreText: "100 200",
    currentScore: "1200",
    targetScore: "1500",
    maxGames: "4",
  });

  assert.deepEqual(input.scores, [100, 200]);
  assert.equal(input.difference, 300);
  assert.equal(input.maxGames, 4);
});

test("each multiplier produces the expected score and stamina", () => {
  const cases = [
    { difference: 100, multiplier: 1, stamina: 0 },
    { difference: 500, multiplier: 5, stamina: 1 },
    { difference: 1000, multiplier: 10, stamina: 2 },
    { difference: 1500, multiplier: 15, stamina: 3 },
  ];

  for (const expected of cases) {
    const result = findOnlyResult({ scores: [100], difference: expected.difference, maxGames: 1 });
    assert.equal(result.games, 1);
    assert.equal(result.stamina, expected.stamina);
  }
});

test("the same base score can be repeated up to the game limit", () => {
  const result = findOnlyResult({ scores: [100], difference: 400, maxGames: 4 });
  assert.equal(result.games, 4);
  assert.equal(result.stamina, 0);
  assert.deepEqual(result.entries.map((entry) => [...entry]), [[0, 4]]);
});

test("different play order does not create duplicate combinations", () => {
  const solution = solveExactCombinations({ scores: [100, 200], difference: 300, maxGames: 2 });
  assert.equal(solution.results.length, 1);
  assert.equal(solution.results[0].games, 2);
});

test("different multiplier routes are retained", () => {
  const solution = solveExactCombinations({ scores: [100, 500], difference: 500, maxGames: 5 });
  const costs = solution.results.map(({ games, stamina }) => `${games}:${stamina}`);

  assert.ok(costs.includes("1:0"));
  assert.ok(costs.includes("1:1"));
  assert.ok(costs.includes("5:0"));
});

test("score type count uses distinct base scores and ignores multiplier differences", () => {
  const singleBase = solveExactCombinations({ scores: [100], difference: 600, maxGames: 2 });
  assert.ok(singleBase.results.length > 0);
  assert.ok(singleBase.results.every((result) => result.scoreTypes === 1));

  const mixedBases = solveExactCombinations({ scores: [100, 200], difference: 300, maxGames: 2 });
  assert.equal(mixedBases.results[0].scoreTypes, 2);
});

test("game limit is inclusive and excludes routes that require more games", () => {
  assert.equal(solveExactCombinations({ scores: [100], difference: 400, maxGames: 4 }).results.length, 1);
  assert.equal(solveExactCombinations({ scores: [100], difference: 400, maxGames: 3 }).results.length, 0);
});

test("returns no results when an exact score is impossible", () => {
  const solution = solveExactCombinations({ scores: [100], difference: 50, maxGames: 20 });
  assert.equal(solution.results.length, 0);
  assert.equal(solution.limitReached, false);
});

test("result limit stops enumeration and reports truncation", () => {
  const solution = solveExactCombinations({
    scores: [1, 2],
    difference: 10,
    maxGames: 10,
    resultLimit: 2,
  });

  assert.equal(solution.results.length, 2);
  assert.equal(solution.limitReached, true);
});

test("result comparators apply documented primary and secondary keys", () => {
  const results = [
    { games: 3, stamina: 0, scoreTypes: 1, entries: [[0, 3]] },
    { games: 1, stamina: 2, scoreTypes: 3, entries: [[2, 1]] },
    { games: 1, stamina: 1, scoreTypes: 2, entries: [[1, 1]] },
  ];

  assert.deepEqual([...createResultOrder(results, "games")], [2, 1, 0]);
  assert.deepEqual([...createResultOrder(results, "stamina")], [0, 2, 1]);
  assert.ok(compareResults(results[2], results[1], "games") < 0);
  assert.deepEqual(
    [...createResultOrder(results, ["scoreTypes", "games", "stamina"])],
    [0, 2, 1],
  );
  assert.deepEqual(
    [...createResultOrder(results, ["games", "scoreTypes", "stamina"])],
    [2, 1, 0],
  );
});

test("zero difference is valid input but current score above target is rejected", () => {
  const zero = normalizeCalculatorInput({
    scoreText: "100",
    currentScore: "1000",
    targetScore: "1000",
    maxGames: "1",
  });
  assert.equal(zero.difference, 0);

  assert.throws(
    () => normalizeCalculatorInput({
      scoreText: "100",
      currentScore: "1001",
      targetScore: "1000",
      maxGames: "1",
    }),
    (error) => error instanceof CalculatorInputError && error.code === "CURRENT_OVER_TARGET",
  );
});

test("invalid score lists and game limits return specific validation errors", () => {
  assert.throws(() => parseScoreList(""), { code: "EMPTY_SCORES" });
  assert.throws(() => parseScoreList("0, 100"), { code: "INTEGER_OUT_OF_RANGE" });
  assert.throws(() => parseScoreList("10.5"), { code: "INVALID_INTEGER" });
  assert.throws(() => parseScoreList(Array.from({ length: 21 }, (_, index) => index + 1).join(",")), {
    code: "TOO_MANY_SCORES",
  });

  assert.throws(
    () => normalizeCalculatorInput({
      scoreText: "100",
      currentScore: "0",
      targetScore: "100",
      maxGames: "21",
    }),
    { code: "INTEGER_OUT_OF_RANGE" },
  );
});

test("scores that overflow at ×15 are rejected", () => {
  const unsafeAtFifteen = Math.floor(Number.MAX_SAFE_INTEGER / 15) + 1;
  assert.throws(() => parseScoreList(String(unsafeAtFifteen)), {
    code: "SCORE_MULTIPLICATION_OVERFLOW",
  });
});
