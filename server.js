require("dotenv").config();
const express = require("express");
const Imap = require("imap");
const { simpleParser } = require("mailparser");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const DB_FILE = path.join(__dirname, "links.json");
const IMAP_HOST = "imap.gmx.net";
const IMAP_PORT = 993;
const PAGE_SIZE = 50;
const ADMIN_PASSWORD = process.env.ADMIN_PASS || "admin123";
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
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
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

  for (const entry of entries) {
    let from, to, pass, lbl;
    if (typeof entry === "string") {
      const parts = entry.trim().split("|");
      if (parts.length < 3) continue;
      [from, to, pass, lbl] = parts;
    } else {
      ({ from, to, pass, label: lbl } = entry);
    }
    if (!from || !to || !pass) continue;
    const slug = genSlug();
    db[slug] = {
      from: from.trim(),
      to: to.trim(),
      pass: pass.trim(),
      label: (lbl || label || "").trim(),
      createdAt: new Date().toISOString(),
    };
    created.push({
      slug,
      from: from.trim(),
      to: to.trim(),
      label: db[slug].label,
    });
  }
  saveDB(db);
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
function fetchMails(user, pass, res, page, limit) {
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
      const totalPages = Math.max(1, Math.ceil(total / limit));

      send("meta", { total, totalPages, page, limit });

      if (total === 0) {
        send("done", { total: 0, totalPages: 1, page: 1 });
        imap.end();
        return;
      }

      const endSeq = total - (page - 1) * limit;
      const startSeq = Math.max(1, endSeq - limit + 1);

      if (endSeq < 1) {
        send("done", { total, totalPages, page });
        imap.end();
        return;
      }

      send("status", {
        message: `📥 Trang ${page}/${totalPages} (${startSeq}:${endSeq})`,
      });

      const f = imap.seq.fetch(`${startSeq}:${endSeq}`, {
        bodies: "",
        struct: true,
      });

      // ── KEY FIX: dùng Promise để đợi TẤT CẢ async parse xong ──────────
      const parsePromises = [];
      const mails = [];

      f.on("message", (msg, seqno) => {
        // Tạo promise cho từng mail, push vào array NGAY LÚC nhận message
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
        // Đợi TẤT CẢ promise parse xong mới sort và send
        const results = await Promise.all(parsePromises);
        results.sort((a, b) => b.seqno - a.seqno);
        for (const m of results) send("mail", m);
        send("done", { total, totalPages, page });
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

  fetchMails(entry.from, entry.pass, res, page, limit);
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
