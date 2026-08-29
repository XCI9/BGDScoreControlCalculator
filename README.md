# 控分組合計算器

一個不需要後端的繁體中文控分工具。輸入可打出的基礎分數、目前分數、目標分數與最多場數後，計算器會列出所有能精確補足分差的打法，並支援依場數或體力排序。

## 計分規則

| 倍率 | 體力消耗 |
| ---: | -------: |
| ×1   | 0        |
| ×5   | 1        |
| ×10  | 2        |
| ×15  | 3        |

每個基礎分數可以重複使用。相同內容但出場順序不同的打法只會列出一次；限制場數內沒有精確解時不提供近似結果。

## 本機使用

本站使用 ES Modules 與 Web Worker，因此請透過本機 HTTP 伺服器預覽，不要直接以 `file://` 開啟 `index.html`。

如果已安裝 Python：

```powershell
python -m http.server 8000
```

接著開啟 <http://localhost:8000>。

執行不需安裝相依套件的單元測試：

```powershell
node --test
```

若電腦已安裝 Chrome 或 Edge，也可執行完整的瀏覽器冒煙測試：

```powershell
node scripts/browser-smoke.mjs
```

## 部署至 GitHub Pages

1. 在 GitHub 建立新的 repository，並將本專案推送至 `main` 分支。
2. 前往 repository 的 **Settings → Pages**。
3. 在 **Build and deployment** 將 Source 設為 **GitHub Actions**。
4. 推送至 `main` 後，`Deploy static site to Pages` workflow 會執行測試並自動發布網站。

也可以在 Actions 頁面手動觸發部署。網站全部由相對路徑載入，因此 user site 與 project site 都能正常運作。

## 專案結構

- `index.html`、`styles.css`：頁面結構與響應式外觀。
- `src/app.js`：表單、Web Worker、排序、結果顯示與分頁。
- `src/solver.js`：輸入驗證與可獨立測試的組合搜尋核心。
- `src/solver.worker.js`：背景搜尋、進度、取消與結果排序。
- `tests/solver.test.js`：核心規則與邊界條件測試。

搜尋最多接受 20 種不同分數與 20 場，並在找到 100,000 筆結果後停止，以保護瀏覽器記憶體。所有輸入及計算都只留在使用者的瀏覽器內。
