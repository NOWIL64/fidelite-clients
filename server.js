const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { URL } = require("url");

const fsp = fs.promises;

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = process.env.DATA_FILE_PATH || path.join(DATA_DIR, "db.json");
const STORAGE_BACKEND = (
  process.env.STORAGE_BACKEND ||
  (process.env.DATABASE_URL ? "postgres" : "file")
)
  .toLowerCase()
  .trim();
const POSTGRES_SSL_DISABLED = process.env.PGSSLMODE === "disable";

const MAX_COUNTER = 3;
const SAVE_INDENT = 2;

const DEFAULT_DB = {
  clients: [],
  alerts: [],
  settings: {
    autoReset: {
      enabled: false,
      time: "09:00",
      lastRunDate: null
    }
  },
  meta: {
    updatedAt: null,
    lastPersistedAt: null
  }
};

let db = clone(DEFAULT_DB);
let persistQueue = Promise.resolve();
let autosaveError = null;
const sseClients = new Set();
let sseHeartbeat = null;
let pgPool = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function clampCounter(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_COUNTER, Math.round(value)));
}

function normalizeText(value, max = 80) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, max);
}

function validateDepartment(value) {
  if (!value) return false;
  return /^(?:\d{2,3}|2A|2B|[A-Za-z0-9-]{1,5})$/.test(value);
}

function ensureClientPayload(payload, partial = false) {
  const incoming = payload && typeof payload === "object" ? payload : {};
  const firstName = normalizeText(incoming.firstName, 60);
  const lastName = normalizeText(incoming.lastName, 60);
  const city = normalizeText(incoming.city, 60);
  const department = normalizeText(String(incoming.department || ""), 10).toUpperCase();
  const errors = [];

  if (!partial || "firstName" in incoming) {
    if (!firstName) errors.push("Le prenom est obligatoire.");
  }
  if (!partial || "lastName" in incoming) {
    if (!lastName) errors.push("Le nom est obligatoire.");
  }
  if (!partial || "city" in incoming) {
    if (!city) errors.push("La ville est obligatoire.");
  }
  if (!partial || "department" in incoming) {
    if (!department || !validateDepartment(department)) {
      errors.push("Le departement est invalide (ex: 75, 2A, 971).");
    }
  }

  return {
    errors,
    data: {
      firstName,
      lastName,
      city,
      department
    }
  };
}

async function ensureDbFile() {
  await fsp.mkdir(DATA_DIR, { recursive: true });

  try {
    await fsp.access(DATA_FILE, fs.constants.F_OK);
  } catch {
    db.meta.updatedAt = nowIso();
    db.meta.lastPersistedAt = nowIso();
    await fsp.writeFile(DATA_FILE, JSON.stringify(db, null, SAVE_INDENT), "utf8");
  }
}

function normalizeDbShape(raw) {
  const normalized = clone(DEFAULT_DB);
  if (raw && typeof raw === "object") {
    if (Array.isArray(raw.clients)) normalized.clients = raw.clients;
    if (Array.isArray(raw.alerts)) normalized.alerts = raw.alerts;
    if (raw.settings && typeof raw.settings === "object") {
      normalized.settings.autoReset.enabled = !!raw.settings.autoReset?.enabled;
      const configuredTime = normalizeText(raw.settings.autoReset?.time || "09:00", 5);
      normalized.settings.autoReset.time = /^\d{2}:\d{2}$/.test(configuredTime)
        ? configuredTime
        : "09:00";
      normalized.settings.autoReset.lastRunDate =
        typeof raw.settings.autoReset?.lastRunDate === "string"
          ? raw.settings.autoReset.lastRunDate
          : null;
    }
    if (raw.meta && typeof raw.meta === "object") {
      normalized.meta.updatedAt =
        typeof raw.meta.updatedAt === "string" ? raw.meta.updatedAt : null;
      normalized.meta.lastPersistedAt =
        typeof raw.meta.lastPersistedAt === "string" ? raw.meta.lastPersistedAt : null;
    }
  }

  normalized.clients = normalized.clients
    .filter((c) => c && typeof c === "object")
    .map((client) => ({
      id: typeof client.id === "string" ? client.id : crypto.randomUUID(),
      firstName: normalizeText(client.firstName, 60),
      lastName: normalizeText(client.lastName, 60),
      city: normalizeText(client.city, 60),
      department: normalizeText(String(client.department || ""), 10).toUpperCase(),
      counter: clampCounter(client.counter),
      important: clampCounter(client.counter) === MAX_COUNTER,
      createdAt: typeof client.createdAt === "string" ? client.createdAt : nowIso(),
      updatedAt: typeof client.updatedAt === "string" ? client.updatedAt : nowIso()
    }))
    .filter(
      (c) => c.firstName && c.lastName && c.city && c.department && validateDepartment(c.department)
    );

  normalized.alerts = normalized.alerts
    .filter((a) => a && typeof a === "object")
    .map((alert) => ({
      id: typeof alert.id === "string" ? alert.id : crypto.randomUUID(),
      type: normalizeText(alert.type || "INFO", 20).toUpperCase() || "INFO",
      clientId: typeof alert.clientId === "string" ? alert.clientId : null,
      message: normalizeText(alert.message, 240),
      createdAt: typeof alert.createdAt === "string" ? alert.createdAt : nowIso(),
      read: !!alert.read
    }))
    .filter((a) => a.message);

  return normalized;
}

