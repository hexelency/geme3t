const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const root = __dirname;
const db = new DatabaseSync(path.join(root, "digital-services.sqlite"));

db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'unit',
    price INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    coupon_code TEXT,
    service_count INTEGER NOT NULL DEFAULT 0,
    service_amount INTEGER NOT NULL DEFAULT 0,
    credit_balance INTEGER NOT NULL DEFAULT 0,
    credit_score INTEGER NOT NULL DEFAULT 0,
    redeemed_amount INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(phone)
  );
  CREATE TABLE IF NOT EXISTS affiliates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    tier TEXT NOT NULL DEFAULT 'Custom',
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(phone)
  );
  CREATE TABLE IF NOT EXISTS coupons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    tier TEXT NOT NULL DEFAULT 'Custom',
    client_pct REAL NOT NULL DEFAULT 0,
    affiliate_pct REAL NOT NULL DEFAULT 0,
    client_direct INTEGER NOT NULL DEFAULT 0,
    affiliate_id INTEGER,
    referral_only INTEGER NOT NULL DEFAULT 0,
    usage_count INTEGER NOT NULL DEFAULT 0,
    redemption_threshold INTEGER NOT NULL DEFAULT 3,
    FOREIGN KEY(affiliate_id) REFERENCES affiliates(id)
  );
  CREATE TABLE IF NOT EXISTS quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,
    coupon_id INTEGER,
    gross_total INTEGER NOT NULL DEFAULT 0,
    direct_discount INTEGER NOT NULL DEFAULT 0,
    coupon_discount INTEGER NOT NULL DEFAULT 0,
    payable_total INTEGER NOT NULL DEFAULT 0,
    direct_cost INTEGER NOT NULL DEFAULT 0,
    net_profit INTEGER NOT NULL DEFAULT 0,
    customer_discount INTEGER NOT NULL DEFAULT 0,
    commission_earned INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(customer_id) REFERENCES customers(id),
    FOREIGN KEY(coupon_id) REFERENCES coupons(id)
  );
  CREATE TABLE IF NOT EXISTS quote_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_id INTEGER NOT NULL,
    service_id INTEGER,
    name TEXT NOT NULL,
    unit TEXT NOT NULL,
    unit_price INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    line_total INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    completed_at TEXT,
    carryover_date TEXT,
    payment_channels TEXT,
    coupon_redemption INTEGER NOT NULL DEFAULT 0,
    cash_amount INTEGER NOT NULL DEFAULT 0,
    transfer_amount INTEGER NOT NULL DEFAULT 0,
    redemption_amount INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(quote_id) REFERENCES quotes(id) ON DELETE CASCADE,
    FOREIGN KEY(service_id) REFERENCES services(id)
  );
  CREATE TABLE IF NOT EXISTS day_closes (
    date TEXT PRIMARY KEY,
    pending_count INTEGER NOT NULL DEFAULT 0,
    closed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS finance_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_date TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('revenue','expense')),
    category TEXT NOT NULL,
    description TEXT,
    amount INTEGER NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL DEFAULT 'cash',
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

function ensureColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn("coupons", "client_direct", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("coupons", "affiliate_id", "INTEGER");
ensureColumn("affiliates", "tier", "TEXT NOT NULL DEFAULT 'Custom'");
ensureColumn("affiliates", "discount_pct", "REAL NOT NULL DEFAULT 0");
ensureColumn("affiliates", "commission_pct", "REAL NOT NULL DEFAULT 0");
ensureColumn("affiliates", "commission_score", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("affiliates", "customer_discount_total", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("quotes", "customer_discount", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("quotes", "commission_earned", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("customers", "service_count", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("customers", "service_amount", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("customers", "credit_balance", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("customers", "credit_score", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("customers", "redeemed_amount", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("quote_items", "status", "TEXT NOT NULL DEFAULT 'pending'");
ensureColumn("quote_items", "completed_at", "TEXT");
ensureColumn("quote_items", "carryover_date", "TEXT");
ensureColumn("quote_items", "payment_channels", "TEXT");
ensureColumn("quote_items", "coupon_redemption", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("quote_items", "cash_amount", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("quote_items", "transfer_amount", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("quote_items", "redemption_amount", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("coupons", "redemption_threshold", "INTEGER NOT NULL DEFAULT 3");
ensureColumn("finance_entries", "source", "TEXT NOT NULL DEFAULT 'manual'");
ensureColumn("customers", "referral_credit", "INTEGER NOT NULL DEFAULT 0");

if (!get("SELECT 1 FROM app_settings WHERE key = 'customer_credit_pct'", [])) {
  run("INSERT INTO app_settings (key, value) VALUES ('customer_credit_pct', '5')");
}

function recalculateCustomerCredits() {
  const pctRow = get("SELECT value FROM app_settings WHERE key = 'customer_credit_pct'");
  const pct = Math.max(0, Math.min(100, Number(pctRow?.value) || 5));
  for (const customer of all("SELECT id, redeemed_amount FROM customers")) {
    run("UPDATE customers SET service_count = 0, service_amount = 0, credit_score = 0, credit_balance = 0, referral_credit = 0 WHERE id = ?", [customer.id]);
  }
  for (const item of all(`
    SELECT qi.*, q.customer_id, q.coupon_id, q.gross_total, q.net_profit
    FROM quote_items qi
    JOIN quotes q ON q.id = qi.quote_id
    WHERE qi.status = 'completed'
  `)) {
    const gross = Number(item.gross_total) || 0;
    const lineTotal = Number(item.line_total) || 0;
    const serviceNetProfit = gross ? Math.max(0, Number(item.net_profit) || 0) * lineTotal / gross : 0;
    const creditEarned = Math.round(serviceNetProfit * pct / 100);

    if (item.customer_id) {
      const buyer = get("SELECT * FROM customers WHERE id = ?", [item.customer_id]);
      if (buyer) {
        const newCount = Number(buyer.service_count || 0) + (Number(item.quantity) || 1);
        const newAmount = Number(buyer.service_amount || 0) + lineTotal;
        const newCredit = Number(buyer.credit_balance || 0) + creditEarned;
        run("UPDATE customers SET service_count = ?, service_amount = ?, credit_balance = ?, credit_score = ? WHERE id = ?",
          [newCount, newAmount, newCredit, newCount + Math.floor(newAmount / 1000), buyer.id]);
      }
    }
    if (item.coupon_id) {
      const coupon = get("SELECT code FROM coupons WHERE id = ?", [item.coupon_id]);
      if (coupon?.code) {
        const owner = get("SELECT * FROM customers WHERE coupon_code = ?", [coupon.code]);
        if (owner) {
          const currentOwner = get("SELECT * FROM customers WHERE id = ?", [owner.id]);
          const referralCredit = Number(currentOwner.referral_credit || 0) + creditEarned;
          const ownerBalance = Number(currentOwner.credit_balance || 0) + creditEarned;
          run("UPDATE customers SET referral_credit = ?, credit_balance = ? WHERE id = ?",
            [referralCredit, ownerBalance, owner.id]);
        }
      }
    }
  }
  for (const customer of all("SELECT id, credit_balance, redeemed_amount FROM customers")) {
    const redeemed = Number(customer.redeemed_amount || 0);
    const balance = Math.max(0, Number(customer.credit_balance || 0) - redeemed);
    run("UPDATE customers SET credit_balance = ? WHERE id = ?", [balance, customer.id]);
  }
}

recalculateCustomerCredits();

function seed() {
  const categoryCount = db.prepare("SELECT COUNT(*) AS count FROM categories").get().count;
  if (categoryCount > 0) return;
  const defaultCatalog = [
    ["Print & Bind", [["B&W Print", "page", 100], ["Colour Page", "page", 200], ["Photocopy", "page", 50], ["Hard Binding", "copy", 3000], ["Spiral Binding", "copy", 700], ["Lamination (A4)", "sheet", 300], ["ID Card Lamination", "card", 200]]],
    ["Typing & Document Services", [["Typesetting / Typing", "page", 300], ["Document Scanning", "page", 150], ["CV / Resume Formatting", "doc", 2000], ["PDF Conversion / Merge", "file", 500]]],
    ["Online Registrations & Portal", [["JAMB / Post-UTME Reg", "form", 1500], ["NIN / BVN Slip Reprint", "slip", 1000], ["Remita / School Portal Pay", "txn", 1000], ["CAC Business Name Filing", "filing", 15000]]],
    ["Graphic Design & Branding", [["Flyer / E-Poster Design", "design", 5000], ["Logo Design", "design", 15000], ["Passport Photo (4 copies)", "set", 1000]]]
  ];
  const addCategory = db.prepare("INSERT INTO categories (name) VALUES (?)");
  const addService = db.prepare("INSERT INTO services (category_id, name, unit, price) VALUES (?, ?, ?, ?)");
  for (const [categoryName, services] of defaultCatalog) {
    const result = addCategory.run(categoryName);
    for (const [name, unit, price] of services) addService.run(result.lastInsertRowid, name, unit, price);
  }
}
seed();

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 2_000_000) req.destroy(); });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error("Invalid JSON")); }
    });
  });
}
function all(sql, params = []) { return db.prepare(sql).all(...params); }
function get(sql, params = []) { return db.prepare(sql).get(...params); }
function run(sql, params = []) { return db.prepare(sql).run(...params); }

function generateCustomerCoupon(name, phone) {
  const letters = (name || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
  const digits = (phone || "").replace(/\D/g, "").slice(-4);
  const base = (letters + digits).slice(0, 9);
  let code = base || "CUS";
  let index = 0;
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  while (get("SELECT id FROM coupons WHERE code = ?", [code])) {
    index++;
    code = (base + alphabet[index % alphabet.length]).slice(0, 9);
  }
  return code.padEnd(9, alphabet[index % alphabet.length]).slice(0, 9);
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/settings/customer-credit") {
    if (req.method === "GET") {
      const row = get("SELECT value FROM app_settings WHERE key = 'customer_credit_pct'");
      return sendJson(res, 200, { customer_credit_pct: Math.max(0, Number(row?.value) || 0) });
    }
    if (req.method === "PATCH") {
      const body = await readJson(req);
      const pct = Math.max(0, Math.min(100, Number(body.customer_credit_pct) || 0));
      run("INSERT INTO app_settings (key, value) VALUES ('customer_credit_pct', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(pct)]);
      recalculateCustomerCredits();
      return sendJson(res, 200, { customer_credit_pct:pct });
    }
  }
  if (url.pathname === "/api/finance") {
    if (req.method === "GET") {
      const period = url.searchParams.get("period") || "day";
      const anchor = url.searchParams.get("anchor") || new Date().toISOString().slice(0, 10);
      const [year, month, day] = anchor.split("-").map(Number);
      let start, end;
      if (period === "month") {
        start = new Date(year, month - 1, 1);
        end = new Date(year, month, 0);
      } else if (period === "year") {
        start = new Date(year, 0, 1);
        end = new Date(year, 11, 31);
      } else {
        start = new Date(year, month - 1, day);
        end = new Date(year, month - 1, day);
      }
      const dateOnly = value => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
      const startText = dateOnly(start);
      const endText = dateOnly(end);
      const entries = all("SELECT * FROM finance_entries WHERE entry_date >= ? AND entry_date <= ? ORDER BY entry_date DESC, id DESC",
        [startText, endText]);
      const manualRevenue = entries.filter(entry => entry.type === "revenue").reduce((sum, entry) => sum + entry.amount, 0);
      const manualExpenses = entries.filter(entry => entry.type === "expense").reduce((sum, entry) => sum + entry.amount, 0);
      const completedSales = get(`
        SELECT COALESCE(SUM(q.payable_total),0) total
        FROM quote_items qi JOIN quotes q ON q.id = qi.quote_id
        WHERE qi.status = 'completed'
          AND substr(qi.completed_at,1,10) >= ? AND substr(qi.completed_at,1,10) <= ?
      `, [startText, endText]).total;
      const directCost = get(`
        SELECT COALESCE(SUM(q.direct_cost),0) total
        FROM quote_items qi JOIN quotes q ON q.id = qi.quote_id
        WHERE qi.status = 'completed'
          AND substr(qi.completed_at,1,10) >= ? AND substr(qi.completed_at,1,10) <= ?
      `, [startText, endText]).total;
      const couponPayout = get(`
        SELECT COALESCE(SUM(q.coupon_discount),0) total
        FROM quote_items qi JOIN quotes q ON q.id = qi.quote_id
        WHERE qi.status = 'completed'
          AND substr(qi.completed_at,1,10) >= ? AND substr(qi.completed_at,1,10) <= ?
      `, [startText, endText]).total;
      const totalRevenue = completedSales + manualRevenue;
      const totalExpenses = manualExpenses + directCost + couponPayout;
      return sendJson(res, 200, {
        start:startText, end:endText, entries,
        completedSales, manualRevenue, manualExpenses,
        directCost, couponPayout,
        totalRevenue, totalExpenses,
        netBalance:totalRevenue - totalExpenses
      });
    }
    if (req.method === "POST") {
      const body = await readJson(req);
      if (!body.entry_date || !body.type || !body.category || !body.amount) {
        return sendJson(res, 400, { error: "Date, type, category, and amount are required" });
      }
      const id = run(`INSERT INTO finance_entries
        (entry_date, type, category, description, amount, payment_method, source)
        VALUES (?, ?, ?, ?, ?, ?, 'manual')`,
        [body.entry_date, body.type === "expense" ? "expense" : "revenue",
         body.category.trim(), body.description?.trim() || null,
         Math.max(0, Number(body.amount) || 0),
         body.payment_method || "cash"]).lastInsertRowid;
      return sendJson(res, 201, get("SELECT * FROM finance_entries WHERE id = ?", [id]));
    }
  }
  if (/^\/api\/finance\/\d+$/.test(url.pathname) && req.method === "DELETE") {
    const id = Number(url.pathname.split("/").pop());
    run("DELETE FROM finance_entries WHERE id = ? AND source = 'manual'", [id]);
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === "/api/dashboard") {
    return sendJson(res, 200, {
      categories: get("SELECT COUNT(*) count FROM categories").count,
      services: get("SELECT COUNT(*) count FROM services").count,
      customers: get("SELECT COUNT(*) count FROM customers").count,
      coupons: get("SELECT COUNT(*) count FROM coupons").count,
      quotes: get("SELECT COUNT(*) count FROM quotes").count,
      gross: get("SELECT COALESCE(SUM(gross_total),0) total FROM quotes").total,
      net: get("SELECT COALESCE(SUM(net_profit),0) total FROM quotes").total,
      salesCompleted: get("SELECT COUNT(*) count FROM quote_items WHERE status = 'completed'").count,
      salesPending: get("SELECT COUNT(*) count FROM quote_items WHERE status != 'completed'").count,
      completedAmount: get("SELECT COALESCE(SUM(line_total),0) total FROM quote_items WHERE status = 'completed'").total,
      pendingAmount: get("SELECT COALESCE(SUM(line_total),0) total FROM quote_items WHERE status != 'completed'").total
    });
  }
  if (url.pathname === "/api/catalog") {
    const categories = all("SELECT * FROM categories ORDER BY name");
    return sendJson(res, 200, categories.map(category => ({
      ...category,
      items: all("SELECT * FROM services WHERE category_id = ? ORDER BY name", [category.id])
    })));
  }
  if (url.pathname === "/api/categories" && req.method === "POST") {
    const body = await readJson(req);
    if (!body.name) return sendJson(res, 400, { error: "Category name is required" });
    try { return sendJson(res, 201, get("SELECT * FROM categories WHERE id = ?", [run("INSERT INTO categories (name) VALUES (?)", [body.name.trim()]).lastInsertRowid])); }
    catch (error) { return sendJson(res, 400, { error: error.message }); }
  }
  if (/^\/api\/categories\/\d+$/.test(url.pathname) && req.method === "DELETE") {
    const id = Number(url.pathname.split("/").pop());
    run("UPDATE quote_items SET service_id = NULL WHERE service_id IN (SELECT id FROM services WHERE category_id = ?)", [id]);
    run("DELETE FROM categories WHERE id = ?", [id]);
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === "/api/services" && req.method === "POST") {
    const body = await readJson(req);
    if (!body.name || !body.category_id) return sendJson(res, 400, { error: "Category and service name are required" });
    const id = run("INSERT INTO services (category_id, name, unit, price) VALUES (?, ?, ?, ?)",
      [body.category_id, body.name.trim(), body.unit || "unit", Math.max(0, Number(body.price) || 0)]).lastInsertRowid;
    return sendJson(res, 201, get("SELECT * FROM services WHERE id = ?", [id]));
  }
  if (/^\/api\/services\/\d+$/.test(url.pathname) && ["PATCH", "DELETE"].includes(req.method)) {
    const id = Number(url.pathname.split("/").pop());
    if (req.method === "DELETE") {
      run("UPDATE quote_items SET service_id = NULL WHERE service_id = ?", [id]);
      run("DELETE FROM services WHERE id = ?", [id]);
      return sendJson(res, 200, { ok: true });
    }
    const body = await readJson(req);
    run("UPDATE services SET name = COALESCE(?, name), unit = COALESCE(?, unit), price = COALESCE(?, price), category_id = COALESCE(?, category_id) WHERE id = ?",
      [body.name ?? null, body.unit ?? null, body.price ?? null, body.category_id ?? null, id]);
    return sendJson(res, 200, get("SELECT * FROM services WHERE id = ?", [id]));
  }
  if (url.pathname === "/api/customers") {
    if (req.method === "GET") return sendJson(res, 200, all("SELECT * FROM customers ORDER BY name"));
    if (req.method === "POST") {
      const body = await readJson(req);
      if (!body.name || !body.phone) return sendJson(res, 400, { error: "Name and phone are required" });
      const existing = get("SELECT * FROM customers WHERE phone = ?", [body.phone.trim()]);
      if (existing) {
        return sendJson(res, 409, { error: "Customer already exists", customer: existing });
      }
      const couponCode = generateCustomerCoupon(body.name, body.phone);
      const couponId = run(
        "INSERT INTO coupons (code, tier, client_pct, affiliate_pct, referral_only) VALUES (?, 'customer', 0, 0, 1)",
        [couponCode]
      ).lastInsertRowid;
      const customerId = run(
        "INSERT INTO customers (name, phone, coupon_code) VALUES (?, ?, ?)",
        [body.name.trim(), body.phone.trim(), couponCode]
      ).lastInsertRowid;
      return sendJson(res, 201, {
        ...get("SELECT * FROM customers WHERE id = ?", [customerId]),
        credit_coupon_id: couponId
      });
    }
  }
  if (/^\/api\/operations\/items\/\d+\/details$/.test(url.pathname) && req.method === "GET") {
    const id = Number(url.pathname.split("/")[4]);
    const item = get(`
      SELECT qi.*, q.id AS quote_id, q.created_at, q.gross_total, q.direct_discount,
             q.coupon_discount, q.payable_total, q.direct_cost, q.net_profit,
             q.commission_earned, c.id AS customer_id, c.name AS customer_name,
             c.phone AS customer_phone, c.coupon_code AS customer_coupon_code,
             c.service_count, c.service_amount, c.credit_balance, c.credit_score,
             cp.code AS coupon_code, cp.referral_only, cp.usage_count, cp.redemption_threshold
      FROM quote_items qi
      JOIN quotes q ON q.id = qi.quote_id
      LEFT JOIN customers c ON c.id = q.customer_id
      LEFT JOIN coupons cp ON cp.id = q.coupon_id
      WHERE qi.id = ?
    `, [id]);
    if (!item) return sendJson(res, 404, { error: "Operation not found" });
    const grossShare = item.gross_total ? item.line_total / item.gross_total : 0;
    const discountShare = Math.round((item.direct_discount + item.coupon_discount) * grossShare);
    const costShare = Math.round(item.direct_cost * grossShare);
    const payableShare = Math.round(item.payable_total * grossShare);
    const netProfitShare = Math.round(Math.max(0, item.net_profit * grossShare));
    const creditSetting = get("SELECT value FROM app_settings WHERE key = 'customer_credit_pct'");
    const creditPct = Math.max(0, Math.min(100, Number(creditSetting?.value) || 5));
    const creditEarned = item.status === "completed"
      ? 0
      : Math.round(netProfitShare * creditPct / 100);
    const prospectiveCreditBalance = Number(item.credit_balance || 0) + creditEarned;
    return sendJson(res, 200, {
      ...item,
      direct_discount_share: discountShare,
      direct_cost_share: costShare,
      payable_share: payableShare,
      net_profit_share: netProfitShare,
      customer_credit_pct: creditPct,
      credit_earned: creditEarned,
      prospective_credit_balance: prospectiveCreditBalance
    });
  }
  if (/^\/api\/customers\/\d+$/.test(url.pathname) && ["PATCH", "DELETE"].includes(req.method)) {
    const id = Number(url.pathname.split("/").pop());
    if (req.method === "DELETE") {
      run("UPDATE quotes SET customer_id = NULL WHERE customer_id = ?", [id]);
      run("DELETE FROM customers WHERE id = ?", [id]);
      return sendJson(res, 200, { ok: true });
    }
    const body = await readJson(req);
    run("UPDATE customers SET name = COALESCE(?, name), phone = COALESCE(?, phone) WHERE id = ?",
      [body.name ?? null, body.phone ?? null, id]);
    return sendJson(res, 200, get("SELECT * FROM customers WHERE id = ?", [id]));
  }
  if (/^\/api\/customers\/\d+\/previous-items$/.test(url.pathname) && req.method === "GET") {
    const id = Number(url.pathname.split("/")[3]);
    const quote = get("SELECT id FROM quotes WHERE customer_id = ? AND status = 'completed' ORDER BY created_at DESC, id DESC LIMIT 1", [id]);
    if (!quote) return sendJson(res, 200, []);
    return sendJson(res, 200, all("SELECT service_id AS id, name, unit, unit_price AS price, quantity FROM quote_items WHERE quote_id = ? ORDER BY id", [quote.id]));
  }
  if (url.pathname === "/api/coupons") {
    if (req.method === "GET") return sendJson(res, 200, all(`
      SELECT cp.*, a.name AS affiliate_name, a.tier AS affiliate_tier,
             a.discount_pct AS affiliate_discount_pct, a.commission_pct AS affiliate_commission_pct
      FROM coupons cp
      LEFT JOIN affiliates a ON a.id = cp.affiliate_id
      ORDER BY cp.code
    `));
    if (req.method === "POST") {
      const body = await readJson(req);
      if (!body.code) return sendJson(res, 400, { error: "Coupon code is required" });
      const code = body.code.trim().toUpperCase();
      const existing = get("SELECT * FROM coupons WHERE code = ?", [code]);
      if (existing) {
        run("UPDATE coupons SET tier = ?, client_pct = ?, affiliate_pct = ?, client_direct = ?, affiliate_id = ?, referral_only = ?, redemption_threshold = ? WHERE id = ?",
          [body.tier || existing.tier, Number(body.client_pct) || 0, Number(body.affiliate_pct) || 0,
           Math.max(0, Number(body.client_direct) || 0), body.affiliate_id || null,
           body.referral_only ? 1 : 0, Math.max(1, Number(body.redemption_threshold) || existing.redemption_threshold || 3), existing.id]);
      } else {
        run("INSERT INTO coupons (code, tier, client_pct, affiliate_pct, client_direct, affiliate_id, referral_only, redemption_threshold) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [code, body.tier || "Custom", Number(body.client_pct) || 0, Number(body.affiliate_pct) || 0,
           Math.max(0, Number(body.client_direct) || 0), body.affiliate_id || null,
           body.referral_only ? 1 : 0, Math.max(1, Number(body.redemption_threshold) || 3)]);
      }
      return sendJson(res, existing ? 200 : 201, get("SELECT * FROM coupons WHERE code = ?", [code]));
    }
  }
  if (/^\/api\/coupons\/\d+$/.test(url.pathname) && ["PATCH", "DELETE"].includes(req.method)) {
    const id = Number(url.pathname.split("/").pop());
    if (req.method === "DELETE") {
      run("UPDATE quotes SET coupon_id = NULL WHERE coupon_id = ?", [id]);
      run("DELETE FROM coupons WHERE id = ?", [id]);
      return sendJson(res, 200, { ok: true });
    }
    const body = await readJson(req);
    run("UPDATE coupons SET tier = COALESCE(?, tier), client_pct = COALESCE(?, client_pct), affiliate_pct = COALESCE(?, affiliate_pct), client_direct = COALESCE(?, client_direct), affiliate_id = COALESCE(?, affiliate_id), referral_only = COALESCE(?, referral_only), redemption_threshold = COALESCE(?, redemption_threshold) WHERE id = ?",
      [body.tier ?? null, body.client_pct ?? null, body.affiliate_pct ?? null, body.client_direct ?? null,
       body.affiliate_id ?? null, body.referral_only === undefined ? null : (body.referral_only ? 1 : 0),
       body.redemption_threshold ?? null, id]);
    return sendJson(res, 200, get("SELECT * FROM coupons WHERE id = ?", [id]));
  }
  if (url.pathname === "/api/affiliates") {
    if (req.method === "GET") {
      return sendJson(res, 200, all(`
        SELECT a.*, COALESCE(SUM(cp.usage_count), 0) AS usage_count,
               COUNT(cp.id) AS coupon_count
        FROM affiliates a
        LEFT JOIN coupons cp ON cp.affiliate_id = a.id
        GROUP BY a.id
        ORDER BY usage_count DESC, a.name
      `));
    }
    if (req.method === "POST") {
      const body = await readJson(req);
      if (!body.name) return sendJson(res, 400, { error: "Affiliate name is required" });
      if (body.phone) {
        const existing = get("SELECT * FROM affiliates WHERE phone = ?", [body.phone.trim()]);
        if (existing) return sendJson(res, 409, { error: "Affiliate already exists", affiliate: existing });
      }
      const id = run("INSERT INTO affiliates (name, phone, email, tier, discount_pct, commission_pct, notes, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [body.name.trim(), body.phone ? body.phone.trim() : null, body.email?.trim() || null,
         body.tier?.trim() || "Custom",
         Math.max(0, Math.min(100, Number(body.discount_pct) || 0)),
         Math.max(0, Math.min(100, Number(body.commission_pct) || 0)),
         body.notes?.trim() || null, body.active === false ? 0 : 1]).lastInsertRowid;
      return sendJson(res, 201, get("SELECT * FROM affiliates WHERE id = ?", [id]));
    }
  }
  if (/^\/api\/affiliates\/\d+$/.test(url.pathname) && ["PATCH", "DELETE"].includes(req.method)) {
    const id = Number(url.pathname.split("/").pop());
    if (req.method === "DELETE") {
      run("UPDATE coupons SET affiliate_id = NULL WHERE affiliate_id = ?", [id]);
      run("DELETE FROM affiliates WHERE id = ?", [id]);
      return sendJson(res, 200, { ok: true });
    }
    const body = await readJson(req);
    run("UPDATE affiliates SET name = COALESCE(?, name), phone = COALESCE(?, phone), email = COALESCE(?, email), tier = COALESCE(?, tier), discount_pct = COALESCE(?, discount_pct), commission_pct = COALESCE(?, commission_pct), notes = COALESCE(?, notes), active = COALESCE(?, active) WHERE id = ?",
      [body.name ?? null, body.phone ?? null, body.email ?? null, body.tier ?? null,
       body.discount_pct ?? null, body.commission_pct ?? null, body.notes ?? null,
       body.active === undefined ? null : (body.active ? 1 : 0), id]);
    return sendJson(res, 200, get("SELECT * FROM affiliates WHERE id = ?", [id]));
  }
  if (url.pathname === "/api/operations/report") {
    const period = url.searchParams.get("period") || "week";
    const anchor = url.searchParams.get("anchor") || new Date().toISOString().slice(0, 10);
    const format = (url.searchParams.get("format") || "pdf").toLowerCase();
    const [year, month, day] = anchor.split("-").map(Number);
    const anchorDate = new Date(year, month - 1, day);
    let start, end;
    if (period === "month") { start = new Date(year, month - 1, 1); end = new Date(year, month, 0); }
    else if (period === "year") { start = new Date(year, 0, 1); end = new Date(year, 11, 31); }
    else {
      const offset = (anchorDate.getDay() + 6) % 7;
      start = new Date(year, month - 1, day - offset);
      end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    }
    const dateOnly = value => `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,"0")}-${String(value.getDate()).padStart(2,"0")}`;
    const items = all(`
      SELECT qi.*, q.created_at, q.gross_total, q.direct_discount, q.coupon_discount,
             q.payable_total, q.direct_cost, q.net_profit, q.commission_earned,
             c.name AS customer_name, c.phone AS customer_phone,
             cp.code AS coupon_code
      FROM quote_items qi JOIN quotes q ON q.id = qi.quote_id
      LEFT JOIN customers c ON c.id = q.customer_id
      LEFT JOIN coupons cp ON cp.id = q.coupon_id
      WHERE (substr(q.created_at,1,10) >= ? AND substr(q.created_at,1,10) <= ?)
         OR (qi.carryover_date >= ? AND qi.carryover_date <= ?)
      ORDER BY q.created_at DESC, qi.id DESC
    `, [dateOnly(start), dateOnly(end), dateOnly(start), dateOnly(end)]);
    const title = `GEME3T ${period[0].toUpperCase() + period.slice(1)} Operations Report`;
    const subtitle = `${dateOnly(start)} to ${dateOnly(end)}`;
    const pending = items.filter(item => item.status !== "completed").length;
    const completed = items.filter(item => item.status === "completed").length;
    const quoteIds = [...new Set(items.map(item => item.quote_id))];
    const quoteRows = quoteIds.map(id => get(`
      SELECT gross_total, direct_discount, coupon_discount, payable_total, direct_cost,
             net_profit, commission_earned
      FROM quotes WHERE id = ?
    `, [id])).filter(Boolean);
    const grossServiceAmount = quoteRows.reduce((sum, quote) => sum + (quote.gross_total || 0), 0);
    const totalDirectDiscount = quoteRows.reduce((sum, quote) => sum + (quote.direct_discount || 0), 0);
    const totalCouponPayout = quoteRows.reduce((sum, quote) => sum + (quote.coupon_discount || 0), 0);
    const totalPayable = quoteRows.reduce((sum, quote) => sum + (quote.payable_total || 0), 0);
    const totalDirectCost = quoteRows.reduce((sum, quote) => sum + (quote.direct_cost || 0), 0);
    const totalNetProfit = quoteRows.reduce((sum, quote) => sum + (quote.net_profit || 0), 0);
    const totalCommission = quoteRows.reduce((sum, quote) => sum + (quote.commission_earned || 0), 0);
    if (format === "xlsx") {
      const ExcelJS = require("exceljs");
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Operations");
      sheet.addRow([title]);
      sheet.addRow([subtitle]);
      sheet.addRow(["Total", items.length, "Pending", pending, "Completed", completed]);
      sheet.addRow(["Gross Service Amount", grossServiceAmount, "Direct Discount", totalDirectDiscount,
        "Coupon Payout", totalCouponPayout]);
      sheet.addRow(["Payable", totalPayable, "Direct Cost", totalDirectCost,
        "Net Profit", totalNetProfit, "Affiliate Commission", totalCommission]);
      sheet.addRow([]);
      sheet.addRow(["Date","Customer","Phone","Service","Unit","Quantity","Amount","Status","Payment Channels","Coupon Redemption"]);
      items.forEach(item => sheet.addRow([item.created_at.slice(0,10), item.customer_name || "Guest", item.customer_phone || "", item.name, item.unit, item.quantity, item.line_total, item.status,
        item.payment_channels || "-", item.coupon_redemption ? "Yes" : "No"]));
      sheet.columns.forEach((column, index) => { column.width = [12,22,16,28,12,12,14,12,20,16][index] || 14; });
      const buffer = await workbook.xlsx.writeBuffer();
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="operations-${dateOnly(start)}.${format}"`
      });
      return res.end(Buffer.from(buffer));
    }
    if (format === "docx") {
      const { Document, Packer, Paragraph, Table, TableRow, TableCell, HeadingLevel, TextRun } = require("docx");
      const header = new TableRow({ children:["Date","Customer","Service","Amount","Status"].map(text => new TableCell({ children:[new Paragraph(text)] })) });
      const rows = items.map(item => new TableRow({ children:[
        new TableCell({ children:[new Paragraph(item.created_at.slice(0,10))] }),
        new TableCell({ children:[new Paragraph(item.customer_name || "Guest")] }),
        new TableCell({ children:[new Paragraph(item.name)] }),
        new TableCell({ children:[new Paragraph(String(item.line_total))] }),
        new TableCell({ children:[new Paragraph(item.status)] })
      ]}));
      const document = new Document({ sections:[{ children:[
        new Paragraph({ text:title, heading:HeadingLevel.HEADING_1 }),
        new Paragraph(subtitle),
        new Paragraph(`Total: ${items.length}  |  Pending: ${pending}  |  Completed: ${completed}`),
        new Paragraph(`Gross Service Amount: ${grossServiceAmount}  |  Direct Discount: ${totalDirectDiscount}  |  Coupon Payout: ${totalCouponPayout}`),
        new Paragraph(`Payable: ${totalPayable}  |  Direct Cost: ${totalDirectCost}  |  Net Profit: ${totalNetProfit}  |  Affiliate Commission: ${totalCommission}`),
        new Table({ rows:[header, ...rows] })
      ]}]});
      const buffer = await Packer.toBuffer(document);
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="operations-${dateOnly(start)}.docx"`
      });
      return res.end(buffer);
    }
    const PDFDocument = require("pdfkit");
    const chunks = [];
    const pdf = new PDFDocument({ margin:40 });
    pdf.on("data", chunk => chunks.push(chunk));
    pdf.on("end", () => {
      const buffer = Buffer.concat(chunks);
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="operations-${dateOnly(start)}.pdf"`
      });
      res.end(buffer);
    });
    pdf.fontSize(18).text(title);
    pdf.moveDown(0.3).fontSize(10).text(subtitle);
    pdf.text(`Total: ${items.length}  |  Pending: ${pending}  |  Completed: ${completed}`);
    pdf.text(`Gross Service Amount: ₦${grossServiceAmount}  |  Direct Discount: ₦${totalDirectDiscount}  |  Coupon Payout: ₦${totalCouponPayout}`);
    pdf.text(`Payable: ₦${totalPayable}  |  Direct Cost: ₦${totalDirectCost}  |  Net Profit: ₦${totalNetProfit}  |  Affiliate Commission: ₦${totalCommission}`);
    pdf.moveDown();
    items.forEach(item => pdf.fontSize(9).text(`${item.created_at.slice(0,10)} | ${item.customer_name || "Guest"} | ${item.name} | ₦${item.line_total} | ${item.status}`));
    pdf.end();
    return;
  }
  if (url.pathname === "/api/operations") {
    if (req.method === "GET") {
      const period = url.searchParams.get("period") || "week";
      const anchor = url.searchParams.get("anchor") || new Date().toISOString().slice(0, 10);
      const status = url.searchParams.get("status") || "all";
      const search = (url.searchParams.get("search") || "").trim().toLowerCase();
      const [year, month, day] = anchor.split("-").map(Number);
      const anchorDate = new Date(year, month - 1, day);
      let start, end;
      if (period === "month") {
        start = new Date(year, month - 1, 1);
        end = new Date(year, month, 0);
      } else if (period === "year") {
        start = new Date(year, 0, 1);
        end = new Date(year, 11, 31);
      } else {
        const mondayOffset = (anchorDate.getDay() + 6) % 7;
        start = new Date(year, month - 1, day - mondayOffset);
        end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
      }
      const dateOnly = value => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
      const startText = dateOnly(start);
      const endText = dateOnly(end);
      let sql = `
        SELECT qi.*, q.id AS quote_id, q.customer_id, q.created_at,
               q.gross_total, q.direct_discount, q.coupon_discount, q.payable_total,
               q.direct_cost, q.net_profit, q.commission_earned,
               c.name AS customer_name, c.phone AS customer_phone,
               cp.code AS coupon_code, cp.referral_only, cp.usage_count, cp.redemption_threshold
        FROM quote_items qi
        JOIN quotes q ON q.id = qi.quote_id
        LEFT JOIN customers c ON c.id = q.customer_id
        LEFT JOIN coupons cp ON cp.id = q.coupon_id
        WHERE (substr(q.created_at,1,10) >= ? AND substr(q.created_at,1,10) <= ?)
           OR (qi.carryover_date >= ? AND qi.carryover_date <= ?)
      `;
      const params = [startText, endText, startText, endText];
      if (status !== "all") {
        sql += " AND qi.status = ?";
        params.push(status);
      }
      if (search) {
        sql += " AND (lower(qi.name) LIKE ? OR lower(COALESCE(c.name,'')) LIKE ? OR COALESCE(c.phone,'') LIKE ?)";
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }
      sql += " ORDER BY q.created_at DESC, qi.id DESC";
      const items = all(sql, params);
      return sendJson(res, 200, {
        start: startText,
        end: endText,
        total: items.length,
        completed: items.filter(item => item.status === "completed").length,
        pending: items.filter(item => item.status !== "completed").length,
        items
      });
    }
  }
  if (/^\/api\/operations\/items\/\d+$/.test(url.pathname) && req.method === "PATCH") {
    const id = Number(url.pathname.split("/").pop());
    const body = await readJson(req);
    const existing = get(`
      SELECT qi.*, q.customer_id, q.coupon_id, q.gross_total, q.payable_total,
             q.direct_cost, q.net_profit,
             c.coupon_code, c.service_count, c.service_amount, c.credit_balance, c.credit_score,
             cp.code AS coupon_code, cp.referral_only, cp.usage_count, cp.redemption_threshold
      FROM quote_items qi
      JOIN quotes q ON q.id = qi.quote_id
      LEFT JOIN customers c ON c.id = q.customer_id
      LEFT JOIN coupons cp ON cp.id = q.coupon_id
      WHERE qi.id = ?
    `, [id]);
    if (!existing) return sendJson(res, 404, { error: "Operation not found" });
    const status = body.status === "completed" ? "completed" : "pending";
    if (existing.status === "completed") return sendJson(res, 200, get("SELECT * FROM quote_items WHERE id = ?", [id]));
    if (status !== "completed") return sendJson(res, 400, { error: "Completed services cannot be changed back to pending" });
    let paymentChannels = null;
    let couponRedemption = 0;
    let cashAmount = Math.max(0, Number(body.cash_amount) || 0);
    let transferAmount = Math.max(0, Number(body.transfer_amount) || 0);
    let redemptionAmount = 0;
    const channels = Array.isArray(body.payment_channels)
      ? body.payment_channels.filter(channel => ["cash","transfer","coupon_redemption"].includes(channel))
      : [];
    if (!channels.length) return sendJson(res, 400, { error: "Select at least one payment channel" });
    if (channels.includes("coupon_redemption")) {
      if (!existing.customer_id || !existing.referral_only) {
        return sendJson(res, 400, { error: "Coupon redemption requires a captured returning customer" });
      }
      const couponCode = String(body.coupon_code || "").trim().toUpperCase();
      if (!couponCode || couponCode !== String(existing.coupon_code || "").toUpperCase()) {
        return sendJson(res, 400, { error: "Enter the customer's valid redemption coupon code" });
      }
      const prospectiveCount = Number(existing.service_count || 0) + (Number(existing.quantity) || 1);
      if (prospectiveCount <= Number(existing.redemption_threshold || 3)) {
        return sendJson(res, 400, { error: "Customer service count has not exceeded the redemption threshold" });
      }
      redemptionAmount = Math.max(0, Number(body.redemption_amount) || 0);
      if (redemptionAmount <= 0) return sendJson(res, 400, { error: "Enter a redemption amount" });
      const gross = Number(existing.gross_total) || 0;
      const lineTotal = Number(existing.line_total) || 0;
      const serviceNetProfit = gross ? Math.max(0, Number(existing.net_profit) || 0) * lineTotal / gross : 0;
      const creditSetting = get("SELECT value FROM app_settings WHERE key = 'customer_credit_pct'");
      const customerCreditPct = Math.max(0, Math.min(100, Number(creditSetting?.value) || 5));
      const creditedAmount = Math.round(serviceNetProfit * customerCreditPct / 100);
      const prospectiveBalance = Number(existing.credit_balance || 0) + creditedAmount;
      if (redemptionAmount > prospectiveBalance) {
        return sendJson(res, 400, { error: "Redemption amount exceeds the customer's eligible balance" });
      }
      couponRedemption = 1;
    }
    if (channels.includes("cash") && cashAmount <= 0) return sendJson(res, 400, { error: "Enter the cash amount" });
    if (channels.includes("transfer") && transferAmount <= 0) return sendJson(res, 400, { error: "Enter the transfer amount" });
    paymentChannels = channels.join(",");
    const serviceCount = Number(existing.quantity) || 1;
    const serviceAmount = Number(existing.line_total) || 0;
    if (existing.customer_id) {
      const gross = Number(existing.gross_total) || 0;
      const serviceNetProfit = gross ? Math.max(0, Number(existing.net_profit) || 0) * serviceAmount / gross : 0;
      const creditSetting = get("SELECT value FROM app_settings WHERE key = 'customer_credit_pct'");
      const customerCreditPct = Math.max(0, Math.min(100, Number(creditSetting?.value) || 5));
      const creditedAmount = Math.round(serviceNetProfit * customerCreditPct / 100);
      const newCount = Number(existing.service_count || 0) + serviceCount;
      const newAmount = Number(existing.service_amount || 0) + serviceAmount;
      const newBalance = Number(existing.credit_balance || 0) + creditedAmount - redemptionAmount;
      const newScore = newCount + Math.floor(newAmount / 1000);
      run(`UPDATE customers SET service_count = ?, service_amount = ?, credit_balance = ?,
           credit_score = ?, redeemed_amount = redeemed_amount + ? WHERE id = ?`,
        [newCount, newAmount, newBalance, newScore, redemptionAmount, existing.customer_id]);
    }
    if (existing.coupon_id) {
      const coupon = get("SELECT code FROM coupons WHERE id = ?", [existing.coupon_id]);
      if (coupon?.code) {
        const owner = get("SELECT * FROM customers WHERE coupon_code = ?", [coupon.code]);
        if (owner) {
          const gross = Number(existing.gross_total) || 0;
          const lineTotal = Number(existing.line_total) || 0;
          const serviceNetProfit = gross ? Math.max(0, Number(existing.net_profit) || 0) * lineTotal / gross : 0;
          const creditSetting = get("SELECT value FROM app_settings WHERE key = 'customer_credit_pct'");
          const creditPct = Math.max(0, Math.min(100, Number(creditSetting?.value) || 5));
          const referralEarned = Math.round(serviceNetProfit * creditPct / 100);
          run(`UPDATE customers SET referral_credit = referral_credit + ?, credit_balance = credit_balance + ? WHERE id = ?`,
            [referralEarned, referralEarned, owner.id]);
        }
      }
    }
    if (couponRedemption && existing.coupon_id) {
      run("UPDATE coupons SET usage_count = usage_count + 1 WHERE id = ?", [existing.coupon_id]);
    }
    run(`UPDATE quote_items SET status = 'completed', completed_at = ?, carryover_date = NULL,
         payment_channels = ?, coupon_redemption = ?, cash_amount = ?, transfer_amount = ?,
         redemption_amount = ? WHERE id = ?`,
      [new Date().toISOString(), paymentChannels, couponRedemption,
       cashAmount, transferAmount, redemptionAmount, id]);
    recalculateCustomerCredits();
    return sendJson(res, 200, get("SELECT * FROM quote_items WHERE id = ?", [id]));
  }
  if (url.pathname === "/api/operations/close-day" && req.method === "POST") {
    const body = await readJson(req);
    const date = body.date || new Date().toISOString().slice(0, 10);
    const [closeYear, closeMonth, closeDay] = date.split("-").map(Number);
    const nextDate = new Date(closeYear, closeMonth - 1, closeDay + 1);
    const nextText = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, "0")}-${String(nextDate.getDate()).padStart(2, "0")}`;
    const pendingCount = get(`
      SELECT COUNT(*) count
      FROM quote_items qi
      JOIN quotes q ON q.id = qi.quote_id
      WHERE qi.status != 'completed'
        AND (substr(q.created_at,1,10) = ? OR qi.carryover_date = ?)
    `, [date, date]).count;
    run(`
      UPDATE quote_items
      SET carryover_date = ?
      WHERE status != 'completed'
        AND quote_id IN (
          SELECT id FROM quotes WHERE substr(created_at,1,10) = ?
        )
    `, [nextText, date]);
    run(`
      UPDATE quote_items
      SET carryover_date = ?
      WHERE status != 'completed' AND carryover_date = ?
    `, [nextText, date]);
    run(`INSERT INTO day_closes (date, pending_count) VALUES (?, ?)
         ON CONFLICT(date) DO UPDATE SET pending_count = excluded.pending_count, closed_at = CURRENT_TIMESTAMP`,
      [date, pendingCount]);
    return sendJson(res, 200, { ok: true, date, next_date: nextText, pending_count: pendingCount });
  }
  if (url.pathname === "/api/quotes") {
    if (req.method === "GET") {
      return sendJson(res, 200, all(`
        SELECT q.*, c.name AS customer_name, c.phone AS customer_phone, cp.code AS coupon_code
        FROM quotes q
        LEFT JOIN customers c ON c.id = q.customer_id
        LEFT JOIN coupons cp ON cp.id = q.coupon_id
        ORDER BY q.created_at DESC, q.id DESC
      `));
    }
    if (req.method === "POST") {
      const body = await readJson(req);
      if (body.customer_id) {
        const customer = get("SELECT service_count FROM customers WHERE id = ?", [body.customer_id]);
        if (customer && Number(customer.service_count || 0) > 0) body.coupon_id = null;
      }
      const gross = Math.max(0, Number(body.gross_total) || 0);
      const directDiscount = Math.max(0, Number(body.direct_discount) || 0);
      const couponDiscount = body.coupon_id ? Math.max(0, Number(body.coupon_discount) || 0) : 0;
      const payable = Math.max(0, gross - directDiscount - couponDiscount);
      const directCost = Math.max(0, Number(body.direct_cost) || 0);
      const netProfit = Math.max(0, payable - directCost);
      const customerDiscount = Math.min(gross, directDiscount + couponDiscount);
      let commissionEarned = 0;
      let affiliateId = null;
      if (body.coupon_id) {
        const coupon = get("SELECT affiliate_id, affiliate_pct FROM coupons WHERE id = ?", [body.coupon_id]);
        affiliateId = coupon?.affiliate_id || null;
        if (affiliateId) {
          commissionEarned = Math.round(netProfit * (Number(coupon?.affiliate_pct) || 0) / 100);
        }
      }
      const quoteId = run(`
        INSERT INTO quotes (customer_id, coupon_id, gross_total, direct_discount, coupon_discount,
          payable_total, direct_cost, net_profit, customer_discount, commission_earned, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [body.customer_id || null, body.coupon_id || null, gross, directDiscount, couponDiscount,
          payable, directCost, netProfit, customerDiscount, commissionEarned, body.status || "completed"]).lastInsertRowid;
      const insertItem = db.prepare(`
        INSERT INTO quote_items (quote_id, service_id, name, unit, unit_price, quantity, line_total, status, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of body.items || []) {
        const itemStatus = item.status || body.status || "pending";
        insertItem.run(quoteId, item.service_id || null, item.name, item.unit || "unit",
          Math.max(0, Number(item.unit_price) || 0), Math.max(1, Number(item.quantity) || 1),
          Math.max(0, Number(item.line_total) || 0),
          itemStatus === "completed" ? "completed" : "pending",
          itemStatus === "completed" ? new Date().toISOString() : null);
      }
      if (body.coupon_id) {
        run("UPDATE coupons SET usage_count = usage_count + 1 WHERE id = ?", [body.coupon_id]);
      }
      if (affiliateId) {
        run(`UPDATE affiliates
             SET commission_score = commission_score + ?,
                 customer_discount_total = customer_discount_total + ?
             WHERE id = ?`,
          [commissionEarned, customerDiscount, affiliateId]);
      }
      if ((body.status || "completed") === "completed") recalculateCustomerCredits();
      return sendJson(res, 201, get("SELECT * FROM quotes WHERE id = ?", [quoteId]));
    }
  }
  return sendJson(res, 404, { error: "API route not found" });
}

const mime = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".sqlite": "application/octet-stream"
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    try { await handleApi(req, res, url); }
    catch (error) { sendJson(res, 500, { error: error.message }); }
    return;
  }
  let relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep) && file !== root) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Page not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(3000, "127.0.0.1", () => {
  console.log("Digital Services Admin: http://127.0.0.1:3000");
});
