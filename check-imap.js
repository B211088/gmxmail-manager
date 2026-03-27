const Imap = require("imap");
const fs = require("fs");
const https = require("https");
const http = require("http");

// ── Args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const inputFile = args.find((a) => !a.startsWith("--"));
const timeoutMs =
  parseInt(
    (args.find((a) => a.startsWith("--timeout=")) || "").split("=")[1],
  ) ||
  parseInt(args[args.indexOf("--timeout") + 1]) ||
  12000;
const concurrency =
  parseInt(
    (args.find((a) => a.startsWith("--concurrency=")) || "").split("=")[1],
  ) ||
  parseInt(args[args.indexOf("--concurrency") + 1]) ||
  3;

if (!inputFile) {
  console.error(
    "❌ Thiếu file!\nCách dùng: node check-imap.js links-backup.json",
  );
  process.exit(1);
}
if (!fs.existsSync(inputFile)) {
  console.error(`❌ Không tìm thấy: ${inputFile}`);
  process.exit(1);
}

// ── Parse input ───────────────────────────────────────────────────────────
const items = [];
const isJson = inputFile.endsWith(".json");

if (isJson) {
  // Đọc thẳng từ backup JSON — có đủ from, pass, slug
  const db = JSON.parse(fs.readFileSync(inputFile, "utf8"));
  for (const [slug, d] of Object.entries(db)) {
    if (!d.from || !d.pass) continue;
    // raw line để giữ nguyên trong output
    const raw = `${d.from}|${d.pass}|${slug}`;
    items.push({ raw, user: d.from, pass: d.pass, slug });
  }
  console.log(`📦 Đọc từ backup JSON: ${items.length} entries`);
} else {
  // Đọc từ txt — lấy link /m/slug rồi fetch creds từ server
  const rawLines = fs
    .readFileSync(inputFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const raw of rawLines) {
    const linkMatch = raw.match(/https?:\/\/[^\s|"]+\/m\/([a-f0-9]+)/);
    if (!linkMatch) {
      items.push({ raw, skip: true, reason: "no_link" });
    } else {
      items.push({
        raw,
        slug: linkMatch[1],
        link: linkMatch[0],
        needFetch: true,
      });
    }
  }
  console.log(`📄 Đọc từ txt: ${items.length} dòng`);
}

console.log(`⚙️  Concurrency: ${concurrency} | Timeout: ${timeoutMs}ms`);
console.log("─".repeat(70));

// ── Fetch creds từ server (chỉ dùng khi đọc từ txt) ──────────────────────
function fetchCreds(link) {
  return new Promise((resolve) => {
    const infoUrl = link.replace(/\/m\/([a-f0-9]+)/, "/api/info/$1");
    const lib = infoUrl.startsWith("https") ? https : http;
    const req = lib.get(infoUrl, { timeout: 8000 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try {
          const d = JSON.parse(body);
          if (d.from && d.pass)
            resolve({ ok: true, user: d.from, pass: d.pass });
          else resolve({ ok: false, reason: "no_creds" });
        } catch {
          resolve({ ok: false, reason: "parse_error" });
        }
      });
    });
    req.on("error", (e) =>
      resolve({ ok: false, reason: "fetch_error", detail: e.message }),
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, reason: "fetch_timeout" });
    });
  });
}

// ── Check IMAP ────────────────────────────────────────────────────────────
function checkImap(user, pass) {
  return new Promise((resolve) => {
    const imap = new Imap({
      user,
      password: pass,
      host: "imap.gmx.net",
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: timeoutMs,
      authTimeout: timeoutMs,
    });

    const timer = setTimeout(() => {
      try {
        imap.destroy();
      } catch {}
      resolve({ ok: false, reason: "timeout" });
    }, timeoutMs + 2000);

    imap.once("ready", () => {
      clearTimeout(timer);
      imap.end();
      resolve({ ok: true });
    });

    imap.once("error", (err) => {
      clearTimeout(timer);
      const msg = (err.message || "").toLowerCase();
      let reason = "error";
      if (/auth|credentials|login|password|username|invalid/i.test(msg))
        reason = "wrong_pass";
      else if (/timeout/i.test(msg)) reason = "timeout";
      else if (/connect|refused|notfound|network/i.test(msg))
        reason = "network";
      resolve({ ok: false, reason, detail: err.message });
    });

    try {
      imap.connect();
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, reason: "error", detail: e.message });
    }
  });
}