async function initPostgresStorage() {
  let Pool;
  try {
    ({ Pool } = require("pg"));
  } catch (error) {
    throw new Error(
      "Le mode postgres est active mais la dependance 'pg' est absente. Lancez: npm install"
    );
  }

  const ssl = POSTGRES_SSL_DISABLED ? false : { rejectUnauthorized: false };
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl
  });

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const bootstrapState = JSON.stringify(clone(DEFAULT_DB));
  await pgPool.query(
    `
      INSERT INTO app_state (id, data)
      VALUES (1, $1::jsonb)
      ON CONFLICT (id) DO NOTHING
    `,
    [bootstrapState]
  );
}

async function readStateFromStorage() {
  if (STORAGE_BACKEND === "postgres") {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL est obligatoire quand STORAGE_BACKEND=postgres.");
    }
    await initPostgresStorage();
    const result = await pgPool.query("SELECT data FROM app_state WHERE id = 1");
    if (!result.rows[0]?.data) {
      return clone(DEFAULT_DB);
    }
    return result.rows[0].data;
  }

  await ensureDbFile();
  const raw = await fsp.readFile(DATA_FILE, "utf8");
  return JSON.parse(raw);
}

async function writeStateToStorage() {
  if (STORAGE_BACKEND === "postgres") {
    if (!pgPool) {
      throw new Error("Connexion PostgreSQL indisponible.");
    }
    await pgPool.query(
      `
        INSERT INTO app_state (id, data, updated_at)
        VALUES (1, $1::jsonb, NOW())
        ON CONFLICT (id)
        DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
      `,
      [JSON.stringify(db)]
    );
    return;
  }

  await fsp.writeFile(DATA_FILE, JSON.stringify(db, null, SAVE_INDENT), "utf8");
}

async function loadDb() {
  const raw = await readStateFromStorage();
  db = normalizeDbShape(raw);
  const now = nowIso();
  db.meta.updatedAt = db.meta.updatedAt || now;
  db.meta.lastPersistedAt = db.meta.lastPersistedAt || now;
}

function queuePersist(reason = "update") {
  const now = nowIso();
  db.meta.updatedAt = now;
  db.meta.lastPersistedAt = now;
  autosaveError = null;

  persistQueue = persistQueue
    .catch(() => undefined)
    .then(async () => {
      await writeStateToStorage();
    })
    .catch((error) => {
      autosaveError = error.message || String(error);
      console.error(`[autosave:${reason}]`, error);
    });

  return persistQueue;
}

async function closeStorage() {
  if (pgPool) {
    try {
      await pgPool.end();
    } catch (error) {
      console.error("Erreur fermeture PostgreSQL:", error);
    } finally {
      pgPool = null;
    }
  }
}

