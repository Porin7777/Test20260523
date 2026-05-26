const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "password";
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-session-secret-change-me";
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const DATABASE_PROVIDER = (process.env.DATABASE_PROVIDER || "").toLowerCase();
const ORACLE_USER = process.env.ORACLE_USER || "";
const ORACLE_PASSWORD = process.env.ORACLE_PASSWORD || "";
const ORACLE_CONNECT_STRING = process.env.ORACLE_CONNECT_STRING || "";
const MYSQL_HOST = process.env.MYSQL_HOST || "";
const MYSQL_PORT = Number(process.env.MYSQL_PORT || 3306);
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || "";
const MYSQL_USER = process.env.MYSQL_USER || "";
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || "";
const MYSQL_SSL = process.env.MYSQL_SSL === "true";
const MYSQL_CA_CERT = process.env.MYSQL_CA_CERT || "";
const MYSQL_SSL_REJECT_UNAUTHORIZED = process.env.MYSQL_SSL_REJECT_UNAUTHORIZED !== "false";
const MYSQL_URL = process.env.MYSQL_URL || (
  (process.env.DATABASE_URL || "").startsWith("mysql") ? process.env.DATABASE_URL : ""
);
const MAX_BODY_BYTES = 32 * 1024;
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;

const STATUSES = [
  "エントリー済み",
  "書類選考中",
  "一次面接通過",
  "二次面接中",
  "最終面接",
  "内定",
  "辞退・不採用"
];

const DESIRE_LEVELS = [
  "未設定",
  "第一志望",
  "高",
  "中",
  "低"
];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const rateLimitBuckets = new Map();
let oraclePool = null;
let oracledb = null;
let mysqlPool = null;

function shouldUseOracle() {
  return DATABASE_PROVIDER === "oracle" || Boolean(ORACLE_USER && ORACLE_PASSWORD && ORACLE_CONNECT_STRING);
}

function shouldUseMysql() {
  return DATABASE_PROVIDER === "mysql" || Boolean(MYSQL_URL) || Boolean(MYSQL_HOST && MYSQL_DATABASE && MYSQL_USER);
}

function securityHeaders() {
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join("; "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
  };
}

function writeHead(res, statusCode, headers = {}) {
  res.writeHead(statusCode, {
    ...securityHeaders(),
    ...headers
  });
}

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(STORE_PATH)) {
    const starter = {
      todos: [],
      freeComments: [],
      companies: [
        {
          id: crypto.randomUUID(),
          name: "サンプル株式会社",
          status: "エントリー済み",
          desireLevel: "未設定",
          url: "",
          dueDate: "",
          actionItem: "",
          memo: "求人内容と応募書類を確認中",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          comments: []
        }
      ]
    };
    fs.writeFileSync(STORE_PATH, JSON.stringify(starter, null, 2));
  }
}

function readStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(STORE_PATH, "utf8").replace(/^\uFEFF/, ""));
}

function writeStore(store) {
  ensureStore();
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

async function initStorage() {
  if (shouldUseMysql()) {
    await initMysqlStorage();
    return;
  }

  if (!shouldUseOracle()) {
    ensureStore();
    console.log(`Using local JSON storage at ${STORE_PATH}`);
    return;
  }

  if (!ORACLE_USER || !ORACLE_PASSWORD || !ORACLE_CONNECT_STRING) {
    throw new Error("Oracle storage requires ORACLE_USER, ORACLE_PASSWORD, and ORACLE_CONNECT_STRING.");
  }

  oracledb = require("oracledb");
  oracledb.fetchAsString = [oracledb.CLOB];
  oraclePool = await oracledb.createPool({
    user: ORACLE_USER,
    password: ORACLE_PASSWORD,
    connectString: ORACLE_CONNECT_STRING,
    poolMin: 0,
    poolMax: Number(process.env.ORACLE_POOL_MAX || 4),
    poolIncrement: 1
  });
  await ensureOracleSchema();
  console.log("Using Oracle Database storage.");
}

async function initMysqlStorage() {
  if (!MYSQL_HOST || !MYSQL_DATABASE || !MYSQL_USER) {
    if (!MYSQL_URL) {
      throw new Error("MySQL storage requires MYSQL_URL or MYSQL_HOST, MYSQL_DATABASE, and MYSQL_USER.");
    }
  }

  const mysql = require("mysql2/promise");
  const mysqlOptions = MYSQL_URL
    ? parseMysqlUrl(MYSQL_URL)
    : {
        host: MYSQL_HOST,
        port: MYSQL_PORT,
        database: MYSQL_DATABASE,
        user: MYSQL_USER,
        password: MYSQL_PASSWORD
      };
  mysqlPool = mysql.createPool({
    ...mysqlOptions,
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 5),
    namedPlaceholders: true,
    timezone: "Z",
    charset: "utf8mb4",
    ...(MYSQL_SSL ? { ssl: getMysqlSslOptions(mysqlOptions.ssl) } : {})
  });
  await ensureMysqlSchema();
  console.log("Using MySQL storage.");
}

