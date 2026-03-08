require("dotenv").config();
const express = require("express");
const Imap = require("imap");
const { simpleParser } = require("mailparser");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "200mb" }));
app.use(express.urlencoded({ limit: "200mb", extended: true }));
app.use(express.static("public"));

const DB_FILE = process.env.DATA_PATH
  ? path.join(process.env.DATA_PATH, "links.json")
  : path.join(__dirname, "links.json");
const HISTORY_FILE = process.env.DATA_PATH
  ? path.join(process.env.DATA_PATH, "history.json")
  : path.join(__dirname, "history.json");
const IMAP_HOST = "imap.gmx.net";
const IMAP_PORT = 993;
const PAGE_SIZE = 50;
const ADMIN_PASSWORD = process.env.ADMIN_PASS || "admin123";
const BACKUP_PASSWORD = process.env.BACKUP_PASS || "backup123";
const TOKEN_SECRET = process.env.TOKEN_SECRET || "gmx-reader-secret-2024";

function signToken(payload) {
  const data = JSON.stringify(payload);
  const sig = crypto
    .createHmac("sha256", TOKEN_SECRET)
    .update(data)
    .digest("hex");
  return Buffer.from(data).toString("base64") + "." + sig;
}

function verifyToken(token) {
  try {
    const [b64, sig] = (token || "").split(".");
    if (!b64 || !sig) return null;
    const data = Buffer.from(b64, "base64").toString();
    const expected = crypto
      .createHmac("sha256", TOKEN_SECRET)
      .update(data)
      .digest("hex");
    return sig === expected ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveDB(db) {
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
}

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveHistory(history) {
  const dir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), "utf8");
}
function genSlug() {
  return crypto.randomBytes(5).toString("hex");
}

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || !verifyToken(token))
    return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.post("/api/admin/login", (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.json({ token: signToken({ role: "admin", ts: Date.now() }) });
  } else {
    res.status(401).json({ error: "Sai mật khẩu" });
  }
});

app.get("/api/admin/links", requireAdmin, (req, res) => {
  const db = loadDB();
  res.json(
    Object.entries(db).map(([slug, d]) => ({
      slug,
      from: d.from,
      to: d.to,
      pass: d.pass,
      label: d.label || "",
      createdAt: d.createdAt,
    })),
  );
});

app.post("/api/admin/links", requireAdmin, (req, res) => {
  const { entries, label } = req.body;
  if (!Array.isArray(entries) || !entries.length)
    return res.status(400).json({ error: "Thiếu dữ liệu" });

  const db = loadDB();
  const created = [];
  const baseTime = Date.now();

  for (const [entryIdx, entry] of entries.entries()) {
    let from, to, pass, lbl;
    if (typeof entry === "string") {
      const parts = entry.trim().split("|");
      if (parts.length < 3) continue;
      [from, to, pass, lbl] = parts;
    } else {
      ({ from, to, pass, label: lbl } = entry);
    }
    from = (from || "").trim();
    to = (to || "").trim();
    pass = (pass || "").trim();
    if (!from || !to || !pass) continue;
    const slug = genSlug();
    db[slug] = {
      from,
      to,
      pass,
      label: (lbl || label || "").trim(),
      createdAt: new Date(baseTime + entryIdx).toISOString(),
    };
    created.push({ slug, from, to, label: db[slug].label });
  }

  // Write DB 1 lần
  saveDB(db);

  // Lưu history — chỉ lưu slug+from+to để không phình file
  if (created.length > 0) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const history = loadHistory();
    history.unshift({ ts, count: created.length, data: created });
    if (history.length > 50) history.splice(50);
    saveHistory(history);
  }

  res.json({ ok: true, created });
});

app.delete("/api/admin/links/:slug", requireAdmin, (req, res) => {
  const db = loadDB();
  if (!db[req.params.slug])
    return res.status(404).json({ error: "Không tìm thấy" });
  delete db[req.params.slug];
  saveDB(db);
  res.json({ ok: true });
});