function createAlert({ type = "INFO", clientId = null, message }) {
  const text = normalizeText(message, 240);
  if (!text) return;
  db.alerts.unshift({
    id: crypto.randomUUID(),
    type: normalizeText(type, 20).toUpperCase() || "INFO",
    clientId,
    message: text,
    createdAt: nowIso(),
    read: false
  });

  if (db.alerts.length > 200) {
    db.alerts = db.alerts.slice(0, 200);
  }
}

function updateClientCounter(client, nextValue, reasonLabel = "Mise a jour compteur") {
  const previous = client.counter;
  const clamped = clampCounter(nextValue);
  client.counter = clamped;
  client.important = clamped === MAX_COUNTER;
  client.updatedAt = nowIso();

  if (previous < MAX_COUNTER && clamped === MAX_COUNTER) {
    createAlert({
      type: "IMPORTANT",
      clientId: client.id,
      message: `${client.firstName} ${client.lastName} a atteint le compteur maximum (${MAX_COUNTER}).`
    });
  }

  if (previous !== clamped) {
    createAlert({
      type: "INFO",
      clientId: client.id,
      message: `${reasonLabel}: ${client.firstName} ${client.lastName} -> ${clamped}/${MAX_COUNTER}`
    });
  }
}

function getDashboardSnapshot() {
  const total = db.clients.length;
  const important = db.clients.filter((c) => c.counter === MAX_COUNTER).length;
  const readAlerts = db.alerts.filter((a) => a.read).length;
  const unreadAlerts = db.alerts.length - readAlerts;
  const avgCounter =
    total === 0
      ? 0
      : Number((db.clients.reduce((sum, c) => sum + c.counter, 0) / total).toFixed(2));

  const byDepartment = {};
  for (const client of db.clients) {
    byDepartment[client.department] = (byDepartment[client.department] || 0) + 1;
  }

  return {
    totalClients: total,
    importantClients: important,
    averageCounter: avgCounter,
    unreadAlerts,
    byDepartment
  };
}

function buildState() {
  return {
    clients: [...db.clients].sort((a, b) => a.lastName.localeCompare(b.lastName, "fr")),
    alerts: [...db.alerts].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    settings: clone(db.settings),
    dashboard: getDashboardSnapshot(),
    meta: {
      updatedAt: db.meta.updatedAt,
      lastPersistedAt: db.meta.lastPersistedAt,
      autosaveError,
      onlineUsers: sseClients.size
    }
  };
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(body);
}

function sendNoContent(res, statusCode = 204) {
  res.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end();
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > 1_000_000) {
        reject(new Error("Payload trop volumineux."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("JSON invalide."));
      }
    });
    req.on("error", reject);
  });
}

