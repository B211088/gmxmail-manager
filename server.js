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

// ── IMAP configs theo loại mail ───────────────────────────────────────────
const IMAP_CONFIGS = {
  gmx: {
    host: "imap.gmx.net",
    port: 993,
  },
  tonline: {
    host: "secureimap.t-online.de",
    port: 993,
  },
};

// Detect loại mail từ domain — chỉ dùng cho backward compat với data cũ
function detectMailType(email) {
  if (!email) return "gmx";
  const domain = (email.split("@")[1] || "").toLowerCase();
  if (domain === "t-online.de") return "tonline";
  return "gmx";
}

const PAGE_SIZE = 50;
const ADMIN_PASSWORD = process.env.ADMIN_PASS;
const BACKUP_PASSWORD = process.env.BACKUP_PASS;
const TOKEN_SECRET = process.env.TOKEN_SECRET;
if (!ADMIN_PASSWORD || !BACKUP_PASSWORD || !TOKEN_SECRET) {
  console.error(
    "❌ Thiếu biến môi trường: ADMIN_PASS, BACKUP_PASS, TOKEN_SECRET",
  );
  process.exit(1);
}

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
      imapPass: d.imapPass || "",
      twofa: d.twofa || "",
      label: d.label || "",
      mailType: d.mailType || "gmx",
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
    let from, to, pass, imapPass, twofa, lbl;
    if (typeof entry === "string") {
      const parts = entry.trim().split("|");
      if (parts.length < 3) continue;
      if (parts.length >= 5) {
        // 5 cột → t-online: maillam|mailchinh|passchinh|2fa|passimap
        [from, to, pass, twofa, imapPass, lbl] = parts;
      } else if (parts.length === 4) {
        // 4 cột → t-online không có 2FA: maillam|mailchinh|passchinh|passimap
        [from, to, pass, imapPass, lbl] = parts;
        twofa = "";
      } else {
        // 3 cột → gmx: maillam|mailchinh|pass
        [from, to, pass, lbl] = parts;
        imapPass = "";
        twofa = "";
      }
    } else {
      ({ from, to, pass, imapPass, twofa, label: lbl } = entry);
    }
    from = (from || "").trim();
    to = (to || "").trim();
    pass = (pass || "").trim();
    imapPass = (imapPass || "").trim();
    twofa = (twofa || "").trim();
    if (!from || !to || !pass) continue;

    // mailType: có imapPass → t-online, không thì detect theo domain
    const mailType = imapPass ? "tonline" : detectMailType(from);
    const slug = genSlug();
    db[slug] = {
      from,
      to,
      pass, // pass web — lưu để hiển thị
      imapPass, // Passwort für E-Mail-Programme — dùng để IMAP connect
      twofa, // 2FA — lưu để hiển thị
      mailType,
      label: (lbl || label || "").trim(),
      createdAt: new Date(baseTime + entryIdx).toISOString(),
    };
    created.push({ slug, from, to, mailType, label: db[slug].label });
  }

  saveDB(db);

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
// Dùng chung cho cả GMX lẫn T-Online, chỉ khác host/port qua mailType
// Logic fetch inbox giữ nguyên 100% so với code GMX cũ

// T-Online có thể dùng nhiều host khác nhau — thử lần lượt
const TONLINE_HOSTS = [{ host: "secureimap.t-online.de", port: 993 }];

function fetchMails(
  user,
  pass,
  imapPass,
  res,
  page,
  limit,
  filterFrom,
  mailType,
) {
  page = Math.max(1, parseInt(page) || 1);
  limit = Math.max(1, parseInt(limit) || PAGE_SIZE);

  const send = (type, data) =>
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  if (mailType === "tonline") {
    // T-Online: dùng imapPass (Passwort für E-Mail-Programme), fallback sang pass nếu không có
    const effectivePass = imapPass || pass;
    _tryTOnlineHosts(
      user,
      effectivePass,
      res,
      page,
      limit,
      filterFrom,
      send,
      0,
    );
    return;
  }

  const cfg = IMAP_CONFIGS.gmx;

  const imap = new Imap({
    user,
    password: pass,
    host: cfg.host,
    port: cfg.port,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    connTimeout: 15000,
    authTimeout: 10000,
  });

  imap.once("ready", () => {
    send("status", { message: "✅ Kết nối IMAP thành công" });
    _fetchInbox(imap, send, page, limit, filterFrom);
  });

  imap.once("error", (err) => {
    console.error("[GMX] IMAP error:", err.message);
    send("error", { message: `Lỗi GMX: ${err.message}` });
    res.end();
  });
  imap.once("end", () => res.end());
  imap.connect();
}

