/**
 * parse-data.js
 * node parse-data.js data.txt links-backup.json
 */

const fs = require("fs");

const args = process.argv.slice(2);
const inputTxt = args[0];
const inputJson = args[1];

if (!inputTxt || !inputJson) {
  console.error("❌ Cách dùng: node parse-data.js data.txt links-backup.json");
  process.exit(1);
}

const db = JSON.parse(fs.readFileSync(inputJson, "utf8"));

// Build index: from -> entry
const fromIndex = {};
for (const [slug, entry] of Object.entries(db)) {
  if (entry.from) {
    fromIndex[entry.from.toLowerCase().trim()] = { slug, ...entry };
  }
}

// ── DEBUG: in thử 3 key đầu của JSON và 3 from đầu ──
console.log("🔑 3 key đầu trong JSON:");
Object.keys(db)
  .slice(0, 3)
  .forEach((k) => {
    const e = db[k];
    console.log(`  key="${k}" | from="${e.from}" | to="${e.to}"`);
  });

const lines = fs
  .readFileSync(inputTxt, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);

// ── DEBUG: in thử 3 dòng đầu của data ──
console.log("\n📄 3 dòng đầu data (maillam + link):");
lines.slice(0, 3).forEach((line, i) => {
  const parts = line.split("|");
  const maillam = parts[3] || "(trống)";
  const link = parts[4] || "(trống)";
  const slugMatch = link.match(/\/m\/([a-f0-9]+)/);
  const slug = slugMatch ? slugMatch[1] : "(no slug)";
  const foundBySlug = db[slug] ? "✅" : "❌";
  const foundByFrom = fromIndex[maillam.toLowerCase().trim()] ? "✅" : "❌";
  console.log(
    `  [${i}] maillam="${maillam}" | slug="${slug}" | bySlug=${foundBySlug} | byFrom=${foundByFrom}`,
  );
});
console.log("─".repeat(70));

function splitLine(line) {
  const cookieIdx = line.lastIndexOf("|[{");
  let cookie = "";
  let before = line;
  if (cookieIdx !== -1) {
    cookie = line.slice(cookieIdx + 1);
    before = line.slice(0, cookieIdx);
  }
  const parts = before.split("|");
  while (parts.length < 12) parts.push("");
  parts.push(cookie);
  return parts;
}

const matched = [];
const skipped = [];

for (const line of lines) {
  const parts = splitLine(line);
  const maillam = (parts[3] || "").trim();
  const link = (parts[4] || "").trim();

  if (!maillam) {
    skipped.push(`[missing_maillam] ${line.slice(0, 80)}`);
    continue;
  }

  let entry = null;

  // Match 1: theo slug
  if (link) {
    const slugMatch = link.match(/\/m\/([a-f0-9]+)/);
    if (slugMatch) {
      entry = db[slugMatch[1]] || null;
    }
  }

  // Match 2: theo mail làm (entry.from)
  if (!entry) {
    entry = fromIndex[maillam.toLowerCase()] || null;
  }

  if (!entry) {
    skipped.push(`[not_found] maillam="${maillam}" | link="${link}"`);
    continue;
  }

  if (!entry.to || !entry.pass) {
    skipped.push(`[missing_to_pass] maillam=${maillam}`);
    continue;
  }

  const newParts = [
    ...parts.slice(0, 4),
    entry.to,
    entry.pass,
    ...parts.slice(4),
  ];

  matched.push(newParts.join("|"));
}

// ── Kết quả ───────────────────────────────────────────────────────────────
console.log(`✅ Match: ${matched.length} | ⚠️ Skip: ${skipped.length}`);

if (skipped.length > 0) {
  console.log(`\n⚠️  Skip samples (5 đầu):`);
  skipped.slice(0, 5).forEach((s) => console.log("  ", s));
}

if (matched.length > 0) {
  const cookieIdx = matched[0].lastIndexOf("|[{");
  const before = cookieIdx !== -1 ? matched[0].slice(0, cookieIdx) : matched[0];
  const p = before.split("|");
  console.log(`\n── Preview dòng 1 ──`);
  console.log(`  maillam   : ${p[3]}`);
  console.log(`  mailchinh : ${p[4]}`);
  console.log(`  passchinh : ${p[5]}`);
  console.log(`  hotmail   : ${p[10]}`);
}

fs.writeFileSync("output-matched.txt", matched.join("\n") + "\n", "utf8");
console.log(`\n📁 Đã lưu: output-matched.txt`);

if (skipped.length > 0) {
  fs.writeFileSync("output-skipped.txt", skipped.join("\n") + "\n", "utf8");
  console.log(`⚠️  Skip log: output-skipped.txt`);
}
