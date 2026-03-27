// ── test-imap.js ────────────────────────────────────────────────────────────
// Chạy: node test-imap.js
// Điền thông tin acc vào TEST_ACCOUNTS bên dưới

const Imap = require("imap");
const { simpleParser } = require("mailparser");

// ============================================================
// ĐỔI THÔNG TIN Ở ĐÂY
// ============================================================
const TEST_ACCOUNTS = [
  // T-Online
  {
    label: "T-Online test",
    type: "tonline",
    user: "shishehjdsfo65@t-online.de", // email chính (maillam)
    pass: "nYFcglZE#lt7a5DFSQ", // ← Passwort für E-Mail-Programme
  },
  // GMX (để so sánh, bỏ qua nếu không cần)
  // {
  //   label: "GMX test",
  //   type: "gmx",
  //   user: "abc@gmx.de",
  //   pass: "password123",
  // },
];
// ============================================================

const HOSTS = {
  tonline: [
    { host: "secureimap.t-online.de", port: 993 },
    { host: "imap.t-online.de", port: 993 },
  ],
  gmx: [{ host: "imap.gmx.net", port: 993 }],
};

function pad(s, n = 30) {
  return String(s).padEnd(n);
}
function log(label, ...args) {
  console.log(`  [${label}]`, ...args);
}

async function testConnect(label, user, pass, host, port) {
  return new Promise((resolve) => {
    console.log(`\n  🔌 Thử ${host}:${port}`);
    const imap = new Imap({
      user,
      password: pass,
      host,
      port,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 12000,
      authTimeout: 10000,
    });

    const timer = setTimeout(() => {
      console.log(`  ⏱  TIMEOUT sau 12s`);
      try {
        imap.destroy();
      } catch {}
      resolve({ ok: false, error: "TIMEOUT" });
    }, 14000);

    imap.once("ready", () => {
      clearTimeout(timer);
      console.log(`  ✅ AUTH OK — ${host}:${port}`);

      imap.openBox("INBOX", true, (err, box) => {
        if (err) {
          console.log(`  ⚠️  openBox lỗi: ${err.message}`);
          imap.end();
          resolve({ ok: true, connected: true, inboxError: err.message });
          return;
        }
        const total = box.messages.total;
        console.log(`  📬 INBOX: ${total} mail`);

        if (total === 0) {
          imap.end();
          resolve({ ok: true, connected: true, total: 0 });
          return;
        }

        // Lấy thử 1 mail mới nhất
        const f = imap.seq.fetch(`${total}:${total}`, {
          bodies: "",
          struct: true,
        });
        let got = null;

        f.on("message", (msg) => {
          let buf = "";
          msg.on("body", (stream) => {
            stream.on("data", (c) => {
              buf += c.toString("utf8");
            });
            stream.once("end", async () => {
              try {
                const parsed = await simpleParser(buf);
                got = {
                  subject: parsed.subject || "(no subject)",
                  from: parsed.from?.text || "",
                  date: parsed.date?.toISOString() || "",
                };
              } catch (e) {
                got = { parseError: e.message };
              }
            });
          });
        });

        f.once("error", (err) => {
          console.log(`  ⚠️  fetch lỗi: ${err.message}`);
        });

        f.once("end", () => {
          if (got) {
            console.log(`  📧 Mail mới nhất:`);
            console.log(`     Subject : ${got.subject}`);
            console.log(`     From    : ${got.from}`);
            console.log(`     Date    : ${got.date}`);
          }
          imap.end();
          resolve({ ok: true, connected: true, total, sample: got });
        });
      });
    });

    imap.once("error", (err) => {
      clearTimeout(timer);
      console.log(`  ❌ LỖI: ${err.message}`);
      resolve({ ok: false, error: err.message });
    });

    imap.connect();
  });
}

async function runTests() {
  console.log("═".repeat(60));
  console.log(" IMAP TEST — T-Online / GMX");
  console.log("═".repeat(60));

  for (const acc of TEST_ACCOUNTS) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(` ACC  : ${acc.user}`);
    console.log(` TYPE : ${acc.type}`);
    console.log(`${"─".repeat(60)}`);

    const hosts = HOSTS[acc.type] || HOSTS.gmx;

    // T-Online: thử full email và username-only
    const userVariants =
      acc.type === "tonline"
        ? [
            { user: acc.user, label: "full email" },
            {
              user: acc.user.split("@")[0],
              label: "username only (no domain)",
            },
          ]
        : [{ user: acc.user, label: "full email" }];

    let success = false;

    outer: for (const { host, port } of hosts) {
      for (const variant of userVariants) {
        console.log(
          `\n  🔌 ${host}:${port}  user="${variant.user}" (${variant.label})`,
        );
        const result = await testConnect(
          acc.label,
          variant.user,
          acc.pass,
          host,
          port,
        );
        if (result.ok && result.connected) {
          console.log(`\n  ✅ PASS!`);
          console.log(`     host : ${host}:${port}`);
          console.log(`     user : ${variant.user}  ← dùng cái này`);
          success = true;
          break outer;
        }
      }
    }

    if (!success) {
      console.log(`\n  ❌ FAIL — không combination nào thành công`);
      console.log(`  💡 Kiểm tra:`);
      console.log(`     1. Pass đúng chưa?`);
      console.log(
        `     2. Bật IMAP: https://email.t-online.de → Einstellungen → E-Mail-Programme`,
      );
      console.log(`     3. Thử đổi pass một lần để reset bảo mật tài khoản`);
    }
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(" DONE");
  console.log("═".repeat(60));
  process.exit(0);
}

runTests().catch(console.error);