function getMysqlSslOptions(existingSsl) {
  const ssl = typeof existingSsl === "object" && existingSsl ? { ...existingSsl } : {};
  ssl.rejectUnauthorized = MYSQL_SSL_REJECT_UNAUTHORIZED;
  if (MYSQL_CA_CERT) {
    ssl.ca = MYSQL_CA_CERT.includes("-----BEGIN CERTIFICATE-----")
      ? MYSQL_CA_CERT
      : Buffer.from(MYSQL_CA_CERT, "base64").toString("utf8");
  }
  return ssl;
}

function parseMysqlUrl(value) {
  const url = new URL(value);
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: url.searchParams.get("ssl") === "true" ? { rejectUnauthorized: true } : undefined
  };
}

async function ensureMysqlSchema() {
  await mysqlPool.execute(`
    CREATE TABLE IF NOT EXISTS job_companies (
      id VARCHAR(36) PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      status VARCHAR(40) NOT NULL,
      desire_level VARCHAR(40) NOT NULL DEFAULT '未設定',
      company_url VARCHAR(500),
      company_due_date DATE,
      action_item VARCHAR(500),
      memo TEXT,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await mysqlPool.execute(`
    CREATE TABLE IF NOT EXISTS job_comments (
      id VARCHAR(36) PRIMARY KEY,
      company_id VARCHAR(36) NOT NULL,
      author VARCHAR(80) NOT NULL,
      body TEXT NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX job_comments_company_idx (company_id),
      CONSTRAINT job_comments_company_fk
        FOREIGN KEY (company_id) REFERENCES job_companies(id)
      ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await mysqlPool.execute(`
    CREATE TABLE IF NOT EXISTS job_todos (
      id VARCHAR(36) PRIMARY KEY,
      title VARCHAR(160) NOT NULL,
      due_date DATE,
      done TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await mysqlPool.execute(`
    CREATE TABLE IF NOT EXISTS job_free_comments (
      id VARCHAR(36) PRIMARY KEY,
      author VARCHAR(80) NOT NULL,
      body TEXT NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await runMysqlMigration("ALTER TABLE job_companies ADD COLUMN desire_level VARCHAR(40) NOT NULL DEFAULT '未設定'");
  await runMysqlMigration("ALTER TABLE job_companies ADD COLUMN company_url VARCHAR(500)");
  await runMysqlMigration("ALTER TABLE job_companies ADD COLUMN company_due_date DATE");
  await runMysqlMigration("ALTER TABLE job_companies ADD COLUMN action_item VARCHAR(500)");
}

async function runMysqlMigration(sql) {
  try {
    await mysqlPool.execute(sql);
  } catch (error) {
    if (error.code !== "ER_DUP_FIELDNAME") throw error;
  }
}

async function withOracleConnection(callback) {
  const connection = await oraclePool.getConnection();
  try {
    return await callback(connection);
  } finally {
    await connection.close();
  }
}

async function runOracleDdl(connection, sql) {
  try {
    await connection.execute(sql);
  } catch (error) {
    if (![955, 1430].includes(error.errorNum)) throw error;
  }
}

async function ensureOracleSchema() {
  await withOracleConnection(async (connection) => {
    await runOracleDdl(
      connection,
      `CREATE TABLE job_companies (
        id VARCHAR2(36) PRIMARY KEY,
        name VARCHAR2(120) NOT NULL,
        status VARCHAR2(40) NOT NULL,
        desire_level VARCHAR2(40) DEFAULT '未設定' NOT NULL,
        company_url VARCHAR2(500),
        company_due_date DATE,
        action_item VARCHAR2(500),
        memo CLOB,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL
      )`
    );
    await runOracleDdl(
      connection,
      `CREATE TABLE job_comments (
        id VARCHAR2(36) PRIMARY KEY,
        company_id VARCHAR2(36) NOT NULL,
        author VARCHAR2(80) NOT NULL,
        body CLOB NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT job_comments_company_fk
          FOREIGN KEY (company_id) REFERENCES job_companies(id)
          ON DELETE CASCADE
      )`
    );
    await runOracleDdl(connection, "CREATE INDEX job_comments_company_idx ON job_comments(company_id)");
    await runOracleDdl(connection, "ALTER TABLE job_companies ADD desire_level VARCHAR2(40) DEFAULT '未設定' NOT NULL");
    await runOracleDdl(connection, "ALTER TABLE job_companies ADD company_url VARCHAR2(500)");
    await runOracleDdl(connection, "ALTER TABLE job_companies ADD company_due_date DATE");
    await runOracleDdl(connection, "ALTER TABLE job_companies ADD action_item VARCHAR2(500)");
    await runOracleDdl(
      connection,
      `CREATE TABLE job_todos (
        id VARCHAR2(36) PRIMARY KEY,
        title VARCHAR2(160) NOT NULL,
        due_date DATE,
        done NUMBER(1) DEFAULT 0 NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL
      )`
    );
    await runOracleDdl(
      connection,
      `CREATE TABLE job_free_comments (
        id VARCHAR2(36) PRIMARY KEY,
        author VARCHAR2(80) NOT NULL,
        body CLOB NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL
      )`
    );
  });
}

function normalizeDate(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToCompany(row) {
  return {
    id: row.ID,
    name: row.NAME,
    status: row.STATUS,
    desireLevel: row.DESIRE_LEVEL || "未設定",
    url: row.COMPANY_URL || "",
    dueDate: dateOnly(row.COMPANY_DUE_DATE),
    actionItem: row.ACTION_ITEM || "",
    memo: row.MEMO || "",
    createdAt: normalizeDate(row.CREATED_AT),
    updatedAt: normalizeDate(row.UPDATED_AT),
    comments: []
  };
}

function rowToComment(row) {
  return {
    id: row.ID,
    author: row.AUTHOR,
    body: row.BODY || "",
    createdAt: normalizeDate(row.CREATED_AT)
  };
}

function mysqlRowToCompany(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    desireLevel: row.desire_level || "未設定",
    url: row.company_url || "",
    dueDate: dateOnly(row.company_due_date),
    actionItem: row.action_item || "",
    memo: row.memo || "",
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
    comments: []
  };
}

function mysqlRowToComment(row) {
  return {
    id: row.id,
    author: row.author,
    body: row.body || "",
    createdAt: normalizeDate(row.created_at)
  };
}

function mysqlRowToTodo(row) {
  return {
    id: row.id,
    title: row.title,
    dueDate: dateOnly(row.due_date),
    done: Boolean(row.done),
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at)
  };
}

function rowToTodo(row) {
  return {
    id: row.ID,
    title: row.TITLE,
    dueDate: dateOnly(row.DUE_DATE),
    done: Boolean(row.DONE),
    createdAt: normalizeDate(row.CREATED_AT),
    updatedAt: normalizeDate(row.UPDATED_AT)
  };
}

function dateOnly(value) {
  if (!value) return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function safeTodo(todo) {
  return {
    id: todo.id,
    title: todo.title,
    dueDate: todo.dueDate || "",
    done: Boolean(todo.done),
    createdAt: todo.createdAt,
    updatedAt: todo.updatedAt
  };
}

async function listTodos() {
  if (shouldUseMysql()) {
    const [rows] = await mysqlPool.execute(
      `SELECT id, title, due_date, done, created_at, updated_at
       FROM job_todos
       ORDER BY done ASC, COALESCE(due_date, '9999-12-31') ASC, created_at DESC`
    );
    return rows.map(mysqlRowToTodo).map(safeTodo);
  }

  if (!shouldUseOracle()) {
    return (readStore().todos || []).map(safeTodo);
  }

  return withOracleConnection(async (connection) => {
    const result = await connection.execute(
      `SELECT id, title, due_date, done, created_at, updated_at
       FROM job_todos
       ORDER BY done ASC, NVL(due_date, DATE '9999-12-31') ASC, created_at DESC`,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return result.rows.map(rowToTodo).map(safeTodo);
  });
}

async function createTodo({ title, dueDate }) {
  const now = new Date().toISOString();
  const todo = {
    id: crypto.randomUUID(),
    title,
    dueDate,
    done: false,
    createdAt: now,
    updatedAt: now
  };

  if (shouldUseMysql()) {
    await mysqlPool.execute(
      `INSERT INTO job_todos (id, title, due_date, done)
       VALUES (:id, :title, :dueDate, 0)`,
      { id: todo.id, title, dueDate: dueDate || null }
    );
    return safeTodo(todo);
  }

  if (!shouldUseOracle()) {
    const store = readStore();
    store.todos = store.todos || [];
    store.todos.unshift(todo);
    writeStore(store);
    return safeTodo(todo);
  }

  await withOracleConnection(async (connection) => {
    await connection.execute(
      `INSERT INTO job_todos (id, title, due_date, done, created_at, updated_at)
       VALUES (:id, :title, TO_DATE(:dueDate, 'YYYY-MM-DD'), 0, SYSTIMESTAMP, SYSTIMESTAMP)`,
      { id: todo.id, title, dueDate: dueDate || null },
      { autoCommit: true }
    );
  });
  return safeTodo(todo);
}

async function updateTodo(id, { title, dueDate, done }) {
  const now = new Date().toISOString();

  if (shouldUseMysql()) {
    const [result] = await mysqlPool.execute(
      `UPDATE job_todos
       SET title = :title,
           due_date = :dueDate,
           done = :done
       WHERE id = :id`,
      { id, title, dueDate: dueDate || null, done: done ? 1 : 0 }
    );
    if (result.affectedRows === 0) return null;
    return (await listTodos()).find((todo) => todo.id === id) || null;
  }

  if (!shouldUseOracle()) {
    const store = readStore();
    store.todos = store.todos || [];
    const todo = store.todos.find((item) => item.id === id);
    if (!todo) return null;
    todo.title = title;
    todo.dueDate = dueDate;
    todo.done = Boolean(done);
    todo.updatedAt = now;
    writeStore(store);
    return safeTodo(todo);
  }

  return withOracleConnection(async (connection) => {
    const result = await connection.execute(
      `UPDATE job_todos
       SET title = :title,
           due_date = TO_DATE(:dueDate, 'YYYY-MM-DD'),
           done = :done,
           updated_at = SYSTIMESTAMP
       WHERE id = :id`,
      { id, title, dueDate: dueDate || null, done: done ? 1 : 0 },
      { autoCommit: true }
    );
    if (result.rowsAffected === 0) return null;
    return (await listTodos()).find((todo) => todo.id === id) || null;
  });
}

async function deleteTodo(id) {
  if (shouldUseMysql()) {
    const [result] = await mysqlPool.execute("DELETE FROM job_todos WHERE id = :id", { id });
    return result.affectedRows > 0;
  }

  if (!shouldUseOracle()) {
    const store = readStore();
    store.todos = store.todos || [];
    const before = store.todos.length;
    store.todos = store.todos.filter((todo) => todo.id !== id);
    if (store.todos.length === before) return false;
    writeStore(store);
    return true;
  }

  return withOracleConnection(async (connection) => {
    const result = await connection.execute(
      "DELETE FROM job_todos WHERE id = :id",
      { id },
      { autoCommit: true }
    );
    return result.rowsAffected > 0;
  });
}

async function listFreeComments() {
  if (shouldUseMysql()) {
    const [rows] = await mysqlPool.execute(
      `SELECT id, author, body, created_at
       FROM job_free_comments
       ORDER BY created_at DESC`
    );
    return rows.map(mysqlRowToComment);
  }

  if (!shouldUseOracle()) {
    return (readStore().freeComments || []);
  }

  return withOracleConnection(async (connection) => {
    const result = await connection.execute(
      `SELECT id, author, body, created_at
       FROM job_free_comments
       ORDER BY created_at DESC`,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return result.rows.map(rowToComment);
  });
}

async function createFreeComment({ author, body }) {
  const comment = {
    id: crypto.randomUUID(),
    author,
    body,
    createdAt: new Date().toISOString()
  };

  if (shouldUseMysql()) {
    await mysqlPool.execute(
      `INSERT INTO job_free_comments (id, author, body)
       VALUES (:id, :author, :body)`,
      comment
    );
    return comment;
  }

  if (!shouldUseOracle()) {
    const store = readStore();
    store.freeComments = store.freeComments || [];
    store.freeComments.unshift(comment);
    writeStore(store);
    return comment;
  }

  await withOracleConnection(async (connection) => {
    await connection.execute(
      `INSERT INTO job_free_comments (id, author, body, created_at)
       VALUES (:id, :author, :body, SYSTIMESTAMP)`,
      comment,
      { autoCommit: true }
    );
  });
  return comment;
}

async function deleteFreeComment(commentId) {
  if (shouldUseMysql()) {
    const [result] = await mysqlPool.execute("DELETE FROM job_free_comments WHERE id = :commentId", { commentId });
    return result.affectedRows > 0;
  }

  if (!shouldUseOracle()) {
    const store = readStore();
    store.freeComments = store.freeComments || [];
    const before = store.freeComments.length;
    store.freeComments = store.freeComments.filter((comment) => comment.id !== commentId);
    if (store.freeComments.length === before) return false;
    writeStore(store);
    return true;
  }

  return withOracleConnection(async (connection) => {
    const result = await connection.execute(
      "DELETE FROM job_free_comments WHERE id = :commentId",
      { commentId },
      { autoCommit: true }
    );
    return result.rowsAffected > 0;
  });
}

async function listCompanies() {
  if (shouldUseMysql()) {
    const [companyRows] = await mysqlPool.execute(
      `SELECT id, name, status, desire_level, company_url, company_due_date, action_item, memo, created_at, updated_at
       FROM job_companies
       ORDER BY created_at DESC`
    );
    const companies = companyRows.map(mysqlRowToCompany);
    return companies.map(safeCompany);
  }

  if (!shouldUseOracle()) {
    return readStore().companies.map(safeCompany);
  }

  return withOracleConnection(async (connection) => {
    const companyResult = await connection.execute(
      `SELECT id, name, status, desire_level, company_url, company_due_date, action_item, memo, created_at, updated_at
       FROM job_companies
       ORDER BY created_at DESC`,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const companies = companyResult.rows.map(rowToCompany);
    return companies.map(safeCompany);
  });
}

async function createCompany({ name, status, desireLevel, url, dueDate, actionItem, memo }) {
  const now = new Date().toISOString();
  const company = {
    id: crypto.randomUUID(),
    name,
    status,
    desireLevel,
    url,
    dueDate,
    actionItem,
    memo,
    createdAt: now,
    updatedAt: now,
    comments: []
  };

  if (shouldUseMysql()) {
    await mysqlPool.execute(
      `INSERT INTO job_companies (id, name, status, desire_level, company_url, company_due_date, action_item, memo)
       VALUES (:id, :name, :status, :desireLevel, :url, :dueDate, :actionItem, :memo)`,
      { id: company.id, name, status, desireLevel, url, dueDate: dueDate || null, actionItem, memo }
    );
    return safeCompany(company);
  }

  if (!shouldUseOracle()) {
    const store = readStore();
    store.companies.unshift(company);
    writeStore(store);
    return safeCompany(company);
  }

  await withOracleConnection(async (connection) => {
    await connection.execute(
      `INSERT INTO job_companies (id, name, status, desire_level, company_url, company_due_date, action_item, memo, created_at, updated_at)
       VALUES (:id, :name, :status, :desireLevel, :url, TO_DATE(:dueDate, 'YYYY-MM-DD'), :actionItem, :memo, SYSTIMESTAMP, SYSTIMESTAMP)`,
      { id: company.id, name, status, desireLevel, url, dueDate: dueDate || null, actionItem, memo },
      { autoCommit: true }
    );
  });
  return safeCompany(company);
}

async function updateCompany(id, { name, status, desireLevel, url, dueDate, actionItem, memo }) {
  const now = new Date().toISOString();

  if (shouldUseMysql()) {
    const [result] = await mysqlPool.execute(
      `UPDATE job_companies
       SET name = :name,
           status = :status,
           desire_level = :desireLevel,
           company_url = :url,
           company_due_date = :dueDate,
           action_item = :actionItem,
           memo = :memo
       WHERE id = :id`,
      { id, name, status, desireLevel, url, dueDate: dueDate || null, actionItem, memo }
    );
    if (result.affectedRows === 0) return null;
    return (await findCompany(id)) || { id, name, status, desireLevel, url, dueDate, actionItem, memo, createdAt: now, updatedAt: now, comments: [] };
  }

  if (!shouldUseOracle()) {
    const store = readStore();
    const company = store.companies.find((item) => item.id === id);
    if (!company) return null;
    company.name = name;
    company.status = status;
    company.desireLevel = desireLevel;
    company.url = url;
    company.dueDate = dueDate;
    company.actionItem = actionItem;
    company.memo = memo;
    company.updatedAt = now;
    writeStore(store);
    return safeCompany(company);
  }

  return withOracleConnection(async (connection) => {
    const result = await connection.execute(
      `UPDATE job_companies
       SET name = :name,
           status = :status,
           desire_level = :desireLevel,
           company_url = :url,
           company_due_date = TO_DATE(:dueDate, 'YYYY-MM-DD'),
           action_item = :actionItem,
           memo = :memo,
           updated_at = SYSTIMESTAMP
       WHERE id = :id`,
      { id, name, status, desireLevel, url, dueDate: dueDate || null, actionItem, memo },
      { autoCommit: true }
    );
    if (result.rowsAffected === 0) return null;
    return (await findCompany(id)) || { id, name, status, desireLevel, url, dueDate, actionItem, memo, createdAt: now, updatedAt: now, comments: [] };
  });
}

async function deleteCompany(id) {
  if (shouldUseMysql()) {
    const [result] = await mysqlPool.execute("DELETE FROM job_companies WHERE id = :id", { id });
    return result.affectedRows > 0;
  }

  if (!shouldUseOracle()) {
    const store = readStore();
    const before = store.companies.length;
    store.companies = store.companies.filter((item) => item.id !== id);
    if (store.companies.length === before) return false;
    writeStore(store);
    return true;
  }

  return withOracleConnection(async (connection) => {
    const result = await connection.execute(
      "DELETE FROM job_companies WHERE id = :id",
      { id },
      { autoCommit: true }
    );
    return result.rowsAffected > 0;
  });
}

async function findCompany(id) {
  return (await listCompanies()).find((company) => company.id === id) || null;
}

async function createComment(companyId, { author, body }) {
  const comment = {
    id: crypto.randomUUID(),
    author,
    body,
    createdAt: new Date().toISOString()
  };

  if (shouldUseMysql()) {
    const [companyRows] = await mysqlPool.execute("SELECT id FROM job_companies WHERE id = :companyId", { companyId });
    if (companyRows.length === 0) return null;

    await mysqlPool.execute(
      `INSERT INTO job_comments (id, company_id, author, body)
       VALUES (:id, :companyId, :author, :body)`,
      { ...comment, companyId }
    );
    return comment;
  }

  if (!shouldUseOracle()) {
    const store = readStore();
    const company = store.companies.find((item) => item.id === companyId);
    if (!company) return null;
    company.comments = company.comments || [];
    company.comments.unshift(comment);
    writeStore(store);
    return comment;
  }

  return withOracleConnection(async (connection) => {
    const companyResult = await connection.execute(
      "SELECT id FROM job_companies WHERE id = :companyId",
      { companyId }
    );
    if (companyResult.rows.length === 0) return null;

    await connection.execute(
      `INSERT INTO job_comments (id, company_id, author, body, created_at)
       VALUES (:id, :companyId, :author, :body, SYSTIMESTAMP)`,
      { ...comment, companyId },
      { autoCommit: true }
    );
    return comment;
  });
}

async function deleteComment(commentId) {
  if (shouldUseMysql()) {
    const [result] = await mysqlPool.execute("DELETE FROM job_comments WHERE id = :commentId", { commentId });
    return result.affectedRows > 0;
  }

  if (!shouldUseOracle()) {
    const store = readStore();
    let deleted = false;
    store.companies.forEach((company) => {
      const comments = company.comments || [];
      const before = comments.length;
      company.comments = comments.filter((comment) => comment.id !== commentId);
      if (company.comments.length !== before) deleted = true;
    });
    if (!deleted) return false;
    writeStore(store);
    return true;
  }

  return withOracleConnection(async (connection) => {
    const result = await connection.execute(
      "DELETE FROM job_comments WHERE id = :commentId",
      { commentId },
      { autoCommit: true }
    );
    return result.rowsAffected > 0;
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  writeHead(res, statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((cookie) => cookie.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)])
  );
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function rateLimit(req, key, limit, windowMs) {
  const now = Date.now();
  const bucketKey = `${key}:${getClientIp(req)}`;
  const bucket = rateLimitBuckets.get(bucketKey) || { count: 0, resetAt: now + windowMs };

  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }

  bucket.count += 1;
  rateLimitBuckets.set(bucketKey, bucket);

  if (bucket.count > limit) {
    return Math.ceil((bucket.resetAt - now) / 1000);
  }
  return 0;
}

function isSameOrigin(req) {
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (!origin || !host) return true;

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function setCookie(res, name, value, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path || "/"}`,
    `SameSite=${options.sameSite || "Strict"}`
  ];

  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (IS_PRODUCTION || options.secure) parts.push("Secure");

  const existing = res.getHeader("Set-Cookie");
  const cookie = parts.join("; ");
  if (!existing) {
    res.setHeader("Set-Cookie", cookie);
  } else if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, cookie]);
  } else {
    res.setHeader("Set-Cookie", [existing, cookie]);
  }
}

function getOrCreateCsrfToken(req, res) {
  const cookies = parseCookies(req);
  if (cookies.csrf && /^[A-Za-z0-9_-]{32,128}$/.test(cookies.csrf)) {
    return cookies.csrf;
  }

  const token = crypto.randomBytes(32).toString("base64url");
  setCookie(res, "csrf", token, { maxAge: SESSION_MAX_AGE_SECONDS, sameSite: "Strict" });
  return token;
}

function requireSameOrigin(req, res) {
  if (isSameOrigin(req)) return true;
  sendError(res, 403, "不正な送信元からのリクエストです。");
  return false;
}

function requireCsrf(req, res) {
  if (!requireSameOrigin(req, res)) return false;

  const csrfCookie = parseCookies(req).csrf;
  const csrfHeader = req.headers["x-csrf-token"];
  if (csrfCookie && csrfHeader && csrfCookie === csrfHeader) return true;

  sendError(res, 403, "セキュリティ確認に失敗しました。ページを再読み込みしてください。");
  return false;
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    crypto.timingSafeEqual(leftBuffer, leftBuffer);
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyPassword(password) {
  if (ADMIN_PASSWORD_HASH) {
    const [scheme, iterations, salt, expectedHash] = ADMIN_PASSWORD_HASH.split("$");
    if (scheme !== "pbkdf2" || !iterations || !salt || !expectedHash) return false;

    const candidate = crypto
      .pbkdf2Sync(String(password), salt, Number(iterations), 64, "sha512")
      .toString("base64url");
    return timingSafeStringEqual(candidate, expectedHash);
  }

  return timingSafeStringEqual(password, ADMIN_PASSWORD);
}

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}

function createSessionToken(username) {
  const payload = Buffer.from(
    JSON.stringify({
      username,
      exp: Date.now() + SESSION_MAX_AGE_MS,
      sid: crypto.randomUUID()
    })
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function verifySessionToken(token) {
  if (!token || !token.includes(".")) return null;
  const [payload, signature] = token.split(".");
  const expected = sign(payload);
  if (Buffer.byteLength(signature) !== Buffer.byteLength(expected)) return null;
  const valid = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!valid) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.exp || session.exp < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

function getSession(req) {
  return verifySessionToken(parseCookies(req).session);
}

function requireAuth(req, res) {
  const session = getSession(req);
  if (!session) {
    sendError(res, 401, "ログインが必要です。");
    return null;
  }
  return session;
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, maxLength);
}

function cleanUrl(value) {
  let url = cleanText(value, 500);
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }

  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function cleanDate(value) {
  const date = cleanText(value, 10);
  if (!date) return "";
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

function safeCompany(company) {
  return {
    id: company.id,
    name: company.name,
    status: company.status,
    desireLevel: DESIRE_LEVELS.includes(company.desireLevel) ? company.desireLevel : "未設定",
    url: company.url || "",
    dueDate: company.dueDate || "",
    actionItem: company.actionItem || "",
    memo: company.memo,
    createdAt: company.createdAt,
    updatedAt: company.updatedAt
  };
}

function serveStatic(req, res) {
  let rawPath = "/";
  try {
    rawPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  } catch {
    writeHead(res, 400);
    res.end("Bad request");
    return;
  }
  const requestPath = rawPath === "/" ? "/index.html" : rawPath;
  const filePath = path.resolve(path.join(PUBLIC_DIR, requestPath));

  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    writeHead(res, 403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      writeHead(res, 404);
      res.end("Not found");
      return;
    }
    writeHead(res, 200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream"
    });
    res.end(content);
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;

  if (method === "GET" && url.pathname === "/api/me") {
    const session = getSession(req);
    sendJson(res, 200, {
      authenticated: Boolean(session),
      username: session?.username || null,
      csrfToken: getOrCreateCsrfToken(req, res)
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/app-data") {
    const [companies, todos, comments] = await Promise.all([
      listCompanies(),
      listTodos(),
      listFreeComments()
    ]);
    sendJson(res, 200, {
      statuses: STATUSES,
      desireLevels: DESIRE_LEVELS,
      companies,
      todos,
      comments
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/login") {
    if (!requireSameOrigin(req, res)) return;
    const retryAfter = rateLimit(req, "login", 6, 15 * 60 * 1000);
    if (retryAfter) {
      res.setHeader("Retry-After", String(retryAfter));
      sendError(res, 429, "ログイン試行が多すぎます。しばらくしてから再試行してください。");
      return;
    }

    const body = await collectBody(req);
    const username = cleanText(body.username, 80);
    const password = String(body.password || "");

    if (!timingSafeStringEqual(username, ADMIN_USERNAME) || !verifyPassword(password)) {
      sendError(res, 401, "ユーザー名またはパスワードが違います。");
      return;
    }

    const token = createSessionToken(username);
    const csrfToken = crypto.randomBytes(32).toString("base64url");
    setCookie(res, "session", token, {
      httpOnly: true,
      maxAge: SESSION_MAX_AGE_SECONDS,
      sameSite: "Strict"
    });
    setCookie(res, "csrf", csrfToken, {
      maxAge: SESSION_MAX_AGE_SECONDS,
      sameSite: "Strict"
    });
    sendJson(res, 200, { authenticated: true, username, csrfToken });
    return;
  }

  if (method === "POST" && url.pathname === "/api/logout") {
    if (!requireCsrf(req, res)) return;
    setCookie(res, "session", "", { httpOnly: true, maxAge: 0, sameSite: "Strict" });
    setCookie(res, "csrf", "", { maxAge: 0, sameSite: "Strict" });
    sendJson(res, 200, { authenticated: false });
    return;
  }

  if (method === "GET" && url.pathname === "/api/companies") {
    sendJson(res, 200, {
      statuses: STATUSES,
      desireLevels: DESIRE_LEVELS,
      companies: await listCompanies()
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/todos") {
    sendJson(res, 200, { todos: await listTodos() });
    return;
  }

  if (method === "GET" && url.pathname === "/api/free-comments") {
    sendJson(res, 200, { comments: await listFreeComments() });
    return;
  }

  if (method === "POST" && url.pathname === "/api/free-comments") {
    if (!requireCsrf(req, res)) return;
    const retryAfter = rateLimit(req, "comment", 12, 10 * 60 * 1000);
    if (retryAfter) {
      res.setHeader("Retry-After", String(retryAfter));
      sendError(res, 429, "コメント投稿が多すぎます。少し待ってから再試行してください。");
      return;
    }

    const body = await collectBody(req);
    const author = cleanText(body.author, 80) || "匿名";
    const commentBody = cleanText(body.body, 800);
    if (!commentBody) {
      sendError(res, 400, "コメントを入力してください。");
      return;
    }

    sendJson(res, 201, { comment: await createFreeComment({ author, body: commentBody }) });
    return;
  }

  const freeCommentDeleteMatch = url.pathname.match(/^\/api\/free-comments\/([^/]+)$/);
  if (freeCommentDeleteMatch && method === "DELETE") {
    if (!requireCsrf(req, res)) return;
    if (!requireAuth(req, res)) return;
    const retryAfter = rateLimit(req, "admin-write", 60, 60 * 1000);
    if (retryAfter) {
      res.setHeader("Retry-After", String(retryAfter));
      sendError(res, 429, "更新操作が多すぎます。少し待ってから再試行してください。");
      return;
    }

    if (!(await deleteFreeComment(freeCommentDeleteMatch[1]))) {
      sendError(res, 404, "コメントが見つかりません。");
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && url.pathname === "/api/todos") {
    if (!requireCsrf(req, res)) return;
    if (!requireAuth(req, res)) return;
    const retryAfter = rateLimit(req, "admin-write", 60, 60 * 1000);
    if (retryAfter) {
      res.setHeader("Retry-After", String(retryAfter));
      sendError(res, 429, "更新操作が多すぎます。少し待ってから再試行してください。");
      return;
    }

    const body = await collectBody(req);
    const title = cleanText(body.title, 160);
    const dueDate = cleanDate(body.dueDate);
    if (!title) {
      sendError(res, 400, "やることを入力してください。");
      return;
    }

    sendJson(res, 201, { todo: await createTodo({ title, dueDate }) });
    return;
  }

  const todoMatch = url.pathname.match(/^\/api\/todos\/([^/]+)$/);
  if (todoMatch && method === "PUT") {
    if (!requireCsrf(req, res)) return;
    if (!requireAuth(req, res)) return;
    const retryAfter = rateLimit(req, "admin-write", 60, 60 * 1000);
    if (retryAfter) {
      res.setHeader("Retry-After", String(retryAfter));
      sendError(res, 429, "更新操作が多すぎます。少し待ってから再試行してください。");
      return;
    }

    const body = await collectBody(req);
    const title = cleanText(body.title, 160);
    const dueDate = cleanDate(body.dueDate);
    if (!title) {
      sendError(res, 400, "やることを入力してください。");
      return;
    }

    const todo = await updateTodo(todoMatch[1], {
      title,
      dueDate,
      done: Boolean(body.done)
    });
    if (!todo) {
      sendError(res, 404, "やることが見つかりません。");
      return;
    }
    sendJson(res, 200, { todo });
    return;
  }

  if (todoMatch && method === "DELETE") {
    if (!requireCsrf(req, res)) return;
    if (!requireAuth(req, res)) return;
    const retryAfter = rateLimit(req, "admin-write", 60, 60 * 1000);
    if (retryAfter) {
      res.setHeader("Retry-After", String(retryAfter));
      sendError(res, 429, "更新操作が多すぎます。少し待ってから再試行してください。");
      return;
    }

    if (!(await deleteTodo(todoMatch[1]))) {
      sendError(res, 404, "やることが見つかりません。");
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && url.pathname === "/api/companies") {
    if (!requireCsrf(req, res)) return;
    if (!requireAuth(req, res)) return;
    const retryAfter = rateLimit(req, "admin-write", 60, 60 * 1000);
    if (retryAfter) {
      res.setHeader("Retry-After", String(retryAfter));
      sendError(res, 429, "更新操作が多すぎます。少し待ってから再試行してください。");
      return;
    }

    const body = await collectBody(req);
    const name = cleanText(body.name, 120);
    const status = STATUSES.includes(body.status) ? body.status : STATUSES[0];
    const desireLevel = DESIRE_LEVELS.includes(body.desireLevel) ? body.desireLevel : DESIRE_LEVELS[0];
    const url = cleanUrl(body.url);
    const dueDate = cleanDate(body.dueDate);
    const actionItem = cleanText(body.actionItem, 500);
    const memo = cleanText(body.memo, 500);

    if (!name) {
      sendError(res, 400, "会社名を入力してください。");
      return;
    }

    const company = await createCompany({
      name,
      status,
      desireLevel,
      url,
      dueDate,
      actionItem,
      memo
    });
    sendJson(res, 201, { company });
    return;
  }

  const companyMatch = url.pathname.match(/^\/api\/companies\/([^/]+)$/);
  if (companyMatch && method === "PUT") {
    if (!requireCsrf(req, res)) return;
    if (!requireAuth(req, res)) return;
    const retryAfter = rateLimit(req, "admin-write", 60, 60 * 1000);
    if (retryAfter) {
      res.setHeader("Retry-After", String(retryAfter));
      sendError(res, 429, "更新操作が多すぎます。少し待ってから再試行してください。");
      return;
    }

    const body = await collectBody(req);
    const name = cleanText(body.name, 120);
    if (!name) {
      sendError(res, 400, "会社名を入力してください。");
      return;
    }

    const existing = await findCompany(companyMatch[1]);
    const company = await updateCompany(companyMatch[1], {
      name,
      status: STATUSES.includes(body.status) ? body.status : existing?.status || STATUSES[0],
      desireLevel: DESIRE_LEVELS.includes(body.desireLevel) ? body.desireLevel : existing?.desireLevel || DESIRE_LEVELS[0],
      url: cleanUrl(body.url),
      dueDate: cleanDate(body.dueDate),
      actionItem: cleanText(body.actionItem, 500),
      memo: cleanText(body.memo, 500)
    });
    if (!company) {
      sendError(res, 404, "会社が見つかりません。");
      return;
    }
    sendJson(res, 200, { company });
    return;
  }

  if (companyMatch && method === "DELETE") {
    if (!requireCsrf(req, res)) return;
    if (!requireAuth(req, res)) return;
    const retryAfter = rateLimit(req, "admin-write", 60, 60 * 1000);
    if (retryAfter) {
      res.setHeader("Retry-After", String(retryAfter));
      sendError(res, 429, "更新操作が多すぎます。少し待ってから再試行してください。");
      return;
    }

    if (!(await deleteCompany(companyMatch[1]))) {
      sendError(res, 404, "会社が見つかりません。");
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  sendError(res, 404, "APIが見つかりません。");
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res).catch((error) => {
      console.error(error);
      if (error.message === "Request body too large") {
        sendError(res, 413, "送信内容が大きすぎます。");
        return;
      }
      if (error.message === "Invalid JSON") {
        sendError(res, 400, "JSONの形式が正しくありません。");
        return;
      }
      sendError(res, 500, "サーバーエラーが発生しました。");
    });
    return;
  }
  serveStatic(req, res);
});

initStorage()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Job hunt progress app running at http://localhost:${PORT}`);
      if (!process.env.ADMIN_PASSWORD && !process.env.ADMIN_PASSWORD_HASH) {
        console.log("Using default admin password. Set ADMIN_PASSWORD_HASH before publishing.");
      }
    });
  })
  .catch((error) => {
    console.error("Failed to initialize storage:", error);
    process.exit(1);
  });
