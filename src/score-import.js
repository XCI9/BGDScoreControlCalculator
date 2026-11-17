import { CalculatorInputError, parseScoreList } from "./solver.js";

function normalizeHeading(value) {
  return value.replace(/[\s↑↓↕\uFE0F]/gu, "").toUpperCase();
}

function splitCells(line) {
  // A trailing backslash can be introduced when copying a table through chat.
  return line.replace(/\\+\s*$/u, "").split("\t").map((cell) => cell.trim());
}

export function parseMinimumPtTable(rawTable) {
  const lines = String(rawTable ?? "").replace(/^\uFEFF/u, "").split(/\r\n?|\n/u);
  const headerIndex = lines.findIndex((line) => splitCells(line).some((cell) => normalizeHeading(cell) === "最低PT"));
  if (headerIndex === -1) {
    throw new CalculatorInputError("MISSING_PT_HEADER", "找不到「最低 PT」欄，請連同表頭複製歌曲表格後貼上（欄位之間需保留 Tab）。");
  }

  const headings = splitCells(lines[headerIndex]).map(normalizeHeading);
  const ptIndex = headings.indexOf("最低PT");
  if (headings.lastIndexOf("最低PT") !== ptIndex) {
    throw new CalculatorInputError("AMBIGUOUS_PT_HEADER", "表頭包含多個「最低 PT」欄，請只貼上一份歌曲表格。");
  }

  const values = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    const cells = splitCells(lines[index]);
    if (cells.length === headings.length && cells.every((cell, column) => normalizeHeading(cell) === headings[column])) continue;
    if (cells.length !== headings.length) {
      throw new CalculatorInputError("INVALID_PT_ROW", `第 ${index + 1} 行的欄位數與表頭不同，請確認已完整複製該列。`);
    }

    const pt = cells[ptIndex];
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/u.test(pt)) {
      throw new CalculatorInputError("INVALID_PT_ROW", `第 ${index + 1} 行的最低 PT「${pt}」必須是正整數。`);
    }
    const value = pt.replaceAll(",", "");
    try {
      parseScoreList(value);
    } catch (error) {
      if (!(error instanceof CalculatorInputError)) throw error;
      throw new CalculatorInputError(error.code, `第 ${index + 1} 行的最低 PT 無效：${error.message}`);
    }
    values.push(value);
  }

  if (values.length === 0) {
    throw new CalculatorInputError("EMPTY_PT_TABLE", "表格只有表頭，請一併複製歌曲資料列。");
  }

  const scores = parseScoreList(values.join(" "));
  return Object.freeze({
    scores: Object.freeze(scores),
    rowCount: values.length,
    duplicateCount: values.length - scores.length,
  });
}