function broadcastState(event = "state") {
  const payload = JSON.stringify(buildState());
  for (const res of sseClients) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${payload}\n\n`);
  }
}

function startHeartbeat() {
  if (sseHeartbeat) return;
  sseHeartbeat = setInterval(() => {
    for (const res of sseClients) {
      res.write(`event: ping\n`);
      res.write(`data: {"time":"${nowIso()}"}\n\n`);
    }
  }, 20_000);
}

function maybeStopHeartbeat() {
  if (sseClients.size === 0 && sseHeartbeat) {
    clearInterval(sseHeartbeat);
    sseHeartbeat = null;
  }
}

function findClientById(id) {
  return db.clients.find((client) => client.id === id) || null;
}

function updateAutomationFromBody(body) {
  const enabled = !!body?.enabled;
  const time = normalizeText(body?.time || "", 5);
  if (!/^\d{2}:\d{2}$/.test(time)) {
    return { error: "Format horaire invalide (HH:MM)." };
  }
  const [hours, minutes] = time.split(":").map(Number);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return { error: "Heure invalide." };
  }
  db.settings.autoReset.enabled = enabled;
  db.settings.autoReset.time = time;
  return { error: null };
}

function runAutomationCheck() {
  const autoReset = db.settings.autoReset;
  if (!autoReset?.enabled) return;
  if (!/^\d{2}:\d{2}$/.test(autoReset.time)) return;

  const now = new Date();
  const [targetH, targetM] = autoReset.time.split(":").map(Number);
  const today = localDateKey(now);
  if (autoReset.lastRunDate === today) return;

  const shouldRun =
    now.getHours() > targetH || (now.getHours() === targetH && now.getMinutes() >= targetM);

  if (!shouldRun) return;

  let resetCount = 0;
  for (const client of db.clients) {
    if (client.counter > 0) {
      updateClientCounter(client, 0, "Automatisation reset quotidien");
      resetCount += 1;
    }
  }
  autoReset.lastRunDate = today;

  createAlert({
    type: "INFO",
    message:
      resetCount > 0
        ? `Automatisation: ${resetCount} compteur(s) reinitialise(s).`
        : "Automatisation: aucun compteur a reinitialiser."
  });

  queuePersist("automation");
  broadcastState("state");
}

function sendStaticFile(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, requested);
  const normalized = path.normalize(filePath);

  if (!normalized.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Acces refuse." });
    return;
  }

  fs.readFile(normalized, (error, data) => {
    if (error) {
      if (error.code === "ENOENT") {
        sendJson(res, 404, { error: "Fichier introuvable." });
        return;
      }
      sendJson(res, 500, { error: "Erreur de lecture du fichier." });
      return;
    }

    const ext = path.extname(normalized).toLowerCase();
    const mimeTypes = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".webmanifest": "application/manifest+json; charset=utf-8"
    };

    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(data);
  });
}

async function handleApi(req, res, pathname) {
  if (req.method === "OPTIONS") {
    sendNoContent(res);
    return;
  }

  if (req.method === "GET" && pathname === "/api/state") {
    sendJson(res, 200, buildState());
    return;
  }

  if (req.method === "POST" && pathname === "/api/clients") {
    const body = await parseBody(req);
    const { errors, data } = ensureClientPayload(body, false);
    if (errors.length > 0) {
      sendJson(res, 400, { error: errors.join(" ") });
      return;
    }

    const client = {
      id: crypto.randomUUID(),
      firstName: data.firstName,
      lastName: data.lastName,
      city: data.city,
      department: data.department,
      counter: 0,
      important: false,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    db.clients.push(client);
    createAlert({
      type: "INFO",
      clientId: client.id,
      message: `Nouveau client ajoute: ${client.firstName} ${client.lastName}.`
    });
    await queuePersist("create-client");
    broadcastState();
    sendJson(res, 201, { ok: true, client });
    return;
  }

  const editClientMatch = pathname.match(/^\/api\/clients\/([^/]+)$/);
  if (req.method === "PUT" && editClientMatch) {
    const clientId = decodeURIComponent(editClientMatch[1]);
    const client = findClientById(clientId);
    if (!client) {
      sendJson(res, 404, { error: "Client introuvable." });
      return;
    }

    const body = await parseBody(req);
    const { errors, data } = ensureClientPayload(body, true);
    if (errors.length > 0) {
      sendJson(res, 400, { error: errors.join(" ") });
      return;
    }

    if (data.firstName) client.firstName = data.firstName;
    if (data.lastName) client.lastName = data.lastName;
    if (data.city) client.city = data.city;
    if (data.department) client.department = data.department;
    client.updatedAt = nowIso();

    createAlert({
      type: "INFO",
      clientId: client.id,
      message: `Client modifie: ${client.firstName} ${client.lastName}.`
    });

    await queuePersist("edit-client");
    broadcastState();
    sendJson(res, 200, { ok: true, client });
    return;
  }

  const counterMatch = pathname.match(/^\/api\/clients\/([^/]+)\/counter$/);
  if (req.method === "PATCH" && counterMatch) {
    const clientId = decodeURIComponent(counterMatch[1]);
    const client = findClientById(clientId);
    if (!client) {
      sendJson(res, 404, { error: "Client introuvable." });
      return;
    }

    const body = await parseBody(req);
    let nextCounter = client.counter;
    if (typeof body.value === "number") {
      nextCounter = body.value;
    } else if (typeof body.delta === "number") {
      nextCounter = client.counter + body.delta;
    } else {
      sendJson(res, 400, { error: "Fournir value ou delta pour le compteur." });
      return;
    }

    updateClientCounter(client, nextCounter, "Mise a jour manuelle");
    await queuePersist("counter-update");
    broadcastState();
    sendJson(res, 200, { ok: true, client });
    return;
  }

  const resetMatch = pathname.match(/^\/api\/clients\/([^/]+)\/reset$/);
  if (req.method === "POST" && resetMatch) {
    const clientId = decodeURIComponent(resetMatch[1]);
    const client = findClientById(clientId);
    if (!client) {
      sendJson(res, 404, { error: "Client introuvable." });
      return;
    }
    updateClientCounter(client, 0, "Reset compteur");
    await queuePersist("counter-reset");
    broadcastState();
    sendJson(res, 200, { ok: true, client });
    return;
  }

  const markAlertReadMatch = pathname.match(/^\/api\/alerts\/([^/]+)\/read$/);
  if (req.method === "POST" && markAlertReadMatch) {
    const alertId = decodeURIComponent(markAlertReadMatch[1]);
    const alert = db.alerts.find((entry) => entry.id === alertId);
    if (!alert) {
      sendJson(res, 404, { error: "Alerte introuvable." });
      return;
    }
    alert.read = true;
    await queuePersist("alert-read");
    broadcastState();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/alerts/read-all") {
    for (const alert of db.alerts) {
      alert.read = true;
    }
    await queuePersist("alert-read-all");
    broadcastState();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "PUT" && pathname === "/api/settings/automation") {
    const body = await parseBody(req);
    const { error } = updateAutomationFromBody(body);
    if (error) {
      sendJson(res, 400, { error });
      return;
    }

    createAlert({
      type: "INFO",
      message: db.settings.autoReset.enabled
        ? `Automatisation activee (reset quotidien ${db.settings.autoReset.time}).`
        : "Automatisation desactivee."
    });
    await queuePersist("automation-settings");
    broadcastState();
    sendJson(res, 200, { ok: true, settings: db.settings });
    return;
  }

  sendJson(res, 404, { error: "Endpoint introuvable." });
}

function printNetworkHints() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const values of Object.values(interfaces)) {
    for (const item of values || []) {
      if (item.family === "IPv4" && !item.internal) {
        ips.push(item.address);
      }
    }
  }

  const localUrl = `http://localhost:${PORT}`;
  console.log(`\nApplication lancee sur ${localUrl}`);
  if (STORAGE_BACKEND === "postgres") {
    console.log("Stockage: PostgreSQL externe (donnees persistantes).");
  } else {
    console.log(`Stockage: fichier local (${DATA_FILE}).`);
  }
  if (ips.length > 0) {
    console.log("Accessible sur votre reseau local :");
    for (const ip of ips) {
      console.log(`- http://${ip}:${PORT}`);
    }
  } else {
    console.log("Aucune IP locale detectee pour l'acces reseau.");
  }
}

