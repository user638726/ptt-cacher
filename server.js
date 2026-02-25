// server.js
const express = require("express");
const puppeteer = require("puppeteer");
const fs = require("fs-extra");
const path = require("path");

const app = express();
app.use(express.static("public"));

function formatMMDD(date) {
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}
function getToday() {
  return formatMMDD(new Date());
}
function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return formatMMDD(d);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retry(fn, times = 2, delayMs = 500) {
  let lastErr;
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < times - 1) await sleep(delayMs);
    }
  }
  throw lastErr;
}

function toFullPttUrl(href) {
  if (!href) return "";
  if (href.startsWith("http")) return href;
  if (href.startsWith("/")) return `https://www.ptt.cc${href}`;
  return `https://www.ptt.cc/${href}`;
}

// ✅ 把 PTT 列表日期 (常見 " 2/15") 正規化成 "02/15"
function normalizePttDate(s) {
  if (!s) return "";
  const t = String(s).trim();
  const m = t.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) return t;
  const mm = String(Number(m[1])).padStart(2, "0");
  const dd = String(Number(m[2])).padStart(2, "0");
  return `${mm}/${dd}`;
}

app.get("/crawl", async (req, res) => {
  const today = getToday();
  const yesterday = getYesterday();
  const resultsMap = new Map();

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: false, // 想要無頭模式可改 true
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--ignore-certificate-errors",
        "--window-size=1920,1080",
      ],
    });

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "accept-language": "zh-TW,zh;q=0.9" });

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    // over18 cookie
    await page.setCookie({
      name: "over18",
      value: "1",
      domain: "www.ptt.cc",
      path: "/",
    });

    let url = "https://www.ptt.cc/bbs/NBA/index.html";
    let keepGoing = true;
    let loopCount = 0;
    const MAX_LOOPS = 10;

    while (keepGoing && loopCount < MAX_LOOPS) {
      loopCount++;

      await retry(async () => {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 0 });
        await page.waitForSelector(".r-ent", { timeout: 5000 });
      }, 2, 800);

      const { articlesOnPage, prevPageHref } = await retry(async () => {
        return await page.evaluate(() => {
          const rows = [...document.querySelectorAll(".r-ent")];

          const items = rows
            .map((el) => {
              const titleEl = el.querySelector(".title a");
              const title = titleEl ? titleEl.innerText.trim() : null;
              if (!title) return null;

              if (
                title.startsWith("[公告]") ||
                title.startsWith("[協尋]") ||
                title.startsWith("[Removed]")
              ) {
                return null;
              }

              const href = titleEl.getAttribute("href") || "";
              const authorEl = el.querySelector(".meta .author");
              const author = authorEl ? authorEl.innerText : "";
              const dateEl = el.querySelector(".meta .date");
              const date = dateEl ? dateEl.innerText : ""; // 可能含空白

              return { title, href, author, date };
            })
            .filter((i) => i !== null);

          const btn = [...document.querySelectorAll(".btn.wide")].find((b) =>
            b.innerText.includes("上頁")
          );
          const prevHref = btn ? btn.getAttribute("href") || btn.href || null : null;

          return { articlesOnPage: items, prevPageHref: prevHref };
        });
      }, 2, 500);

      // ✅ 收集今天/昨天文章（日期先 normalize）
      for (const a of articlesOnPage) {
        const d = normalizePttDate(a.date);
        if (d === today || d === yesterday) {
          const fullLink = toFullPttUrl(a.href);
          if (!resultsMap.has(fullLink)) {
            resultsMap.set(fullLink, {
              postInfo: { title: a.title, author: a.author, date: d },
              contentInfo: { link: [fullLink], image: [] },
            });
          }
        }
      }

      // ✅ 判斷要不要繼續翻頁，也要用 normalize 後日期
      const pageHasTargetDates = articlesOnPage.some((i) => {
        const d = normalizePttDate(i.date);
        return d === today || d === yesterday;
      });

      // 這頁已經完全沒有今天/昨天 -> 停止
      if (!pageHasTargetDates) {
        keepGoing = false;
        break;
      }

      if (!prevPageHref) {
        keepGoing = false;
        break;
      }

      url = toFullPttUrl(prevPageHref);
      await sleep(600);
    }

    const arr = Array.from(resultsMap.values());
    const todayArr = arr.filter((i) => i.postInfo.date === today);
    const yesterdayArr = arr.filter((i) => i.postInfo.date === yesterday);
    const finalArr = [...todayArr, ...yesterdayArr];

    // ✅ 存到 data 資料夾（不存在就建立）
    const dataFolder = path.join(__dirname, "data");
    await fs.ensureDir(dataFolder);

    const filePath = path.join(dataFolder, "nba01.json");
    await fs.writeJson(filePath, finalArr, { spaces: 2 });

    await browser.close();

    // ✅ 直接回傳陣列（給前端 forEach）
    return res.json(finalArr);
  } catch (err) {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
    }
    console.error("抓取失敗：", err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => {
  console.log("伺服器啟動：http://localhost:3000");
});
