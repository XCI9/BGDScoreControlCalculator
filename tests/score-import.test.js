import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseMinimumPtTable } from "../src/score-import.js";

test("the supplied song table imports 66 rows as 26 distinct minimum PT scores", async () => {
  const sample = await readFile(new URL("./fixtures/auto-scores.tsv", import.meta.url), "utf8");
  const imported = parseMinimumPtTable(sample);
  assert.equal(imported.rowCount, 66);
  assert.deepEqual(imported.scores, [
    790, 794, 806, 809, 813, 825, 829, 836, 840, 844, 852, 855, 863,
    867, 871, 874, 878, 882, 886, 890, 894, 897, 901, 905, 917, 924,
  ]);
  assert.equal(imported.duplicateCount, 40);
});

test("minimum PT is selected by heading even when columns are reordered", () => {
  const imported = parseMinimumPtTable("最高 PT ↓\t歌曲名称\t最低 PT ↑\tAuto最低分\n999\tSong 123\t890\t1,353,476");
  assert.deepEqual(imported.scores, [890]);
});

test("Windows line endings, repeated headings, blank rows and thousands separators are supported", () => {
  const imported = parseMinimumPtTable("\uFEFF歌曲名称\t最低PT ↕️\r\nA\t1,234\r\n\r\n歌曲名称\t最低PT ↕️\r\nB\t1,234\r\nC\t890\r\n");
  assert.deepEqual(imported.scores, [890, 1234]);
  assert.equal(imported.rowCount, 3);
  assert.equal(imported.duplicateCount, 1);
});

test("only a selected minimum PT column can also be imported", () => {
  assert.deepEqual(parseMinimumPtTable("最低PT\n890\n886").scores, [886, 890]);
});

test("missing, ambiguous and empty minimum PT tables are rejected", () => {
  assert.throws(() => parseMinimumPtTable(""), { code: "MISSING_PT_HEADER" });
  assert.throws(() => parseMinimumPtTable("最高PT\n890"), { code: "MISSING_PT_HEADER" });
  assert.throws(() => parseMinimumPtTable("最低PT\t最低 PT\n890\t890"), { code: "AMBIGUOUS_PT_HEADER" });
  assert.throws(() => parseMinimumPtTable("最低PT\n\n"), { code: "EMPTY_PT_TABLE" });
});

test("an incomplete or invalid row rejects the whole import and reports its line", () => {
  for (const row of ["B", "B\t", "B\t-1", "B\t1.5", "B\t8,90", "B\tNaN", "B\t890\textra"]) {
    assert.throws(() => parseMinimumPtTable(`歌曲名称\t最低PT\nA\t890\n${row}`), (error) => {
      assert.equal(error.code, "INVALID_PT_ROW");
      assert.match(error.message, /第 3 行/u);
      return true;
    });
  }
  assert.throws(() => parseMinimumPtTable("最低PT\n0"), { code: "INTEGER_OUT_OF_RANGE" });
  assert.throws(() => parseMinimumPtTable(`最低PT\n${Math.floor(Number.MAX_SAFE_INTEGER / 15) + 1}`), {
    code: "SCORE_MULTIPLICATION_OVERFLOW",
  });
});

test("500 distinct imported scores are supported and duplicate rows do not consume the limit", () => {
  const rows = Array.from({ length: 500 }, (_, index) => String(index + 1));
  const imported = parseMinimumPtTable(["最低PT", ...rows, ...rows].join("\n"));
  assert.equal(imported.scores.length, 500);
  assert.equal(imported.rowCount, 1000);
  assert.equal(imported.duplicateCount, 500);
  assert.throws(() => parseMinimumPtTable(["最低PT", ...rows, "501"].join("\n")), { code: "TOO_MANY_SCORES" });
});
