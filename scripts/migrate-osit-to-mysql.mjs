// 一次性迁移:PLC(ositplc) SQLite → GoodJob MySQL(表前缀 osit_)
// 用法: node scripts/migrate-osit-to-mysql.mjs [--db-url=mysql://user:pass@host:3306/db] [--visits=replace|append|skip]
// 幂等: 主键表 upsert;visits 默认 replace(清空重灌),append 追加,skip 不动
import { DatabaseSync } from "node:sqlite";
import mysql from "mysql2/promise";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v === undefined ? true : v];
  })
);
const DB_URL = args["db-url"] || process.env.DATABASE_URL || "mysql://goodjob:change_me@127.0.0.1:3306/goodjob_crm_dev";
const VISITS_MODE = args.visits || "replace";
const SQLITE = process.argv.find((a) => a.endsWith(".db")) || "/home/john/文档/PLC/db/ositplc.db";

const sqlite = new DatabaseSync(SQLITE, { readOnly: true });
const all = (sql) => sqlite.prepare(sql).all();
const one = (sql) => sqlite.prepare(sql).get();

const conn = await mysql.createConnection({ uri: DB_URL, multipleStatements: true });

// 表结构(JSON 列一律 TEXT,与 SQLite 版一致,读写 stringify/parse 在 PLC server/db.js)
const SCHEMA = `
CREATE TABLE IF NOT EXISTS osit_products (
  id VARCHAR(64) PRIMARY KEY,
  category VARCHAR(32) NOT NULL DEFAULT 'plc',
  image TEXT NOT NULL,
  images MEDIUMTEXT NOT NULL,
  name MEDIUMTEXT NOT NULL,
  description MEDIUMTEXT NOT NULL,
  features MEDIUMTEXT NOT NULL,
  tags MEDIUMTEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  sort_order INT NOT NULL DEFAULT 0,
  created_at VARCHAR(40), updated_at VARCHAR(40),
  KEY idx_osp_category (category), KEY idx_osp_status (status), KEY idx_osp_sort (sort_order, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS osit_blog_posts (
  slug VARCHAR(190) PRIMARY KEY,
  category VARCHAR(32) NOT NULL DEFAULT 'guide',
  title MEDIUMTEXT NOT NULL,
  intro MEDIUMTEXT NOT NULL,
  sections MEDIUMTEXT NOT NULL,
  excerpt MEDIUMTEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  featured TINYINT(1) NOT NULL DEFAULT 0,
  featured_image TEXT NOT NULL,
  gallery MEDIUMTEXT NOT NULL,
  tags MEDIUMTEXT NOT NULL,
  t_key VARCHAR(190) NOT NULL DEFAULT '',
  seo_title MEDIUMTEXT NOT NULL,
  seo_description MEDIUMTEXT NOT NULL,
  seo_keywords TEXT NOT NULL,
  created_at VARCHAR(40), updated_at VARCHAR(40),
  KEY idx_osbp_status (status), KEY idx_osbp_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS osit_media_items (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  type VARCHAR(16) NOT NULL DEFAULT 'image',
  size INT NOT NULL DEFAULT 0,
  width INT, height INT,
  alt VARCHAR(255) NOT NULL DEFAULT '',
  file_path TEXT NOT NULL,
  created_at VARCHAR(40), updated_at VARCHAR(40)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS osit_reviews (
  id VARCHAR(64) PRIMARY KEY,
  product_id VARCHAR(64),
  author_name VARCHAR(120) NOT NULL DEFAULT '',
  country VARCHAR(60) NOT NULL DEFAULT '',
  avatar TEXT NOT NULL,
  color VARCHAR(60) NOT NULL DEFAULT 'bg-gray-500',
  rating TINYINT NOT NULL DEFAULT 5,
  title MEDIUMTEXT NOT NULL,
  content MEDIUMTEXT NOT NULL,
  helpful_count INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  created_at VARCHAR(40), updated_at VARCHAR(40),
  KEY idx_osr_product (product_id), KEY idx_osr_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS osit_site_settings (
  \`key\` VARCHAR(190) PRIMARY KEY,
  value MEDIUMTEXT NOT NULL,
  updated_at VARCHAR(40)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS osit_admins (
  email VARCHAR(190) PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at VARCHAR(40)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS osit_contact_submissions (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(120) NOT NULL DEFAULT '',
  company VARCHAR(190) NOT NULL DEFAULT '',
  phone VARCHAR(60) NOT NULL DEFAULT '',
  email VARCHAR(190) NOT NULL DEFAULT '',
  message MEDIUMTEXT NOT NULL,
  created_at VARCHAR(40), updated_at VARCHAR(40),
  KEY idx_oscs_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS osit_visits (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  day DATE NOT NULL,
  path VARCHAR(200) NOT NULL DEFAULT '/',
  KEY idx_osv_day (day), KEY idx_osv_day_path (day, path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;
await conn.query(SCHEMA);

// 主键表: upsert
async function upsert(table, rows, pk) {
  if (!rows.length) return 0;
  const cols = Object.keys(rows[0]);
  const q = (c) => `\`${c}\``; // key/value 等保留字
  const sql = `INSERT INTO ${table} (${cols.map(q).join(",")}) VALUES ?
    ON DUPLICATE KEY UPDATE ${cols.filter((c) => c !== pk).map((c) => `${q(c)}=VALUES(${q(c)})`).join(",")}`;
  await conn.query(sql, [rows.map((r) => cols.map((c) => r[c] ?? null))]);
  return rows.length;
}

const products = all("SELECT * FROM products");
const blogs = all("SELECT * FROM blog_posts");
const media = all("SELECT * FROM media_items");
const reviews = all("SELECT * FROM reviews");
const settings = all("SELECT * FROM site_settings");
const admins = all("SELECT * FROM admins");
const contact = all("SELECT * FROM contact_submissions");
const visits = all("SELECT day, path FROM visits");

console.log(`SQLite: products=${products.length} blog=${blogs.length} media=${media.length} reviews=${reviews.length} settings=${settings.length} admins=${admins.length} contact=${contact.length} visits=${visits.length}`);

console.log("products   ->", await upsert("osit_products", products, "id"));
console.log("blog_posts ->", await upsert("osit_blog_posts", blogs, "slug"));
console.log("media      ->", await upsert("osit_media_items", media, "id"));
console.log("reviews    ->", await upsert("osit_reviews", reviews, "id"));
console.log("settings   ->", await upsert("osit_site_settings", settings, "key"));
console.log("admins     ->", await upsert("osit_admins", admins, "email"));
console.log("contact    ->", await upsert("osit_contact_submissions", contact, "id"));

if (VISITS_MODE === "replace") {
  await conn.query("DELETE FROM osit_visits");
  if (visits.length) {
    await conn.query("INSERT INTO osit_visits (day, path) VALUES ?", [visits.map((v) => [v.day, v.path])]);
  }
  console.log(`visits     -> ${visits.length} (replace)`);
} else if (VISITS_MODE === "append") {
  if (visits.length) await conn.query("INSERT INTO osit_visits (day, path) VALUES ?", [visits.map((v) => [v.day, v.path])]);
  console.log(`visits     -> ${visits.length} (append)`);
} else {
  console.log("visits     -> skipped");
}

// 校验
for (const t of ["osit_products", "osit_blog_posts", "osit_visits", "osit_site_settings", "osit_admins"]) {
  const [{ n }] = await conn.query(`SELECT COUNT(*) n FROM ${t}`);
  console.log(`verify ${t}: ${n}`);
}
await conn.end();
console.log("done");