// ── IMAP fetch ─────────────────────────────────────────────────────────────
function fetchMails(user, pass, res, page, limit, filterFrom) {
  page = Math.max(1, parseInt(page) || 1);
  limit = Math.max(1, parseInt(limit) || PAGE_SIZE);

  const send = (type, data) =>
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  const imap = new Imap({
    user,
    password: pass,
    host: IMAP_HOST,
    port: IMAP_PORT,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    connTimeout: 15000,
    authTimeout: 10000,
  });

  imap.once("ready", () => {
    send("status", { message: "✅ Kết nối IMAP thành công" });

    imap.openBox("INBOX", true, (err, box) => {
      if (err) {
        send("error", { message: `Lỗi INBOX: ${err.message}` });
        imap.end();
        return;
      }

      const total = box.messages.total;

      if (total === 0) {
        send("meta", { total: 0, totalPages: 1, page: 1, limit });
        send("done", { total: 0, totalPages: 1, page: 1 });
        imap.end();
        return;
      }

      // Fetch trang hiện tại theo sequence (mới nhất trước)
      const endSeq = total - (page - 1) * limit;
      const startSeq = Math.max(1, endSeq - limit + 1);

      send("status", { message: `📥 Đang tải mail...` });

      const f = imap.seq.fetch(`${startSeq}:${endSeq}`, {
        bodies: "",
        struct: true,
      });
      const parsePromises = [];

      f.on("message", (msg, seqno) => {
        const p = new Promise((resolve) => {
          let buffer = "";
          msg.on("body", (stream) => {
            stream.on("data", (chunk) => {
              buffer += chunk.toString("utf8");
            });
            stream.once("end", async () => {
              try {
                const parsed = await simpleParser(buffer);
                resolve({
                  seqno,
                  from: parsed.from?.text || "",
                  to: parsed.to?.text || "",
                  subject: parsed.subject || "(không có tiêu đề)",
                  date: parsed.date ? parsed.date.toISOString() : "",
                  text: parsed.text || "",
                  html: parsed.html || "",
                });
              } catch (e) {
                resolve({ seqno, subject: "(lỗi parse)", error: e.message });
              }
            });
          });
        });
        parsePromises.push(p);
      });

      f.once("error", (err) => send("error", { message: err.message }));

      f.once("end", async () => {
        let results = await Promise.all(parsePromises);
        results.sort((a, b) => b.seqno - a.seqno);

        // Filter: chỉ giữ mail có To chứa maillam
        if (filterFrom) {
          const target = filterFrom.toLowerCase();
          results = results.filter((m) =>
            (m.to || "").toLowerCase().includes(target),
          );
        }

        // filteredTotal = số mail thực sau filter trên trang này
        // Dùng total hộp thư gốc để ước tính totalPages (không thể biết chính xác)
        const totalPages = Math.max(1, Math.ceil(total / limit));
        send("meta", {
          total,
          totalPages,
          page,
          limit,
          filteredCount: results.length,
        });

        for (const m of results) send("mail", m);
        send("done", {
          total,
          totalPages,
          page,
          filteredCount: results.length,
        });
        imap.end();
      });
    });
  });

  imap.once("error", (err) => {
    send("error", { message: `Lỗi: ${err.message}` });
    res.end();
  });
  imap.once("end", () => res.end());
  imap.connect();
}

// ── Admin: verify backup pass ────────────────────────────────────────────
app.post("/api/admin/verify-backup-pass", requireAdmin, (req, res) => {
  if (req.body.password === BACKUP_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false });
  }
});

// ── Admin: history ────────────────────────────────────────────────────────
app.get("/api/admin/history", requireAdmin, (req, res) => {
  res.json(loadHistory());
});

app.delete("/api/admin/history/:idx", requireAdmin, (req, res) => {
  const history = loadHistory();
  const idx = parseInt(req.params.idx);
  if (isNaN(idx) || idx < 0 || idx >= history.length)
    return res.status(404).json({ error: "Không tìm thấy" });
  history.splice(idx, 1);
  saveHistory(history);
  res.json({ ok: true });
});

app.delete("/api/admin/history", requireAdmin, (req, res) => {
  saveHistory([]);
  res.json({ ok: true });
});

// ── Admin: export/import backup ───────────────────────────────────────────
app.get("/api/admin/backup", requireAdmin, (req, res) => {
  const db = loadDB();
  res.setHeader(
    "Content-Disposition",
    "attachment; filename=links-backup.json",
  );
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(db, null, 2));
});

app.post("/api/admin/restore", requireAdmin, (req, res) => {
  const db = req.body;
  if (typeof db !== "object" || Array.isArray(db))
    return res.status(400).json({ error: "Dữ liệu không hợp lệ" });
  saveDB(db);
  res.json({ ok: true, count: Object.keys(db).length });
});

// ── Route: admin shortcut ─────────────────────────────────────────────────
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/m/:slug", (req, res) => {
  const db = loadDB();
  const entry = db[req.params.slug];
  if (!entry) return res.status(404).send("Link không tồn tại hoặc đã bị xóa.");
  res.sendFile(path.join(__dirname, "public", "view.html"));
});

app.get("/api/read/:slug", (req, res) => {
  const db = loadDB();
  const entry = db[req.params.slug];
  if (!entry) return res.status(404).json({ error: "Không tìm thấy" });

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || PAGE_SIZE;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  fetchMails(entry.from, entry.pass, res, page, limit, entry.from);
});

app.get("/api/info/:slug", (req, res) => {
  const db = loadDB();
  const entry = db[req.params.slug];
  if (!entry) return res.status(404).json({ error: "Không tìm thấy" });
  res.json({ from: entry.from, to: entry.to, label: entry.label });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ http://localhost:${PORT}`);
  console.log(`🔧 Admin: http://localhost:${PORT}/admin.html`);
  console.log(`🔑 Pass admin: ${ADMIN_PASSWORD}`);
});