// ── Run ───────────────────────────────────────────────────────────────────
const buckets = {
  ok: [],
  wrong_pass: [],
  timeout: [],
  network: [],
  skip: [],
  error: [],
};
let done = 0;

async function runAll() {
  const queue = [...items];

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      done++;
      const prefix = `[${done}/${items.length}]`;

      if (item.skip) {
        console.log(`⚠️  ${prefix} SKIP — ${item.raw.slice(0, 60)}`);
        buckets.skip.push(item.raw);
        continue;
      }

      // Lấy creds
      let user = item.user;
      let pass = item.pass;

      if (item.needFetch) {
        const info = await fetchCreds(item.link);
        if (!info.ok) {
          console.log(`🔗 ${prefix} FETCH_ERR — ${info.reason} | ${item.link}`);
          buckets.error.push(item.raw);
          continue;
        }
        user = info.user;
        pass = info.pass;
      }

      // Check IMAP
      const r = await checkImap(user, pass);

      if (r.ok) {
        console.log(`✅ ${prefix} OK          ${user}`);
        buckets.ok.push(item.raw);
      } else if (r.reason === "wrong_pass") {
        console.log(`🔑 ${prefix} WRONG_PASS  ${user}`);
        buckets.wrong_pass.push(item.raw);
      } else if (r.reason === "timeout") {
        console.log(`⏱️  ${prefix} TIMEOUT     ${user}`);
        buckets.timeout.push(item.raw);
      } else if (r.reason === "network") {
        console.log(`📡 ${prefix} NETWORK     ${user}`);
        buckets.network.push(item.raw);
      } else {
        console.log(`❌ ${prefix} ERROR       ${user} (${r.detail || ""})`);
        buckets.error.push(item.raw);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

runAll().then(() => {
  console.log("─".repeat(70));
  console.log(
    `✅ OK: ${buckets.ok.length}  🔑 Wrong pass: ${buckets.wrong_pass.length}  ⏱️  Timeout: ${buckets.timeout.length}  ❌ Lỗi: ${buckets.error.length + buckets.network.length}  ⚠️  Skip: ${buckets.skip.length}`,
  );

  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const dir = `check-result-${ts}`;
  fs.mkdirSync(dir, { recursive: true });

  const write = (name, lines) => {
    if (lines.length)
      fs.writeFileSync(`${dir}/${name}`, lines.join("\n") + "\n", "utf8");
  };

  write("ok.txt", buckets.ok);
  write("wrong-pass.txt", buckets.wrong_pass);
  write("timeout.txt", buckets.timeout);
  write("network-error.txt", buckets.network);
  write("error.txt", buckets.error);
  write("skip.txt", buckets.skip);

  const summary = [
    `Kết quả — ${new Date().toLocaleString("vi-VN")}`,
    `Input: ${inputFile} (${items.length} entries)`,
    `✅ OK:          ${buckets.ok.length}`,
    `🔑 Wrong pass:  ${buckets.wrong_pass.length}`,
    `⏱️  Timeout:     ${buckets.timeout.length}`,
    `📡 Network:     ${buckets.network.length}`,
    `❌ Error:       ${buckets.error.length}`,
    `⚠️  Skip:        ${buckets.skip.length}`,
  ].join("\n");
  fs.writeFileSync(`${dir}/summary.txt`, summary, "utf8");

  console.log(`\n📁 Kết quả: ${dir}/`);
});