function _tryTOnlineHosts(user, pass, res, page, limit, filterFrom, send, idx) {
  if (idx >= TONLINE_HOSTS.length) {
    const tried = TONLINE_HOSTS.map((h) => h.host).join(", ");
    send("error", { message: `Không connect được T-Online. Đã thử: ${tried}` });
    res.end();
    return;
  }

  const cfg = TONLINE_HOSTS[idx];
  console.log(`[T-Online] Thử ${cfg.host}:${cfg.port} cho ${user}`);
  send("status", { message: `🔄 Đang thử kết nối...` });

  const imap = new Imap({
    user,
    password: pass,
    host: cfg.host,
    port: cfg.port,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    connTimeout: 15000,
    authTimeout: 10000,
  });

  let connected = false;

  imap.once("ready", () => {
    connected = true;
    console.log(`[T-Online] ✅ Connected via ${cfg.host}`);
    send("status", { message: `✅ Kết nối t-online thành công` });
    _fetchInbox(imap, send, page, limit, filterFrom);
  });

  imap.once("error", (err) => {
    console.error(`[T-Online] ❌ ${cfg.host} lỗi: ${err.message}`);
    if (!connected) {
      // Thử host tiếp theo
      _tryTOnlineHosts(user, pass, res, page, limit, filterFrom, send, idx + 1);
    } else {
      send("error", { message: `Lỗi T-Online: ${err.message}` });
      res.end();
    }
  });

  imap.once("end", () => {
    if (connected) res.end();
  });

  imap.connect();
}

// ── Fetch INBOX — dùng sau khi đã connect thành công ─────────────────────
function _fetchInbox(imap, send, page, limit, filterFrom) {
  imap.openBox("INBOX", true, (err, box) => {
    if (err) {
      console.error("[IMAP] openBox error:", err.message);
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

    const endSeq = total - (page - 1) * limit;
    const startSeq = Math.max(1, endSeq - limit + 1);
    send("status", { message: `📥 Đang tải mail (${startSeq}–${endSeq})...` });

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

    f.once("error", (err) => {
      console.error("[IMAP] fetch error:", err.message);
      send("error", { message: err.message });
    });

    f.once("end", async () => {
      let results = await Promise.all(parsePromises);
      results.sort((a, b) => b.seqno - a.seqno);

      if (filterFrom) {
        const target = filterFrom.toLowerCase();
        results = results.filter((m) =>
          (m.to || "").toLowerCase().includes(target),
        );
      }

      const totalPages = Math.max(1, Math.ceil(total / limit));
      send("meta", {
        total,
        totalPages,
        page,
        limit,
        filteredCount: results.length,
      });
      for (const m of results) send("mail", m);
      send("done", { total, totalPages, page, filteredCount: results.length });
      imap.end();
    });
  });
}

// ── Admin: verify backup pass ─────────────────────────────────────────────
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

// ── Routes ────────────────────────────────────────────────────────────────
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
  const mailType = entry.mailType || detectMailType(entry.from);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  fetchMails(
    entry.from,
    entry.pass,
    entry.imapPass || "",
    res,
    page,
    limit,
    entry.from,
    mailType,
  );
});

app.get("/api/info/:slug", (req, res) => {
  const db = loadDB();
  const entry = db[req.params.slug];
  if (!entry) return res.status(404).json({ error: "Không tìm thấy" });
  res.json({
    from: entry.from,
    to: entry.to,
    label: entry.label,
    mailType: entry.mailType || "gmx",
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ http://localhost:${PORT}`);
  console.log(`🔧 Admin: http://localhost:${PORT}/admin.html`);
  console.log(`🔑 Pass admin: ${ADMIN_PASSWORD}`);
});
