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
const DATA_DIR = path.join(__dirname, "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const PUBLIC_DIR = path.join(__dirname, "public");
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

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const rateLimitBuckets = new Map();

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
      companies: [
        {
          id: crypto.randomUUID(),
          name: "サンプル株式会社",
          status: "エントリー済み",
          memo: "求人内容と応募書類を確認中",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          comments: [
            {
              id: crypto.randomUUID(),
              author: "キャリア相談者",
              body: "志望理由の具体性をもう少し足すと伝わりやすそうです。",
              createdAt: new Date().toISOString()
            }
          ]
        }
      ]
    };
    fs.writeFileSync(STORE_PATH, JSON.stringify(starter, null, 2));
  }
}

function readStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
}

function writeStore(store) {
  ensureStore();
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
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

function safeCompany(company) {
  return {
    id: company.id,
    name: company.name,
    status: company.status,
    memo: company.memo,
    createdAt: company.createdAt,
    updatedAt: company.updatedAt,
    comments: company.comments || []
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
    const store = readStore();
    sendJson(res, 200, {
      statuses: STATUSES,
      companies: store.companies.map(safeCompany)
    });
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
    const memo = cleanText(body.memo, 500);

    if (!name) {
      sendError(res, 400, "会社名を入力してください。");
      return;
    }

    const now = new Date().toISOString();
    const store = readStore();
    const company = {
      id: crypto.randomUUID(),
      name,
      status,
      memo,
      createdAt: now,
      updatedAt: now,
      comments: []
    };
    store.companies.unshift(company);
    writeStore(store);
    sendJson(res, 201, { company: safeCompany(company) });
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
    const store = readStore();
    const company = store.companies.find((item) => item.id === companyMatch[1]);
    if (!company) {
      sendError(res, 404, "会社が見つかりません。");
      return;
    }

    const name = cleanText(body.name, 120);
    if (!name) {
      sendError(res, 400, "会社名を入力してください。");
      return;
    }

    company.name = name;
    company.status = STATUSES.includes(body.status) ? body.status : company.status;
    company.memo = cleanText(body.memo, 500);
    company.updatedAt = new Date().toISOString();
    writeStore(store);
    sendJson(res, 200, { company: safeCompany(company) });
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

    const store = readStore();
    const before = store.companies.length;
    store.companies = store.companies.filter((item) => item.id !== companyMatch[1]);
    if (store.companies.length === before) {
      sendError(res, 404, "会社が見つかりません。");
      return;
    }
    writeStore(store);
    sendJson(res, 200, { ok: true });
    return;
  }

  const commentMatch = url.pathname.match(/^\/api\/companies\/([^/]+)\/comments$/);
  if (commentMatch && method === "POST") {
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

    const store = readStore();
    const company = store.companies.find((item) => item.id === commentMatch[1]);
    if (!company) {
      sendError(res, 404, "会社が見つかりません。");
      return;
    }

    const comment = {
      id: crypto.randomUUID(),
      author,
      body: commentBody,
      createdAt: new Date().toISOString()
    };
    company.comments = company.comments || [];
    company.comments.unshift(comment);
    writeStore(store);
    sendJson(res, 201, { comment });
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

ensureStore();
server.listen(PORT, () => {
  console.log(`Job hunt progress app running at http://localhost:${PORT}`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log("Using default admin password. Set ADMIN_PASSWORD before publishing.");
  }
});