async function bootstrap() {
  if (!["file", "postgres"].includes(STORAGE_BACKEND)) {
    throw new Error(
      `STORAGE_BACKEND invalide: '${STORAGE_BACKEND}'. Valeurs supportees: file, postgres.`
    );
  }

  await loadDb();

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
      const pathname = reqUrl.pathname;

      if (pathname === "/events") {
        if (req.method !== "GET") {
          sendNoContent(res, 405);
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*"
        });
        res.write("retry: 3000\n\n");
        sseClients.add(res);
        startHeartbeat();
        broadcastState("state");

        req.on("close", () => {
          sseClients.delete(res);
          maybeStopHeartbeat();
          broadcastState("state");
        });
        return;
      }

      if (pathname.startsWith("/api/")) {
        await handleApi(req, res, pathname);
        return;
      }

      if (req.method === "GET") {
        sendStaticFile(req, res, pathname);
        return;
      }

      sendNoContent(res, 405);
    } catch (error) {
      console.error("Erreur serveur:", error);
      sendJson(res, 500, { error: "Erreur interne du serveur." });
    }
  });

  setInterval(runAutomationCheck, 30_000);

  server.listen(PORT, HOST, () => {
    printNetworkHints();
  });

  const shutdown = async () => {
    server.close(() => undefined);
    await closeStorage();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

bootstrap().catch((error) => {
  console.error("Echec au demarrage:", error);
  process.exit(1);
});
