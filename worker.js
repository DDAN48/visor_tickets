const DEFAULT_TREES = ["USAP", "INFRA", "USAC", "EDF", "USAPT", "MBR-Preventivo", "MIC", "gomra.implementaciones"];

const CABA_BOUNDARY = [
  [-34.6235848, -58.3630194],
  [-34.6121890, -58.3660712],
  [-34.5939776, -58.3687415],
  [-34.5801594, -58.3752265],
  [-34.5330345, -58.4633460],
  [-34.5496884, -58.5011115],
  [-34.6164587, -58.5316290],
  [-34.6490078, -58.5285773],
  [-34.6549701, -58.5266699],
  [-34.7051619, -58.4614386],
  [-34.6593631, -58.4183325],
  [-34.6603044, -58.4007849],
  [-34.6615595, -58.3931555],
  [-34.6596769, -58.3824744],
  [-34.6515183, -58.3656897],
  [-34.6358265, -58.3508124],
  [-34.6235848, -58.3630194]
];

const FIELDS = [
  "activityId",
  "resourceId",
  "apptNumber",
  "date",
  "status",
  "activityType",
  "latitude",
  "longitude",
  "streetAddress",
  "workZone",
  "startTime",
  "endTime",
  "duration",
  "travelTime",
  "timeSlot",
  "XA_Node",
  "XA_WorkSubType",
  "XA_Priority",
  "XA_Zone",
  "XA_ORE_Zone",
  "XA_Eventticket",
  "XA_resource_name",
  "XA_ID_Resource",
  "XA_contract_activity",
  "XA_technology_network",
  "XA_Activity_Notes",
  "closure_notes",
  "XA_Complete_Reason",
  "XA_location_end"
];

// Se mantiene el límite original de los endpoints existentes.
const LIMIT = 10000;

// Los endpoints históricos usan su propio límite.
// No hace falta subirlo a 100000 porque hay paginación.
const DUPLICATE_LIMIT = 10000;

const TIMEZONE = "America/Argentina/Buenos_Aires";

/* =========================================================
   CLASIFICACION DE TAREA
   Capa = nueva clasificación operacional
   SubCapa = clasificación histórica anterior
   ========================================================= */

const CONTRACTOR_ALIASES = {
  "CONSTRUCCIONES RD S.A":"CONSTRUCCIONES RD",
  "CONSTRUCCIONES RD S.A.":"CONSTRUCCIONES RD",
  "EPICA NERO S.A.":"EPICA_NERO",
  "EPICA NERO S.A":"EPICA_NERO",
  "INSERTEL S.A.":"INSERTEL",
  "INSERTEL S.A":"INSERTEL",
  "INTEROPTICS S.A.":"INTEROPTICS",
  "INTEROPTICS S.A":"INTEROPTICS",
  "JMC TELECOMUNICACIONES S.A.":"JMC TELECOMUNICACIONES",
  "JMC TELECOMUNICACIONES S.A":"JMC TELECOMUNICACIONES",
  "PEBCOM S.A.":"PEBCOM",
  "PEBCOM S.A":"PEBCOM",
  "SANDERNET S.A.":"SANDERNET",
  "SANDERNET S.A":"SANDERNET",
  "SBC PRODUCCIONES S.A.":"SBC",
  "SBC PRODUCCIONES S.A":"SBC",
  "SERVICIOS INTEGRADOS Y CONSTRUCCIONES ESPECIALES SICE S.A":"SICE",
  "SUR RED S.A":"SUR_RED",
  "SUR RED S.A.":"SUR_RED",
  "TELECAF S.A.":"TELECAF",
  "TELECAF S.A":"TELECAF",
  "TLC PERSONAL-PROPIO":"PERSONAL_PROPIO"
};

const RULE_CACHE_TTL_MS = 5 * 60 * 1000;

let RULE_CACHE = {
  expiresAt: 0,
  taskRules: null,
  eventRules: null
};


/** Reglas D1: lectura pequeña, cache local 5 minutos por instancia. */
async function loadBusinessRules(env) {
  if (!env.DB) throw new Error("Falta el binding D1 DB (base nodos).");
  const now = Date.now();
  if (RULE_CACHE.taskRules && RULE_CACHE.eventRules && RULE_CACHE.expiresAt > now) {
    return RULE_CACHE;
  }

  const [tasks, events] = await Promise.all([
    env.DB.prepare("SELECT sigla, capa, subcapa, tipificacion FROM reglas_tareas").all(),
    env.DB.prepare("SELECT sigla, origen FROM reglas_eventos").all()
  ]);
  const taskRows = tasks.results || [];
  const eventRows = events.results || [];
  if (!taskRows.length || !eventRows.length) {
    throw new Error("Las tablas reglas_tareas y reglas_eventos deben contener registros en D1.");
  }

  const taskRules = new Map();
  for (const row of taskRows) {
    const sigla = String(row.sigla || "").trim().toUpperCase();
    if (!sigla) continue;
    taskRules.set(sigla, {
      capa: row.capa || "#N/D",
      subcapa: row.subcapa || "#N/D",
      tipificacion: row.tipificacion || ""
    });
  }
  const eventRules = new Map();
  for (const row of eventRows) {
    const sigla = String(row.sigla || "").trim().toUpperCase();
    if (sigla) eventRules.set(sigla, row.origen || "#N/D");
  }
  // No conservar un cache incompleto si D1 falla.
  RULE_CACHE = { expiresAt: now + RULE_CACHE_TTL_MS, taskRules, eventRules };
  return RULE_CACHE;
}


function taskSiglaFromApptNumber(value) {
  const text = String(value || "")
    .trim()
    .toUpperCase();

  const match = text.match(
    /^\d{6}([A-Z]{3})/
  );

  return match
    ? match[1]
    : "";
}


function eventSiglaFromTicket(value) {
  const text = String(value || "")
    .trim()
    .toUpperCase();

  const match = text.match(
    /^\d{6}([A-Z]{2})/
  );

  return match
    ? match[1]
    : "";
}


function dateFromCode(value) {
  const match = String(value || "")
    .trim()
    .match(/^(\d{2})(\d{2})(\d{2})/);

  if (!match) {
    return "";
  }

  return `20${match[1]}-${match[2]}-${match[3]}`;
}


function canonicalContractor(value) {
  const raw = String(value || "").trim();

  if (!raw) return "";

  const upper = raw.toUpperCase();

  return CONTRACTOR_ALIASES[upper]
    ||
    upper;
}


/** Diccionario cerrado proporcionado por operación: SOLO se usa si Oracle no informa contratista. */
const TECH_CONTRACTOR_PATTERNS = [
  [/\b(?:EPICA[\s_-]*NERO|EPICA)\b/, "EPICA_NERO"],
  [/\b(?:RD[\s_-]*CONSTRUCCIONES|CONSTRUCCIONES[\s_-]*RD|RD)\b/, "RD_CONSTRUCCIONES"],
  [/\bSUR[\s_-]*RED\b/, "SUR_RED"],
  [/\bJMC[\s_-]*TELECOMUNICACIONES\b/, "JMC TELECOMUNICACIONES"],
  [/\bPERSONAL[\s_-]*PROPIO\b/, "PERSONAL_PROPIO"],
  [/\bPEBCOM\b/, "PEBCOM"],
  [/\bSICE\b/, "SICE"],
  [/\bINSERTEL\b/, "INSERTEL"],
  [/\bTELECAF\b/, "TELECAF"],
  [/\bSBC\b/, "SBC"],
  [/\bINTEROPTICS\b/, "INTEROPTICS"],
  [/\bSANDERNET\b/, "SANDERNET"],
  [/\bJMC\b/, "JMC"]
];
function isMissingContractor(value) {
  const s = String(value ?? "").trim().toUpperCase().replace(/[\s_-]+/g, " ");
  return !s || s === "SIN CONTRATISTA" || s === "NULL" || s === "N/A";
}
function contractorFromTechnician(item) {
  const name = String(item.XA_resource_name || item.resourceName || item.ResourceName || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  if (!name) return "";
  // Coincidencia de sigla/palabra completa; nunca compara nombres personales.
  for (const [rx, contractor] of TECH_CONTRACTOR_PATTERNS) {
    if (rx.test(name)) return contractor;
  }
  return "";
}

function normalizeNode(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}


function statusLabel(status) {
  const key = String(status || "")
    .trim()
    .toLowerCase();

  if (key === "completed") return "COMPLETADA";
  if (key === "cancelled") return "CANCELADA";

  if (
    key === "notdone"
    ||
    key === "not_done"
    ||
    key === "not-done"
  ) {
    return "NO REALIZADA";
  }

  if (key === "suspended") return "SUSPENDIDA";
  if (key === "started") return "INICIADA";

  if (
    key === "pending"
    ||
    key === "enroute"
  ) {
    return "ASIGNADA";
  }

  return String(status || "-").toUpperCase();
}


async function loadContractorsByNode(
  env,
  nodes
) {
  if (!env.DB) {
    throw new Error(
      "Falta binding D1 DB."
    );
  }

  const normalized =
    [
      ...new Set(
        nodes
          .map(normalizeNode)
          .filter(Boolean)
      )
    ];

  const result = new Map();

  const CHUNK = 80;

  for (
    let i = 0;
    i < normalized.length;
    i += CHUNK
  ) {
    const chunk =
      normalized.slice(
        i,
        i + CHUNK
      );

    const placeholders =
      chunk
        .map(() => "?")
        .join(",");

    const query =
      `SELECT nodo, contratista
       FROM nodos_contratistas
       WHERE nodo IN (${placeholders})`;

    const response =
      await env.DB
        .prepare(query)
        .bind(...chunk)
        .all();

    for (
      const row
      of response.results || []
    ) {
      result.set(
        normalizeNode(row.nodo),
        canonicalContractor(
          row.contratista
        )
      );
    }
  }

  return result;
}


function ageDaysFromDate(value) {
  const date = String(value || "")
    .slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }

  const ts = Date.parse(
    `${date}T00:00:00`
  );

  if (!Number.isFinite(ts)) {
    return null;
  }

  return Math.max(
    0,
    Math.floor(
      (Date.now() - ts)
      /
      86400000
    )
  );
}


async function enrichActivities(
  env,
  items
) {
  const rules =
    await loadBusinessRules(env);

  const missingContractorNodes = [];

  for (const item of items) {
    const direct =
      canonicalContractor(
        item.XA_contract_activity
      );

    if (isMissingContractor(direct) && !contractorFromTechnician(item)) {
      const node =
        normalizeNode(
          item.XA_Node
        );

      if (node) {
        missingContractorNodes.push(node);
      }
    }
  }

  const contractorByNode =
    await loadContractorsByNode(
      env,
      missingContractorNodes
    );

  return items.map(item => {
    const tipif =
      taskSiglaFromApptNumber(
        item.apptNumber
      );

    const taskRule =
      rules.taskRules.get(tipif)
      ||
      {
        capa: "#N/D",
        subcapa: "#N/D",
        tipificacion: ""
      };

    const eventTicket =
      String(
        item.XA_Eventticket || ""
      );

    const eventSigla =
      eventSiglaFromTicket(
        eventTicket
      );

    const direct =
      canonicalContractor(
        item.XA_contract_activity
      );

    const node =
      normalizeNode(
        item.XA_Node
      );

    let contractor =
      direct;

    let contractorSource =
      "oracle";

    if (isMissingContractor(contractor)) {
      const fromTech = contractorFromTechnician(item);
      if (fromTech) {
        contractor = fromTech;
        contractorSource = "tecnico";
      } else {
        contractor = contractorByNode.get(node) || "SIN CONTRATISTA";
        contractorSource = contractor === "SIN CONTRATISTA" ? "sin_match" : "d1:nodo";
      }
    }

    const created =
      dateFromCode(
        item.apptNumber
      );

    const eventDate =
      dateFromCode(
        eventTicket
      );

    return {
      ...item,

      Tarea:
        String(
          item.apptNumber || ""
        ),

      Creado:
        created,

      Nodo:
        String(
          item.XA_Node || ""
        ),

      Tipif:
        tipif,

      TipificacionTarea:
        taskRule.tipificacion,

      Estado:
        statusLabel(
          item.status
        ),

      Capa:
        taskRule.capa,

      SubCapa:
        taskRule.subcapa,

      Origen:
        rules.eventRules.get(
          eventSigla
        )
        ||
        "#N/D",

      TicketEvento:
        eventTicket,

      SiglaEvento:
        eventSigla,

      FechaEvento:
        eventDate,

      Contratista:
        contractor,

      ContratistaFuente:
        contractorSource,

      Agendado:
        String(
          item.date || ""
        ).slice(0, 10),

      StartTime:
        item.startTime
        ??
        null,

      EndTime:
        item.endTime
        ??
        null,

      Tecnico:
        String(
          item.XA_resource_name
          ||
          item.resourceId
          ||
          ""
        ),

      IDRecurso:
        String(
          item.XA_ID_Resource
          ||
          item.resourceId
          ||
          ""
        ),

      AntiguedadDias:
        ageDaysFromDate(
          created
        ),

      AntiguedadEventoDias:
        ageDaysFromDate(
          eventDate
        )
    };
  });
}



function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}


function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");

  const configured = String(env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);

  if (configured.includes("*")) {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Vary": "Origin"
    };
  }

  if (origin && configured.includes(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Vary": "Origin"
    };
  }

  return {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin"
  };
}


function ymdInTimeZone(date, timeZone = TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const get = type => parts.find(p => p.type === type)?.value;

  return `${get("year")}-${get("month")}-${get("day")}`;
}


function addDaysToYmd(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0));
  return dt.toISOString().slice(0, 10);
}


function defaultRange(scope) {
  const from = ymdInTimeZone(new Date());

  // INFRA: hoy + mañana.
  // ALL: hoy + 30 días.
  // Se conserva el comportamiento anterior.
  const daysForward = scope === "all" ? 30 : 1;

  return {
    dateFrom: from,
    dateTo: addDaysToYmd(from, daysForward)
  };
}


function validYmd(value) {
  const text = String(value || "");

  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return false;
  }

  const [y, m, d] = text.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));

  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}


function compareYmd(from, to) {
  return String(from).localeCompare(String(to));
}


function basicAuth(env) {
  const clientId = String(env.OFSC_CLIENT_ID || "").trim();
  const instance = String(env.OFSC_INSTANCE || "").trim();
  const secret = String(env.OFSC_CLIENT_SECRET || "");

  if (!clientId || !instance || !secret) {
    throw new Error("Faltan secretos/configuración del servicio en el Worker.");
  }

  return "Basic " + btoa(`${clientId}@${instance}:${secret}`);
}


/* =========================================================
   ENDPOINTS EXISTENTES
   ========================================================= */

async function fetchTree(env, tree, dateFrom, dateTo) {
  const baseUrl = String(env.OFSC_BASE_URL || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Falta OFSC_BASE_URL.");

  const authorization = basicAuth(env);
  const all = [];
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      resources: tree,
      includeChildren: "all",
      dateFrom,
      dateTo,
      limit: String(LIMIT),
      offset: String(offset),
      fields: FIELDS.join(",")
    });

    const response = await fetch(
      `${baseUrl}/rest/ofscCore/v1/activities?${params.toString()}`,
      {
        method: "GET",
        headers: {
          "Authorization": authorization,
          "Accept": "application/json"
        }
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Consulta ${tree} falló con HTTP ${response.status}: ${body.slice(0, 300)}`
      );
    }

    const data = await response.json();
    const items = Array.isArray(data.items) ? data.items : [];

    for (const item of items) {
      all.push({ ...item, Arbol: tree });
    }

    if (items.length < LIMIT) break;
    offset += LIMIT;
  }

  return all;
}


function normalizeOrder(value) {
  const text = String(value ?? "").trim();

  if (
    !text ||
    text.toLowerCase() === "nan" ||
    text.toLowerCase() === "<na>"
  ) {
    return "";
  }

  return text;
}


function parseOfscTimestamp(value, fallbackDate = "") {
  const raw = String(value || "").trim();

  if (!raw) {
    return Number.NEGATIVE_INFINITY;
  }

  let candidate = raw;

  if (
    /^\d{1,2}:\d{2}(:\d{2})?$/.test(raw) &&
    fallbackDate
  ) {
    candidate = `${fallbackDate}T${raw}`;
  } else {
    candidate = raw.replace(" ", "T");
  }

  const ts = Date.parse(candidate);

  return Number.isFinite(ts)
    ? ts
    : Number.NEGATIVE_INFINITY;
}


function activityFutureTimestamp(item) {
  const date = String(item.date || "").trim();

  // REGLA PRINCIPAL: endTime define cuál intervención
  // ocurrió más hacia el futuro.
  const endTs = parseOfscTimestamp(
    item.endTime,
    date
  );

  if (endTs !== Number.NEGATIVE_INFINITY) {
    return endTs;
  }

  // Fallback solamente si Oracle no devuelve endTime.
  const startTs = parseOfscTimestamp(
    item.startTime,
    date
  );

  if (startTs !== Number.NEGATIVE_INFINITY) {
    return startTs;
  }

  return parseOfscTimestamp(
    date ? `${date}T00:00:00` : ""
  );
}


function isCompletedActivity(item) {
  return (
    String(item.status || "")
      .trim()
      .toLowerCase()
    ===
    "completed"
  );
}


function isCancelledActivity(item) {
  return (
    String(item.status || "")
      .trim()
      .toLowerCase()
    ===
    "cancelled"
  );
}


function isNotDoneActivity(item) {
  const status =
    String(item.status || "")
      .trim()
      .toLowerCase();

  return (
    status === "notdone"
    ||
    status === "not_done"
    ||
    status === "not-done"
  );
}


function terminalActivityPriority(item) {
  if (isCompletedActivity(item)) {
    return 2;
  }

  if (isCancelledActivity(item)) {
    return 1;
  }

  return 0;
}


function dedupeByOrderKeepFurthest(items) {
  const groups = new Map();
  const withoutOrder = [];

  for (const item of items) {
    const order = normalizeOrder(item.apptNumber);

    if (!order) {
      withoutOrder.push(item);
      continue;
    }

    if (!groups.has(order)) {
      groups.set(order, []);
    }

    groups.get(order).push(item);
  }

  const selected = [];

  for (const rows of groups.values()) {
    const terminal = rows.find(
      item =>
        isCompletedActivity(item)
        ||
        isCancelledActivity(item)
        ||
        isNotDoneActivity(item)
    );

    selected.push(
      terminal
      ||
      rows[0]
    );
  }

  return [
    ...selected,
    ...withoutOrder
  ];
}


function parseNum(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}


function pointOnSegment(px, py, x1, y1, x2, y2, eps = 1e-10) {
  const cross =
    (px - x1) * (y2 - y1) -
    (py - y1) * (x2 - x1);

  if (Math.abs(cross) > eps) return false;

  const dot =
    (px - x1) * (px - x2) +
    (py - y1) * (py - y2);

  return dot <= eps;
}


function pointInCaba(lat, lon) {
  if (!Array.isArray(CABA_BOUNDARY) || CABA_BOUNDARY.length < 3) {
    return false;
  }

  let inside = false;

  for (
    let i = 0, j = CABA_BOUNDARY.length - 1;
    i < CABA_BOUNDARY.length;
    j = i++
  ) {
    const yi = CABA_BOUNDARY[i][0];
    const xi = CABA_BOUNDARY[i][1];
    const yj = CABA_BOUNDARY[j][0];
    const xj = CABA_BOUNDARY[j][1];

    if (pointOnSegment(lon, lat, xi, yi, xj, yj)) {
      return true;
    }

    const intersects =
      ((yi > lat) !== (yj > lat)) &&
      (
        lon <
        ((xj - xi) * (lat - yi)) /
          ((yj - yi) || Number.EPSILON) +
        xi
      );

    if (intersects) inside = !inside;
  }

  return inside;
}


function filterInsideCaba(items) {
  const filtered = [];
  let outsideCaba = 0;
  let invalidCoordinates = 0;

  for (const item of items) {
    const lat = parseNum(item.latitude);
    const lon = parseNum(item.longitude);

    if (
      lat === null ||
      lon === null ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      invalidCoordinates++;
      continue;
    }

    if (!pointInCaba(lat, lon)) {
      outsideCaba++;
      continue;
    }

    filtered.push(item);
  }

  return {
    items: filtered,
    outsideCaba,
    invalidCoordinates
  };
}


function resolveScope(pathname, url) {
  if (pathname === "/api/infra") return "infra";
  if (pathname === "/api/all" || pathname === "/api/todos") return "all";

  if (pathname === "/api/activities") {
    const scope = String(
      url.searchParams.get("scope") || "infra"
    ).toLowerCase();

    if (scope === "all" || scope === "todos") return "all";
    if (scope === "infra") return "infra";
  }

  return null;
}



/* =========================================================
   ENDPOINT DE DIAGNOSTICO POR TICKET
   ========================================================= */

function ticketCreationDate(apptNumber) {
  const match = String(apptNumber || "").match(/^(\d{2})(\d{2})(\d{2})/);
  if (!match) return null;

  const year = 2000 + Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dt = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) return null;

  return dt.toISOString().slice(0, 10);
}


async function searchTicketWindow(env, apptNumber, dateFrom, dateTo) {
  const baseUrl = String(env.OFSC_BASE_URL || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Falta OFSC_BASE_URL.");

  const authorization = basicAuth(env);
  const params = new URLSearchParams({
    searchInField: "apptNumber",
    searchForValue: apptNumber,
    dateFrom,
    dateTo,
    includeNonScheduled: "true",
    limit: "1000",
    fields: FIELDS.join(",")
  });

  const response = await fetch(
    `${baseUrl}/rest/ofscCore/v1/activities/custom-actions/search?${params.toString()}`,
    {
      method: "GET",
      headers: {
        "Authorization": authorization,
        "Accept": "application/json"
      }
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Busqueda ${dateFrom} a ${dateTo} falló con HTTP ${response.status}: ${body.slice(0, 700)}`
    );
  }

  const data = await response.json();
  const items = Array.isArray(data.items) ? data.items : [];

  return items.filter(item =>
    String(item.apptNumber || "").trim().toUpperCase() === apptNumber
  );
}


async function handleTicketLookup(request, env, url, cors) {
  const apptNumber = String(
    url.searchParams.get("apptNumber") ||
    url.searchParams.get("ticket") ||
    ""
  ).trim().toUpperCase();

  if (!apptNumber) {
    return jsonResponse({
      ok: false,
      error: "Debe indicar ?apptNumber=NUMERO_TAREA"
    }, 400, cors);
  }

  const encodedDate = ticketCreationDate(apptNumber);
  const today = ymdInTimeZone(new Date());
  const dateFrom = String(
    url.searchParams.get("from") ||
    url.searchParams.get("dateFrom") ||
    encodedDate ||
    addDaysToYmd(today, -90)
  ).trim();
  const dateTo = String(
    url.searchParams.get("to") ||
    url.searchParams.get("dateTo") ||
    addDaysToYmd(today, 30)
  ).trim();

  if (!validYmd(dateFrom) || !validYmd(dateTo)) {
    return jsonResponse({ok:false,error:"from/to deben tener formato YYYY-MM-DD."},400,cors);
  }
  if (compareYmd(dateFrom, dateTo) > 0) {
    return jsonResponse({ok:false,error:"La fecha desde no puede ser posterior a la fecha hasta."},400,cors);
  }

  const windows = splitDateRange(dateFrom,dateTo,31);
  const all = [];
  const errors = [];

  for (const window of windows) {
    try {
      const found = await searchTicketWindow(env,apptNumber,window.dateFrom,window.dateTo);
      all.push(...found.map(item => ({...item,SearchWindowFrom:window.dateFrom,SearchWindowTo:window.dateTo})));
    } catch (error) {
      errors.push({dateFrom:window.dateFrom,dateTo:window.dateTo,error:String(error?.message || error)});
    }
  }

  const seen = new Set();
  const items = [];
  for (const item of all) {
    const key = String(item.activityId ?? `${item.apptNumber}|${item.date}|${item.status}|${item.resourceId}`);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }

  let enrichedItems;

  try {
    enrichedItems =
      await enrichActivities(
        env,
        items
      );
  }
  catch(error) {
    return jsonResponse({
      ok: false,
      error: "No fue posible enriquecer el historial con D1.",
      detail: String(error?.message || error)
    }, 503, cors);
  }

  const statuses = enrichedItems.map(item => ({
    activityId:item.activityId ?? null,
    apptNumber:item.apptNumber ?? null,
    status:item.status ?? null,
    date:item.date ?? null,
    startTime:item.startTime ?? null,
    endTime:item.endTime ?? null,
    resourceId:item.resourceId ?? null,
    resourceName:item.XA_resource_name ?? null,
    contractor:item.XA_contract_activity ?? null,
    eventTicket:item.XA_Eventticket ?? null,
    node:item.XA_Node ?? null,
    completeReason:item.XA_Complete_Reason ?? null,
    closureNotes:item.closure_notes ?? null
  }));

  return jsonResponse({
    ok: errors.length === 0,
    apptNumber,
    encodedCreationDate:encodedDate,
    dateFrom,
    dateTo,
    windows,
    count:items.length,
    statuses,
    errors,
    items: enrichedItems
  }, errors.length === windows.length ? 502 : 200, cors);
}


/* =========================================================
   NUEVOS ENDPOINTS SIN DEDUPLICAR
   ========================================================= */

// Divide un rango largo en bloques de hasta 31 días calendario.
// Ejemplo:
// 2026-07-01 a 2026-09-28
// -> 2026-07-01 / 2026-07-31
// -> 2026-08-01 / 2026-08-31
// -> 2026-09-01 / 2026-09-28
function splitDateRange(dateFrom, dateTo, maxInclusiveDays = 31) {
  const ranges = [];

  let currentFrom = dateFrom;

  while (compareYmd(currentFrom, dateTo) <= 0) {
    const currentToCandidate = addDaysToYmd(
      currentFrom,
      maxInclusiveDays - 1
    );

    const currentTo =
      compareYmd(currentToCandidate, dateTo) > 0
        ? dateTo
        : currentToCandidate;

    ranges.push({
      dateFrom: currentFrom,
      dateTo: currentTo
    });

    currentFrom = addDaysToYmd(currentTo, 1);
  }

  return ranges;
}


function escapeOracleString(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");
}


// Consulta UNA ventana de hasta 31 días para UN árbol.
// Conserva todos los duplicados.
async function fetchTreeDuplicateWindow(
  env,
  tree,
  dateFrom,
  dateTo,
  contractor = ""
) {
  const baseUrl = String(env.OFSC_BASE_URL || "").replace(/\/+$/, "");

  if (!baseUrl) {
    throw new Error("Falta OFSC_BASE_URL.");
  }

  const authorization = basicAuth(env);

  const all = [];
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      resources: tree,
      includeChildren: "all",
      dateFrom,
      dateTo,
      limit: String(DUPLICATE_LIMIT),
      offset: String(offset),
      fields: FIELDS.join(",")
    });

    // Opcional: filtrar por contratista desde Oracle
    // para reducir el volumen devuelto.
    // "SIN CONTRATISTA" representa XA_contract_activity vacío.
    if (contractor) {
      const contractorKey = contractor.trim().toUpperCase();

      params.set(
        "q",
        contractorKey === "SIN CONTRATISTA"
          ? "XA_contract_activity==''"
          : `XA_contract_activity=='${escapeOracleString(contractor)}'`
      );
    }

    const response = await fetch(
      `${baseUrl}/rest/ofscCore/v1/activities?${params.toString()}`,
      {
        method: "GET",
        headers: {
          "Authorization": authorization,
          "Accept": "application/json"
        }
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");

      throw new Error(
        `Consulta ${tree} (${dateFrom} a ${dateTo}) falló con HTTP ${response.status}: ${body.slice(0, 500)}`
      );
    }

    const data = await response.json();
    const items = Array.isArray(data.items) ? data.items : [];

    for (const item of items) {
      all.push({
        ...item,
        Arbol: tree
      });
    }

    // Si Oracle indica expresamente que hay más, seguimos.
    // Si no lo indica, también seguimos cuando recibimos
    // exactamente una página completa.
    const hasMore = data.hasMore === true;

    if (!hasMore && items.length < DUPLICATE_LIMIT) {
      break;
    }

    if (items.length === 0) {
      break;
    }

    offset += items.length;
  }

  // Doble control local para el contratista.
  // NO elimina duplicados.
  if (contractor) {
    const expected = contractor.trim().toUpperCase();

    if (expected === "SIN CONTRATISTA") {
      return all.filter(item =>
        !String(item.XA_contract_activity || "").trim()
      );
    }

    return all.filter(item =>
      String(item.XA_contract_activity || "")
        .trim()
        .toUpperCase() === expected
    );
  }

  return all;
}


// En Implementaciones se admiten EXCLUSIVAMENTE tareas RCI y CTR.
// El filtro es por sigla de la TAREA, no por SiglaEvento.
// Se aplica al recuperar actividades de Oracle: no se enriquecen,
// deduplican ni devuelven otras tipificaciones de esta rama.
const IMPLEMENTACIONES_TREE = "gomra.implementaciones";
const IMPLEMENTACIONES_ALLOWED_SIGLAS = new Set(["RCI", "CTR"]);
function filterImplementacionesActivities(tree, items) {
  if (String(tree || "").trim().toLowerCase() !== IMPLEMENTACIONES_TREE) {
    return items;
  }
  return items.filter(item => IMPLEMENTACIONES_ALLOWED_SIGLAS.has(
    taskSiglaFromApptNumber(item.apptNumber || item.Tarea)
  ));
}

// Consulta un rango de cualquier longitud para UN árbol.
// Internamente lo parte en ventanas de hasta 31 días.
async function fetchTreeDuplicateRange(
  env,
  tree,
  dateFrom,
  dateTo,
  contractor = ""
) {
  const windows = splitDateRange(
    dateFrom,
    dateTo,
    31
  );

  const all = [];

  /*
    Procesamos primero la ventana más futura.
    Dentro de cada respuesta NO alteramos el orden de Oracle.
    Esto permite que el front conserve la primera aparición
    de cada ticket como su último movimiento.
  */
  const processingWindows =
    [...windows].reverse();

  for (const window of processingWindows) {
    const items = await fetchTreeDuplicateWindow(
      env,
      tree,
      window.dateFrom,
      window.dateTo,
      contractor
    );

    all.push(...items);
  }

  return {
    items: filterImplementacionesActivities(tree, all),
    windows,
    processingWindows
  };
}


function buildByTree(items, trees) {
  const byTree = {};

  for (const tree of trees) {
    byTree[tree] = 0;
  }

  for (const item of items) {
    byTree[item.Arbol] = (byTree[item.Arbol] || 0) + 1;
  }

  return byTree;
}


// /api/allduplicate
// Desde hoy hasta hoy + 30 días.
// Ya entra dentro del máximo de 31 días, pero usamos
// la misma función de rango para dejar una sola lógica.
async function handleAllDuplicate(request, env, url, cors) {
  const dateFrom = ymdInTimeZone(new Date());
  const dateTo = addDaysToYmd(dateFrom, 30);

  const contractor = String(
    url.searchParams.get("contractor") || ""
  ).trim();

  try {
    // Los árboles se consultan secuencialmente para evitar
    // una explosión de requests concurrentes.
    const items = [];
    const windowsByTree = {};

    for (const tree of DEFAULT_TREES) {
      const result = await fetchTreeDuplicateRange(
        env,
        tree,
        dateFrom,
        dateTo,
        contractor
      );

      items.push(...result.items);
      windowsByTree[tree] = result.windows;
    }

    return jsonResponse({
      meta: {
        scope: "allduplicate",
        trees: DEFAULT_TREES,
        dateFrom,
        dateTo,
        contractor: contractor || null,
        generatedAt: new Date().toISOString(),
        timezone: TIMEZONE,

        count: items.length,
        rawCount: items.length,
        duplicatesRemoved: 0,
        duplicatesPreserved: true,

        cabaFilterApplied: false,
        byTree: buildByTree(items, DEFAULT_TREES),
        windowsByTree
      },
      items
    }, 200, cors);

  } catch (error) {
    console.error(error);

    return jsonResponse({
      error: "No se pudo completar la consulta allduplicate.",
      detail: String(error?.message || error)
    }, 502, cors);
  }
}


// /api/allduplicate_range
//
// Acepta:
// ?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// También:
// ?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
//
// Y opcional:
// &contractor=INSERTEL
//
// Puede recibir 3 meses, 6 meses, etc.
// El Worker lo fragmenta automáticamente en ventanas <=31 días.

function resolveRequestedTrees(url) {
  const raw = String(
    url.searchParams.get("tree") || ""
  ).trim();

  if (!raw) {
    return DEFAULT_TREES;
  }

  const requested = raw
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);

  const resolved = [];

  for (const value of requested) {
    const match = DEFAULT_TREES.find(
      tree =>
        tree.toLowerCase() ===
        value.toLowerCase()
    );

    if (!match) {
      throw new Error(
        `Arbol invalido: ${value}. Permitidos: ${DEFAULT_TREES.join(", ")}`
      );
    }

    if (!resolved.includes(match)) {
      resolved.push(match);
    }
  }

  return resolved;
}


async function handleAllDuplicateRange(request, env, url, cors) {
  const dateFrom = String(
    url.searchParams.get("from") ||
    url.searchParams.get("dateFrom") ||
    ""
  ).trim();

  const dateTo = String(
    url.searchParams.get("to") ||
    url.searchParams.get("dateTo") ||
    ""
  ).trim();

  const contractor = String(
    url.searchParams.get("contractor") || ""
  ).trim();

  let trees;

  try {
    trees = resolveRequestedTrees(url);
  } catch (error) {
    return jsonResponse({
      error: String(error?.message || error)
    }, 400, cors);
  }

  if (!validYmd(dateFrom) || !validYmd(dateTo)) {
    return jsonResponse({
      error:
        "Debe indicar from y to en formato YYYY-MM-DD. " +
        "También se aceptan dateFrom y dateTo."
    }, 400, cors);
  }

  if (compareYmd(dateFrom, dateTo) > 0) {
    return jsonResponse({
      error:
        "La fecha desde no puede ser posterior a la fecha hasta."
    }, 400, cors);
  }

  try {
    const items = [];
    const windowsByTree = {};

    // Secuencial por árbol y secuencial por ventana.
    // Esto prioriza estabilidad para períodos largos.
    for (const tree of trees) {
      const result = await fetchTreeDuplicateRange(
        env,
        tree,
        dateFrom,
        dateTo,
        contractor
      );

      items.push(...result.items);
      windowsByTree[tree] = result.windows;
    }

    return jsonResponse({
      meta: {
        scope: "allduplicate_range",
        trees,
        dateFrom,
        dateTo,
        contractor: contractor || null,
        generatedAt: new Date().toISOString(),
        timezone: TIMEZONE,

        count: items.length,
        rawCount: items.length,
        duplicatesRemoved: 0,
        duplicatesPreserved: true,

        cabaFilterApplied: false,
        byTree: buildByTree(items, trees),

        // Sirve para comprobar cómo fue dividido el rango.
        windowsByTree
      },
      items
    }, 200, cors);

  } catch (error) {
    console.error(error);

    return jsonResponse({
      error:
        "No se pudo completar la consulta allduplicate_range.",
      detail:
        String(error?.message || error)
    }, 502, cors);
  }
}



/* =========================================================
   DATASET FINAL PARA FRONT / OTRAS APLICACIONES
   ========================================================= */

function validOperationalTicket(item) {
  const value = String(
    item?.apptNumber || ""
  )
    .trim()
    .toUpperCase();

  return /^(?=.*[A-Z])(?=.*\d)[A-Z0-9]+$/.test(
    value
  );
}


function effectiveFinalTimestamp(item) {
  const scheduled =
    String(
      item?.date || ""
    ).slice(0, 10);

  const endTs =
    parseOfscTimestamp(
      item?.endTime,
      scheduled
    );

  if (
    endTs !== Number.NEGATIVE_INFINITY
  ) {
    return endTs;
  }

  if (
    isCancelledActivity(item)
    &&
    scheduled
  ) {
    return parseOfscTimestamp(
      `${scheduled}T23:59:59`
    );
  }

  const startTs =
    parseOfscTimestamp(
      item?.startTime,
      scheduled
    );

  if (
    startTs !== Number.NEGATIVE_INFINITY
  ) {
    return startTs;
  }

  return scheduled
    ? parseOfscTimestamp(
        `${scheduled}T00:00:00`
      )
    : Number.NEGATIVE_INFINITY;
}


function effectiveFinalDate(item) {
  const raw =
    String(
      item?.endTime || ""
    ).trim();

  const match =
    raw.match(
      /^(\d{4})-(\d{2})-(\d{2})/
    );

  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  return String(
    item?.date || ""
  ).slice(0, 10);
}


function selectFinalRows(items) {
  const groups =
    new Map();

  for (const item of items) {
    if (!validOperationalTicket(item)) {
      continue;
    }

    const id =
      normalizeOrder(
        item.apptNumber
      );

    if (!groups.has(id)) {
      groups.set(id, []);
    }

    groups
      .get(id)
      .push(item);
  }

  const output = [];

  for (
    const rows
    of groups.values()
  ) {
    // Primero priorizar estados definitivos del ticket.
    // Si existen varias intervenciones terminales del mismo tipo,
    // elegir la cronologicamente mas reciente.
    // Si no hay estados terminales, elegir la ultima intervencion.
    let selected = rows[0];
    let bestTs = effectiveFinalTimestamp(selected);
    let selectedTerminal =
      isCompletedActivity(selected)
      || isCancelledActivity(selected)
      || isNotDoneActivity(selected);

    for (let i = 1; i < rows.length; i++) {
      const candidate = rows[i];
      const candidateTs = effectiveFinalTimestamp(candidate);
      const candidateTerminal =
        isCompletedActivity(candidate)
        || isCancelledActivity(candidate)
        || isNotDoneActivity(candidate);

      // Cualquier estado definitivo supera a uno no definitivo,
      // aunque la intervencion no definitiva sea posterior.
      if (candidateTerminal && !selectedTerminal) {
        selected = candidate;
        bestTs = candidateTs;
        selectedTerminal = true;
        continue;
      }

      if (!candidateTerminal && selectedTerminal) {
        continue;
      }

      // Entre intervenciones del mismo nivel de prioridad,
      // decidir por la fecha/hora mas reciente.
      if (candidateTs > bestTs) {
        selected = candidate;
        bestTs = candidateTs;
        selectedTerminal = candidateTerminal;
        continue;
      }

      // Desempate estable usando el ID de actividad.
      if (
        candidateTs === bestTs
        && Number(candidate.activityId || 0) > Number(selected.activityId || 0)
      ) {
        selected = candidate;
        bestTs = candidateTs;
        selectedTerminal = candidateTerminal;
      }
    }

    const suspendedCount =
      rows.filter(
        row =>
          String(
            row.status || ""
          )
            .trim()
            .toLowerCase()
          ===
          "suspended"
      ).length;

    output.push({
      ...selected,

      FechaEfectiva:
        effectiveFinalDate(
          selected
        ),

      TotalAsignaciones:
        rows.length,

      VecesSuspendida:
        suspendedCount,

      ResolvedBy:
        selected.endTime
          ?
          "endTime"
          :
          (
            isCancelledActivity(
              selected
            )
              ?
              "cancelled-date"
              :
              (
                selected.startTime
                  ?
                  "startTime-fallback"
                  :
                  "date-fallback"
              )
          )
    });
  }

  return output;
}


// Para /api/final_range exclusivamente: permite cualquier recurso realmente
// descubierto en Oracle, sin agregarlo a los árboles operativos por defecto.
// Otros endpoints siguen utilizando resolveRequestedTrees y DEFAULT_TREES.
async function resolveFinalRangeTrees(env, url) {
  const raw = String(url.searchParams.get("tree") || "").trim();
  if (!raw) return DEFAULT_TREES;
  const values = [...new Set(raw.split(",").map(x => x.trim()).filter(Boolean))];
  if (!values.length || values.length > 30) throw new Error("Indique entre 1 y 30 recursos por consulta.");
  const {rows} = await discoverOracleResources(env);
  const ids = new Map(rows.map(x => [x.resourceId.toLowerCase(), x.resourceId]));
  return values.map(value => {
    const found = ids.get(value.toLowerCase());
    if (!found) throw new Error(`Recurso no encontrado en directorio Oracle: ${value}`);
    return found;
  });
}

async function handleFinalRange(
  request,
  env,
  url,
  cors
) {
  const dateFrom =
    String(
      url.searchParams.get("from")
      ||
      url.searchParams.get("dateFrom")
      ||
      ""
    ).trim();

  const dateTo =
    String(
      url.searchParams.get("to")
      ||
      url.searchParams.get("dateTo")
      ||
      ""
    ).trim();

  if (
    !validYmd(dateFrom)
    ||
    !validYmd(dateTo)
  ) {
    return jsonResponse({
      ok: false,
      error:
        "Debe indicar from/to en formato YYYY-MM-DD."
    }, 400, cors);
  }

  let trees;

  try {
    trees =
      await resolveFinalRangeTrees(env, url);
  }
  catch(error) {
    return jsonResponse({
      ok: false,
      error:
        String(
          error?.message || error
        )
    }, 400, cors);
  }

  const queryFrom =
    addDaysToYmd(
      dateFrom,
      -1
    );

  const queryTo =
    addDaysToYmd(
      dateTo,
      1
    );

  const raw = [];
  const errors = [];

  for (const tree of trees) {
    try {
      const result =
        await fetchTreeDuplicateRange(
          env,
          tree,
          queryFrom,
          queryTo,
          ""
        );

      raw.push(
        ...result.items
      );
    }
    catch(error) {
      errors.push({
        tree,
        error:
          String(
            error?.message || error
          )
      });
    }
  }

  if (errors.length) {
    return jsonResponse({
      ok: false,
      error:
        "Una o más consultas fallaron. No se devuelve un snapshot parcial.",
      errors
    }, 502, cors);
  }

  const selected =
    selectFinalRows(
      raw
    )
      .filter(
        item =>
          item.FechaEfectiva
          &&
          item.FechaEfectiva >= dateFrom
          &&
          item.FechaEfectiva <= dateTo
      );

  let items;

  try {
    items =
      await enrichActivities(
        env,
        selected
      );
  }
  catch(error) {
    return jsonResponse({
      ok: false,
      error:
        "No se pudieron aplicar reglas D1.",
      detail:
        String(
          error?.message || error
        )
    }, 503, cors);
  }

  return jsonResponse({
    ok: true,

    meta: {
      scope:
        "final_range",

      dateFrom,
      dateTo,
      queryFrom,
      queryTo,
      trees,

      rawCount:
        raw.length,

      count:
        items.length,

      generatedAt:
        new Date().toISOString(),

      rulesSource:
        "D1",

      contractorSource:
        "Oracle + D1",

      errors
    },

    items
  }, 200, cors);
}



/* =========================================================
   WORKER
   ========================================================= */

/* Historial acumulativo. Sin modificaciones a /api/final_range.
   La fuente devuelve observaciones de actividades, no un audit log garantizado
   de transiciones entre estados. Capturamos todas las ocurrencias recuperables. */
function historyAuthorized(request, env) {
  const secret = String(env.HISTORY_SYNC_TOKEN || "");
  const auth = String(request.headers.get("Authorization") || "");
  if (!secret || !auth.startsWith("Bearer ")) return false;
  const token = auth.slice(7);
  if (token.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}
function historyDate(item) {
  for (const value of [item.endTime, item.startTime, item.date]) {
    const m = String(value || "").match(/^\d{4}-\d{2}-\d{2}/);
    if (m && validYmd(m[0])) return m[0];
  }
  return "";
}
function historyKey(item) {
  const ticket = normalizeOrder(item.apptNumber).toUpperCase();
  const activity = String(item.activityId ?? "").trim();
  const day = String(item.date || "").slice(0, 10);
  const state = String(item.status || "").trim().toLowerCase();
  // Estado separado por actividad/agenda, para no pisar cambios observados.
  if (activity) return JSON.stringify([ticket, activity, day, state]);
  return JSON.stringify([ticket, day, state, item.resourceId || "", item.startTime || "", item.endTime || ""]);
}
async function historyIngest(env, raw, context) {
  if (!env.DB) throw new Error("Falta binding DB.");
  const accepted = raw.filter(validOperationalTicket);
  const unique = new Map();
  for (const item of accepted) unique.set(historyKey(item), item);
  const enriched = (await enrichActivities(env, [...unique.values()])).map(item => ({
    ...item, FechaIntervencion: historyDate(item)
  }));
  const sql = `INSERT INTO historico_tickets (
    intervencion_key,appt_number,activity_id,arbol,fecha_agendada,fecha_intervencion,
    start_time,end_time,estado,nodo,contratista,contratista_fuente,tipif,tipificacion,
    capa,subcapa,ticket_evento,origen,tecnico,recurso_id,raw_json,enriquecido_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(intervencion_key) DO UPDATE SET
    activity_id=excluded.activity_id,arbol=excluded.arbol,
    fecha_agendada=excluded.fecha_agendada,fecha_intervencion=excluded.fecha_intervencion,
    start_time=excluded.start_time,end_time=excluded.end_time,estado=excluded.estado,
    nodo=excluded.nodo,contratista=excluded.contratista,contratista_fuente=excluded.contratista_fuente,
    tipif=excluded.tipif,tipificacion=excluded.tipificacion,capa=excluded.capa,subcapa=excluded.subcapa,
    ticket_evento=excluded.ticket_evento,origen=excluded.origen,tecnico=excluded.tecnico,
    recurso_id=excluded.recurso_id,raw_json=excluded.raw_json,
    enriquecido_json=excluded.enriquecido_json,ultima_captura=CURRENT_TIMESTAMP`;
  const originals = [...unique.values()];
  // D1 limita parámetros por sentencia; cada INSERT tiene 22 y ejecutamos lotes pequeños.
  const BATCH = 25;
  for (let offset = 0; offset < enriched.length; offset += BATCH) {
    const queries = enriched.slice(offset, offset + BATCH).map((item, i) => {
      const original = originals[offset + i];
      return env.DB.prepare(sql).bind(
        historyKey(original), normalizeOrder(item.apptNumber).toUpperCase(), String(item.activityId ?? ""),
        String(item.Arbol || context.tree), String(item.date || "").slice(0,10),historyDate(item),
        String(item.startTime || ""),String(item.endTime || ""),String(item.status || "").toLowerCase(),
        String(item.Nodo || ""),String(item.Contratista || "SIN CONTRATISTA"),
        String(item.ContratistaFuente || ""),String(item.Tipif || ""),String(item.TipificacionTarea || ""),
        String(item.Capa || ""),String(item.SubCapa || ""),String(item.TicketEvento || ""),
        String(item.Origen || ""),String(item.Tecnico || ""),String(item.IDRecurso || ""),
        JSON.stringify(original),JSON.stringify(item)
      );
    });
    if (queries.length) await env.DB.batch(queries);
  }
  return {raw:raw.length, accepted:accepted.length, distinctInterventions:unique.size, stored:enriched.length};
}
async function historyWriteControl(env, tree, day, state, count, detail) {
  await env.DB.prepare(`INSERT INTO sync_control
    (proceso,arbol,fecha_desde,fecha_hasta,estado,registros,detalle) VALUES (?,?,?,?,?,?,?)`)
    .bind("historico",tree,day,day,state,count,String(detail).slice(0,2000)).run();
}
async function handleHistorySync(request,env,url,cors) {
  // Pausa explícita de la ingestión HTTP: exige habilitación separada del cursor Cron.
  if (String(env.HISTORY_HTTP_SYNC_ENABLED || "false").toLowerCase() !== "true") {
    return jsonResponse({ok:false,error:"Ingesta histórica HTTP en pausa (HISTORY_HTTP_SYNC_ENABLED=false)"},423,cors);
  }
  if(!historyAuthorized(request,env)) return jsonResponse({ok:false,error:"No autorizado"},401,cors);
  const date=String(url.searchParams.get("date")||"").trim();
  const tree=String(url.searchParams.get("tree")||"").trim();
  if (!validYmd(date)) return jsonResponse({ok:false,error:"date requiere YYYY-MM-DD"},400,cors);
  const selected=DEFAULT_TREES.find(t=>t.toLowerCase()===tree.toLowerCase());
  if (!selected) return jsonResponse({ok:false,error:"Árbol no reconocido"},400,cors);
  if (date > ymdInTimeZone(new Date())) return jsonResponse({ok:false,error:"El histórico no importa fechas futuras"},400,cors);
  try {
    const result=await fetchTreeDuplicateRange(env,selected,date,date,"");
    const info=await historyIngest(env,result.items,{tree:selected,date});
    await historyWriteControl(env,selected,date,"OK",info.stored,JSON.stringify(info));
    return jsonResponse({ok:true,date,tree:selected,...info},200,cors);
  } catch(error) {
    const message=String(error?.message || error);
    try { await historyWriteControl(env,selected,date,"ERROR",0,message); } catch (_) {}
    return jsonResponse({ok:false,error:"Falló la sincronización histórica",detail:message},502,cors);
  }
}
/* =========================================================
   V19 - Complemento Tableau directamente sobre historico_tickets.
   No mantiene una segunda tabla de datos en D1.
   Autenticación: HISTORY_SYNC_TOKEN (secret existente).
   Dry run por defecto; mode=apply para escribir expresamente.
   ========================================================= */
function tableauHistoryItem(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Registro inválido');
  const apptNumber = String(input.apptNumber || input.Tarea || '').trim().toUpperCase();
  const creadoExacto = String(input.creadoExacto || input.CreadoExacto || '').trim();
  const afectacion = String(input.afectacion || input.Afectacion || '').trim().toUpperCase();
  const rawEvent = String(input.eventoTableau || input.EventoTableau || '').trim().toUpperCase();
  if (!/^\d{6}[A-Z]{3}\d{5}$/.test(apptNumber)) throw new Error('Tarea inválida: ' + apptNumber);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(creadoExacto) ||
      !validYmd(creadoExacto.slice(0,10)) || Number(creadoExacto.slice(11,13)) > 23 ||
      Number(creadoExacto.slice(14,16)) > 59 || Number(creadoExacto.slice(17,19)) > 59)
    throw new Error('CreadoExacto inválido: ' + apptNumber);
  if (!['SI','NO'].includes(afectacion)) throw new Error('Afectacion inválida: ' + apptNumber);
  if (rawEvent && !/^\d{6}[A-Z]{2}\d{4,5}$/.test(rawEvent))
    throw new Error('EventoTableau inválido: ' + apptNumber);
  return {apptNumber,creadoExacto,afectacion,eventoTableau:rawEvent || null};
}
function tableauHistoryChangedCondition() {
  // IS NOT en SQLite compara también NULL sin forzar escrituras repetidas.
  return `(creado_exacto IS NOT ? OR afectacion IS NOT ?
      OR (? IS NOT NULL AND evento_tableau IS NOT ?))`;
}
function tableauHistoryBindings(item) {
  return [item.creadoExacto,item.afectacion,item.eventoTableau,item.eventoTableau];
}
async function handleHistoryTableauComplement(request,env,cors) {
  if (!historyAuthorized(request,env)) return jsonResponse({ok:false,error:'No autorizado'},401,cors);
  if (!env.DB) return jsonResponse({ok:false,error:'Falta binding DB'},503,cors);
  try {
    const body = await request.json();
    if (!body || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 25)
      return jsonResponse({ok:false,error:'items requiere de 1 a 25 tareas por lote'},400,cors);
    if (!['dry_run','apply'].includes(body.mode || 'dry_run'))
      return jsonResponse({ok:false,error:'mode permite dry_run o apply'},400,cors);
    const mode = body.mode || 'dry_run';
    const items = body.items.map(tableauHistoryItem);
    const unique = new Set(items.map(x => x.apptNumber));
    if (unique.size !== items.length) return jsonResponse({ok:false,error:'Lote con tareas duplicadas'},400,cors);
    const details=[];
    let totalMatched=0, totalChanged=0;
    for (const item of items) {
      const cond=tableauHistoryChangedCondition();
      const args=tableauHistoryBindings(item);
      if (mode === 'dry_run') {
        const found=await env.DB.prepare(`SELECT COUNT(*) AS n FROM historico_tickets WHERE appt_number=?`)
          .bind(item.apptNumber).first();
        const changed=await env.DB.prepare(`SELECT COUNT(*) AS n FROM historico_tickets
          WHERE appt_number=? AND ${cond}`).bind(item.apptNumber,...args).first();
        const match=Number(found?.n || 0), wouldChange=Number(changed?.n || 0);
        totalMatched+=match;totalChanged+=wouldChange;
        details.push({Tarea:item.apptNumber,intervenciones:match,cambios:wouldChange});
      } else {
        // El UPDATE toca solo filas que cambian, conserva raw_json y enriquecido_json,
        // así como las demás columnas y todos los estados de intervención.
        const res=await env.DB.prepare(`UPDATE historico_tickets
          SET creado_exacto=?, afectacion=?, evento_tableau=COALESCE(?,evento_tableau)
          WHERE appt_number=? AND ${cond}`)
          .bind(item.creadoExacto,item.afectacion,item.eventoTableau,
            item.apptNumber,...args).run();
        const changed=Number(res.meta?.changes || 0);
        totalChanged+=changed;
        details.push({Tarea:item.apptNumber,intervencionesActualizadas:changed});
      }
    }
    return jsonResponse({ok:true,mode,tareas:items.length,
      intervencionesCoincidentes:mode==='dry_run'?totalMatched:undefined,
      intervencionesParaActualizar:mode==='dry_run'?totalChanged:undefined,
      intervencionesActualizadas:mode==='apply'?totalChanged:undefined,details},200,cors);
  } catch(error) {
    return jsonResponse({ok:false,error:String(error?.message || error)},400,cors);
  }
}
function overlayTableauHistory(item,row) {
  return {...item,CreadoExacto:row.creado_exacto || '',
    Afectacion:row.afectacion || '',EventoTableau:row.evento_tableau || '',
    ComplementoPendiente:!row.creado_exacto};
}
function historyRange(url) {
  const from=String(url.searchParams.get("from")||"").trim();
  const to=String(url.searchParams.get("to")||"").trim();
  if (!validYmd(from)||!validYmd(to)||from>to) throw new Error("from/to: usar YYYY-MM-DD y from <= to");
  const page=Number(url.searchParams.get("page")||1), limit=Number(url.searchParams.get("limit")||100);
  if (!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(limit)||limit<1||limit>500) throw new Error("page >=1, limit 1..500");
  const status=String(url.searchParams.get("status")||"").trim().toLowerCase();
  const contractor=String(url.searchParams.get("contractor")||"").trim().toUpperCase();
  const apptNumber=String(url.searchParams.get("apptNumber")||"").trim().toUpperCase();
  if(apptNumber && !/^\d{6}[A-Z]{3}\d{5}$/.test(apptNumber)) throw new Error("apptNumber inválido");
  const conditions=["fecha_intervencion BETWEEN ? AND ?"];
  const args=[from,to];
  if(status){conditions.push("estado = ?");args.push(status);}
  if(contractor){conditions.push("upper(contratista) = ?");args.push(contractor);}
  if(apptNumber){conditions.push("upper(appt_number) = ?");args.push(apptNumber);}
  return {from,to,page,limit,offset:(page-1)*limit,where:conditions.join(" AND "),args,status,contractor,apptNumber};
}
async function handleHistoryRows(env,url,cors) {
  try {
    const q=historyRange(url);
    const total=await env.DB.prepare(`SELECT COUNT(*) n FROM historico_tickets WHERE ${q.where}`).bind(...q.args).first();
    const rows=await env.DB.prepare(`SELECT intervencion_key,fecha_captura,ultima_captura,enriquecido_json,creado_exacto,afectacion,evento_tableau
      FROM historico_tickets WHERE ${q.where}
      ORDER BY fecha_intervencion DESC,coalesce(end_time,start_time,'') DESC,intervencion_key
      LIMIT ? OFFSET ?`).bind(...q.args,q.limit,q.offset).all();
    return jsonResponse({ok:true,source:"d1",kind:"intervenciones",from:q.from,to:q.to,
      page:q.page,limit:q.limit,total:total?.n||0,totalPages:Math.ceil((total?.n||0)/q.limit),
      items:(rows.results||[]).map(r=>overlayTableauHistory({...JSON.parse(r.enriquecido_json),IntervencionKey:r.intervencion_key,
        FechaCaptura:r.fecha_captura,UltimaCaptura:r.ultima_captura},r))},200,cors);
  } catch(e) {return jsonResponse({ok:false,error:String(e?.message||e)},400,cors);}
}
async function handleHistoryLastStatus(env,url,cors) {
  try {
    const q=historyRange(url);
    // Se elige la última ocurrencia CONOCIDA hasta la fecha to; después se
    // filtra su fecha efectiva en el período. No mantiene tabla derivada.
    const cond=["fecha_intervencion <= ?"],args=[q.to];
    if(q.contractor){cond.push("upper(contratista)=?");args.push(q.contractor);}
    const ranked=`WITH ranked AS (SELECT intervencion_key,fecha_intervencion,estado,enriquecido_json,creado_exacto,afectacion,evento_tableau,
      COUNT(*) OVER (PARTITION BY appt_number) AS total_asignaciones,
      SUM(CASE WHEN estado='suspended' THEN 1 ELSE 0 END) OVER (PARTITION BY appt_number) AS veces_suspendida,
      ROW_NUMBER() OVER (PARTITION BY appt_number ORDER BY
        fecha_intervencion DESC,coalesce(end_time,start_time,'') DESC,
        CASE WHEN estado IN ('completed','cancelled','notdone','not_done','not-done') THEN 1 ELSE 0 END DESC,
        ultima_captura DESC,intervencion_key DESC) AS rn
      FROM historico_tickets WHERE ${cond.join(" AND ")})
      SELECT * FROM ranked WHERE rn=1 AND fecha_intervencion BETWEEN ? AND ?`;
    const bind=[...args,q.from,q.to];
    const statusFilter=q.status?" AND estado=?":"";
    const statusArgs=q.status?[q.status]:[];
    const total=await env.DB.prepare(`SELECT COUNT(*) n FROM (${ranked}) WHERE 1=1${statusFilter}`).bind(...bind,...statusArgs).first();
    const rows=await env.DB.prepare(`SELECT enriquecido_json,creado_exacto,afectacion,evento_tableau,total_asignaciones,veces_suspendida FROM (${ranked}) WHERE 1=1${statusFilter}
      ORDER BY fecha_intervencion DESC LIMIT ? OFFSET ?`).bind(...bind,...statusArgs,q.limit,q.offset).all();
    return jsonResponse({ok:true,source:"d1",kind:"ultimo_estado_conocido",from:q.from,to:q.to,
      page:q.page,limit:q.limit,total:total?.n||0,totalPages:Math.ceil((total?.n||0)/q.limit),
      items:(rows.results||[]).map(r=>overlayTableauHistory({ ...JSON.parse(r.enriquecido_json),
        FechaEfectiva:JSON.parse(r.enriquecido_json).FechaIntervencion,
        TotalAsignaciones:r.total_asignaciones,VecesSuspendida:r.veces_suspendida },r))},200,cors);
  }catch(e){return jsonResponse({ok:false,error:String(e?.message||e)},400,cors);}
}
async function handleHistorySummary(env,url,cors) {
  try {
    const q=historyRange(url);
    const [occ, tickets, ever] = await Promise.all([
      env.DB.prepare(`SELECT estado,COUNT(*) AS intervenciones,COUNT(DISTINCT appt_number) AS tickets_distintos
        FROM historico_tickets WHERE ${q.where} GROUP BY estado ORDER BY intervenciones DESC`).bind(...q.args).all(),
      env.DB.prepare(`SELECT COUNT(DISTINCT appt_number) n FROM historico_tickets WHERE ${q.where}`).bind(...q.args).first(),
      env.DB.prepare(`SELECT COUNT(*) n FROM historico_tickets WHERE ${q.where}`).bind(...q.args).first()
    ]);
    return jsonResponse({ok:true,source:"d1",from:q.from,to:q.to,
      intervenciones:ever?.n||0,ticketsDistintos:tickets?.n||0,
      intervencionesPorEstado:occ.results||[]},200,cors);
  }catch(e){return jsonResponse({ok:false,error:String(e?.message||e)},400,cors);}
}

/* =========================================================
   V17 - Programador HISTORICO dentro del Worker.
   El operativo y todos los endpoints v16 se mantienen intactos.
   Requiere historico_cursor id=1 con lock_until y last_error.
   Dejar estado='PAUSADO' hasta verificar esta implementación.
   ========================================================= */
const HISTORY_SCHEDULER = {
  TREES: DEFAULT_TREES,
  DAYS_BACKFILL: 90,
  DAYS_RECENT: 10,
  LOCK_MS: 20 * 60 * 1000
};

/** Un solo bloque (árbol/día). Reutiliza exactamente el importador de v16. */
async function historySyncBlock(env, tree, date) {
  if (!validYmd(date) || !HISTORY_SCHEDULER.TREES.includes(tree)) {
    throw new Error("Bloque histórico inválido.");
  }
  if (date > ymdInTimeZone(new Date())) {
    throw new Error("No se permite importar una fecha futura.");
  }
  try {
    const result = await fetchTreeDuplicateRange(env, tree, date, date, "");
    const info = await historyIngest(env, result.items, {tree, date});
    await historyWriteControl(env, tree, date, "OK", info.stored, JSON.stringify(info));
    return {date, tree, ...info};
  } catch (error) {
    const message = String(error?.message || error);
    try { await historyWriteControl(env, tree, date, "ERROR", 0, message); }
    catch (logError) { console.error("No se pudo registrar error en sync_control", logError); }
    throw new Error(`Histórico ${date}/${tree}: ${message}`);
  }
}

/** Obtiene el bloqueo por UPDATE condicional. Si está PAUSADO, no importa nada. */
async function historyClaimCursor(env) {
  if (!env.DB) throw new Error("Falta binding DB.");
  const now = new Date();
  const expires = new Date(now.getTime() + HISTORY_SCHEDULER.LOCK_MS).toISOString();
  const claim = await env.DB.prepare(`UPDATE historico_cursor
    SET lock_until=?, actualizado_en=CURRENT_TIMESTAMP
    WHERE id=1 AND estado='ACTIVO'
      AND (lock_until IS NULL OR lock_until < ?)`)
    .bind(expires, now.toISOString()).run();
  if (Number(claim.meta?.changes || 0) !== 1) {
    const row = await env.DB.prepare(`SELECT estado,lock_until FROM historico_cursor WHERE id=1`).first();
    if (!row) throw new Error("historico_cursor no tiene id=1. No se reinicializa automáticamente.");
    return {skipped:true, reason:row.estado === 'PAUSADO' ? 'PAUSADO' :
      row.estado !== 'ACTIVO' ? `ESTADO_${row.estado}` : 'BLOQUEADO'};
  }
  const cursor = await env.DB.prepare(`SELECT * FROM historico_cursor WHERE id=1 AND lock_until=?`)
    .bind(expires).first();
  if (!cursor) throw new Error("No se pudo leer el cursor recién bloqueado.");
  return {cursor, expires};
}

async function historyAdvanceCursor(env, field, previous, next, expires) {
  if (!['recent_index','backfill_index'].includes(field)) throw new Error('Campo de cursor inválido');
  const result = await env.DB.prepare(`UPDATE historico_cursor
    SET ${field}=?, last_error=NULL, actualizado_en=CURRENT_TIMESTAMP
    WHERE id=1 AND lock_until=? AND ${field}=?`)
    .bind(next,expires,previous).run();
  if (Number(result.meta?.changes || 0) !== 1) throw new Error(`No se pudo avanzar ${field}; comprobar estado de D1.`);
}

/** Ejecuta 1 bloque reciente + 1 bloque del backfill, como el Apps Script anterior. */
async function runHistoryScheduledStep(env) {
  const claimed = await historyClaimCursor(env);
  if (claimed.skipped) return {ok:true, ...claimed};
  const {cursor,expires} = claimed;
  const today = ymdInTimeZone(new Date());
  const trees = HISTORY_SCHEDULER.TREES;
  const recentTotal = (HISTORY_SCHEDULER.DAYS_RECENT + 1) * trees.length; // 77
  const backfillTotal = (HISTORY_SCHEDULER.DAYS_BACKFILL - HISTORY_SCHEDULER.DAYS_RECENT) * trees.length; // 560
  const result = {ok:true,skipped:false,recent:null,backfill:null};
  try {
    const recentIndex = Number(cursor.recent_index);
    const backfillIndex = Number(cursor.backfill_index);
    if (!Number.isSafeInteger(recentIndex) || recentIndex < 0 || recentIndex >= recentTotal ||
        !Number.isSafeInteger(backfillIndex) || backfillIndex < 0 || backfillIndex > backfillTotal ||
        !validYmd(cursor.backfill_started)) {
      throw new Error('Cursor histórico inconsistente. No se modifica automáticamente.');
    }

    const recentOffset = Math.floor(recentIndex / trees.length);
    const recentTree = trees[recentIndex % trees.length];
    const recentDate = addDaysToYmd(today, -recentOffset);
    result.recent = await historySyncBlock(env,recentTree,recentDate);
    await historyAdvanceCursor(env,'recent_index',recentIndex,(recentIndex+1)%recentTotal,expires);

    if (backfillIndex < backfillTotal) {
      const offset = HISTORY_SCHEDULER.DAYS_RECENT + 1 + Math.floor(backfillIndex / trees.length);
      const date = addDaysToYmd(cursor.backfill_started,-offset);
      const tree = trees[backfillIndex % trees.length];
      result.backfill = await historySyncBlock(env,tree,date);
      await historyAdvanceCursor(env,'backfill_index',backfillIndex,backfillIndex+1,expires);
    } else {
      result.backfill = {finished:true};
    }
    return result;
  } catch (error) {
    const msg = String(error?.message || error).slice(0,1800);
    await env.DB.prepare(`UPDATE historico_cursor SET last_error=?,actualizado_en=CURRENT_TIMESTAMP
      WHERE id=1 AND lock_until=?`).bind(msg,expires).run().catch(console.error);
    throw error;
  } finally {
    // Nunca liberamos un bloqueo que ya pertenezca a otra ejecución.
    await env.DB.prepare(`UPDATE historico_cursor SET lock_until=NULL,actualizado_en=CURRENT_TIMESTAMP
      WHERE id=1 AND lock_until=?`).bind(expires).run().catch(console.error);
  }
}



/* =========================================================
   DIAGNOSTICO DE RECURSOS / ARBOLES OFSC
   Sólo lectura. Temporalmente sin autenticación.
   No altera DEFAULT_TREES ni las sincronizaciones.
   ========================================================= */
const RESOURCE_DIAG_FIELDS = "resourceId,name,parentResourceId,resourceType,status";

async function oracleDiagnosticResourceGet(env, suffix, params = null) {
  const base = String(env.OFSC_BASE_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("Falta OFSC_BASE_URL.");
  const qs = params ? `?${params.toString()}` : "";
  const response = await fetch(`${base}/rest/ofscCore/v1/resources${suffix}${qs}`, {
    method: "GET",
    headers: { Authorization: basicAuth(env), Accept: "application/json" }
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Oracle recursos HTTP ${response.status}: ${body.slice(0, 400)}`);
  }
  return response.json();
}

function resourceSummary(row) {
  return {
    resourceId: String(row?.resourceId ?? ""),
    name: String(row?.name ?? ""),
    parentResourceId: String(row?.parentResourceId ?? ""),
    resourceType: String(row?.resourceType ?? ""),
    status: String(row?.status ?? "")
  };
}

async function loadVisibleResourceDirectory(env) {
  const pageSize = 100; // máximo documentado por Oracle
  const maxPages = 1000; // límite defensivo, nunca devolver resultados incompletos silenciosamente
  const resources = new Map();
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      fields: RESOURCE_DIAG_FIELDS,
      limit: String(pageSize),
      offset: String(offset)
    });
    const data = await oracleDiagnosticResourceGet(env, "", params);
    const batch = Array.isArray(data.items) ? data.items : [];
    for (const raw of batch) {
      const item = resourceSummary(raw);
      if (item.resourceId) resources.set(item.resourceId, item);
    }
    offset += batch.length;
    const total = Number(data.totalResults);
    if ((Number.isFinite(total) && offset >= total) || batch.length < pageSize) {
      return [...resources.values()];
    }
    if (!batch.length) return [...resources.values()];
  }
  throw new Error("Directorio de recursos demasiado grande: se alcanzó el límite de paginación.");
}

function resourceAncestry(id, index) {
  const chain = [];
  const seen = new Set();
  let next = id;
  while (next && !seen.has(next)) {
    seen.add(next);
    const found = index.get(next);
    if (!found) return { chain, missingParentId: next, cycle: false };
    chain.push(found); // recurso -> padre -> raíz
    next = found.parentResourceId;
  }
  return { chain, missingParentId: "", cycle: Boolean(next) };
}

// Descubrimiento independiente: nunca utiliza DEFAULT_TREES para elegir recursos.
async function discoverOracleResources(env) {
  const rows = await loadVisibleResourceDirectory(env);
  const index = new Map(rows.map(row => [row.resourceId, row]));
  const roots = new Map();
  const missingParents = new Set();
  for (const row of rows) {
    const path = resourceAncestry(row.resourceId, index);
    if (path.missingParentId) missingParents.add(path.missingParentId);
    const root = path.chain[path.chain.length - 1];
    if (!root) continue;
    let group = roots.get(root.resourceId);
    if (!group) {
      group = {...root, visibleResources:0, incompleteHierarchy:false};
      roots.set(root.resourceId, group);
    }
    group.visibleResources++;
    if (path.missingParentId || path.cycle) group.incompleteHierarchy = true;
  }
  // Cada grupo cubre todos sus descendientes visibles; las otras raíces son
  // recursos aislados o jerarquías que la API no permite recorrer.
  const groups = [...roots.values()].sort((a,b) =>
    b.visibleResources - a.visibleResources || a.resourceId.localeCompare(b.resourceId));
  return {rows, groups, missingParents:[...missingParents]};
}

async function handleResourceTrees(request, env, cors) {
  try {
    const result = await discoverOracleResources(env);
    const types = {};
    for (const row of result.rows) types[row.resourceType || '(sin tipo)'] =
      (types[row.resourceType || '(sin tipo)'] || 0) + 1;
    return jsonResponse({
      ok:true, source:'oracle_resources',
      resourceDiscoveryFilter:'NINGUNO',
      visibleResources:result.rows.length,
      resourceTypes:types,
      candidateGroupCount:result.groups.length,
      missingParentIds:result.missingParents,
      configuredTreesForReferenceOnly:DEFAULT_TREES,
      groups:result.groups,
      note:'Los grupos son raíces de la jerarquía visible, NO necesariamente todos los árboles reales. La consulta no usa DEFAULT_TREES para descubrir recursos. Para los 1303 recursos usar /api/recursos/todos.'
    },200,cors);
  } catch (error) {
    return jsonResponse({ok:false,error:'No se pudieron descubrir los recursos.',
      detail:String(error?.message||error)},502,cors);
  }
}

// Listado completo, paginado para evitar respuestas JSON enormes.
async function handleAllResources(request, env, url, cors) {
  try {
    const page = Number(url.searchParams.get('page') || 1);
    const limit = Number(url.searchParams.get('limit') || 200);
    if (!Number.isSafeInteger(page) || page<1 || !Number.isSafeInteger(limit) || limit<1 || limit>500)
      return jsonResponse({ok:false,error:'page >= 1 y limit entre 1 y 500'},400,cors);
    const {rows, groups, missingParents} = await discoverOracleResources(env);
    const sorted = rows.sort((a,b) => a.resourceId.localeCompare(b.resourceId));
    return jsonResponse({ok:true,source:'oracle_resources',filter:'NINGUNO',
      total:sorted.length,page,limit,totalPages:Math.ceil(sorted.length/limit),
      groupCount:groups.length,missingParentIds:missingParents,
      items:sorted.slice((page-1)*limit,page*limit)},200,cors);
  } catch(error) {
    return jsonResponse({ok:false,error:'No se pudieron listar recursos.',detail:String(error?.message||error)},502,cors);
  }
}

// Oracle exige resources para buscar actividades. Se descubren los grupos
// dinámicamente y se consulta CADA raíz visible con includeChildren=all.
// No participa la constante DEFAULT_TREES.
async function handleDiscoveredActivities(request, env, url, cors) {
  const today = ymdInTimeZone(new Date());
  const from = String(url.searchParams.get('from') || addDaysToYmd(today,-1)).trim();
  const to = String(url.searchParams.get('to') || today).trim();
  const ticket = String(url.searchParams.get('ticket') || '').trim().toUpperCase();
  const detail = url.searchParams.get('detail') === '1';
  if (!validYmd(from) || !validYmd(to) || compareYmd(from,to)>0)
    return jsonResponse({ok:false,error:'from/to inválidos. Usar YYYY-MM-DD.'},400,cors);
  if (compareYmd(to,addDaysToYmd(from,30))>0)
    return jsonResponse({ok:false,error:'Máximo 31 días por diagnóstico. Dividir en rangos menores.'},400,cors);
  try {
    const {rows,groups,missingParents} = await discoverOracleResources(env);
    const all = [];
    const groupResults = [];
    const errors = [];
    for (const group of groups) {
      try {
        const result = await fetchTreeDuplicateRange(env,group.resourceId,from,to,'');
        all.push(...result.items);
        groupResults.push({resourceId:group.resourceId,name:group.name,
          visibleResources:group.visibleResources,activities:result.items.length,ok:true});
      } catch(error) {
        const msg = String(error?.message || error);
        errors.push({resourceId:group.resourceId,error:msg});
        groupResults.push({resourceId:group.resourceId,name:group.name,ok:false,error:msg});
      }
    }
    const distinctActivities = new Map();
    for (const item of all) {
      const key = String(item.activityId ?? '') ||
        [item.apptNumber,item.date,item.resourceId,item.status].join('|');
      if (!distinctActivities.has(key)) distinctActivities.set(key,item);
    }
    const unique = [...distinctActivities.values()];
    const matches = ticket ? unique.filter(item =>
      String(item.apptNumber||'').trim().toUpperCase()===ticket) : [];
    const byStatus = {};
    for (const item of unique) {
      const key = String(item.status || '(sin estado)');
      byStatus[key] = (byStatus[key] || 0) + 1;
    }
    return jsonResponse({
      ok:errors.length===0,source:'oracle_activities_discovered_resources',
      from,to,ticket:ticket||null,resourcesParameter:'AUTO: raíz de cada grupo descubierto',
      configuredTreesUsed:false,discoveredResources:rows.length,
      queriedGroups:groups.length,missingParentIds:missingParents,
      rawCount:all.length,distinctActivityCount:unique.length,
      ticketMatches:matches.length,byStatus,groupResults,errors,
      // Por defecto no devolvemos miles de datos personales; sólo las coincidencias.
      items:ticket ? matches : (detail ? unique.slice(0,500) : []),
      itemsTruncated: !ticket && detail && unique.length>500,
      note:'No existe consulta sin resources en esta instancia Oracle. Se consultó cada grupo visible automáticamente. Si algún grupo falla, ok=false y los resultados son parciales.'
    },errors.length ? 502 : 200,cors);
  } catch(error) {
    return jsonResponse({ok:false,error:'Falló diagnóstico de recursos descubiertos.',
      detail:String(error?.message||error)},502,cors);
  }
}

// Contrasta las actividades de todos los grupos descubiertos contra las
// consultadas mediante los siete árboles operativos. No modifica datos.
// El resultado resume tickets faltantes, con paginación de ejemplos y búsqueda
// puntual por ticket. NO utiliza DEFAULT_TREES para elegir el universo.
async function handleCoverageComparison(request, env, url, cors) {
  const today = ymdInTimeZone(new Date());
  const from = String(url.searchParams.get('from') || addDaysToYmd(today,-1)).trim();
  const to = String(url.searchParams.get('to') || today).trim();
  const ticket = String(url.searchParams.get('ticket') || '').trim().toUpperCase();
  const page = Number(url.searchParams.get('page') || 1);
  const limit = Number(url.searchParams.get('limit') || 50);
  if (!validYmd(from) || !validYmd(to) || compareYmd(from,to)>0 ||
      compareYmd(to,addDaysToYmd(from,30))>0)
    return jsonResponse({ok:false,error:'from/to: intervalo válido de máximo 31 días.'},400,cors);
  if (!Number.isSafeInteger(page) || page<1 || !Number.isSafeInteger(limit) || limit<1 || limit>200)
    return jsonResponse({ok:false,error:'page >= 1 y limit 1..200'},400,cors);
  try {
    const {rows, groups, missingParents} = await discoverOracleResources(env);
    const discovered = new Map();
    const configured = new Map();
    const groupResults = [];
    const treeResults = [];
    const errors = [];
    // Un grupo padre cubre sus descendientes con includeChildren=all.
    for (const group of groups) {
      try {
        const result = await fetchTreeDuplicateRange(env,group.resourceId,from,to,'');
        for (const item of result.items) {
          const key = normalizeOrder(item.apptNumber).toUpperCase();
          if (!validOperationalTicket(item)) continue;
          const entry = discovered.get(key);
          if (!entry) discovered.set(key,{items:[item],groups:new Set([group.resourceId])});
          else {
            entry.groups.add(group.resourceId);
            entry.items.push(item);
          }
        }
        groupResults.push({resourceId:group.resourceId,name:group.name,count:result.items.length,ok:true});
      } catch(e) {
        const message=String(e?.message||e);
        groupResults.push({resourceId:group.resourceId,ok:false,error:message});
        errors.push({source:'discovered',resource:group.resourceId,error:message});
      }
    }
    for (const tree of DEFAULT_TREES) {
      try {
        const result=await fetchTreeDuplicateRange(env,tree,from,to,'');
        for (const item of result.items) {
          if (!validOperationalTicket(item)) continue;
          const key=normalizeOrder(item.apptNumber).toUpperCase();
          if (!configured.has(key)) configured.set(key,{items:[],trees:new Set()});
          const entry=configured.get(key);
          entry.items.push(item);
          entry.trees.add(tree);
        }
        treeResults.push({tree,count:result.items.length,ok:true});
      } catch(e) {
        const message=String(e?.message||e);
        treeResults.push({tree,ok:false,error:message});
        errors.push({source:'configured',resource:tree,error:message});
      }
    }
    // Si la comparación está incompleta, nunca presentar faltantes como definitivos.
    const missing=[...discovered.keys()].filter(key=>!configured.has(key)).sort();
    const preview=missing.slice((page-1)*limit,page*limit).map(key=>{
      const entry=discovered.get(key);
      const chosen=selectFinalRows(entry.items)[0] || entry.items[0];
      return {ticket:key,groups:[...entry.groups],activityId:chosen.activityId,
        resourceId:chosen.resourceId,status:chosen.status,date:chosen.date,
        taskSigla:taskSiglaFromApptNumber(key)};
    });
    const inDiscovered=ticket ? discovered.get(ticket) : null;
    const inConfigured=ticket ? configured.get(ticket) : null;
    const selected=inDiscovered ? selectFinalRows(inDiscovered.items)[0] : null;
    const byMissingGroup={};
    const byTaskSigla={};
    for (const key of missing) {
      for (const group of discovered.get(key).groups)
        byMissingGroup[group]=(byMissingGroup[group]||0)+1;
      const sigla=taskSiglaFromApptNumber(key)||'(sin sigla)';
      byTaskSigla[sigla]=(byTaskSigla[sigla]||0)+1;
    }
    return jsonResponse({ok:errors.length===0,source:'oracle_coverage_comparison',
      from,to,discoveryUsesConfiguredTrees:false,configuredTrees:DEFAULT_TREES,
      visibleResources:rows.length,discoveredGroups:groups.length,missingParentIds:missingParents,
      distinctTicketsDiscovered:discovered.size,distinctTicketsConfigured:configured.size,
      missingTicketsCount:missing.length,missingTicketsComplete:errors.length===0,
      byMissingGroup,byTaskSigla,groupResults,treeResults,errors,
      ticket:ticket ? {number:ticket,foundInDiscovered:!!inDiscovered,
        discoveredGroups:inDiscovered?[...inDiscovered.groups]:[],
        foundInConfigured:!!inConfigured,
        configuredTrees:inConfigured?[...inConfigured.trees]:[],
        selectedActivity:selected?{
          activityId:selected.activityId,resourceId:selected.resourceId,
          status:selected.status,date:selected.date,apptNumber:selected.apptNumber
        }:null} : null,
      missingTicketsPage:page,missingTicketsLimit:limit,
      missingTicketsTotalPages:Math.ceil(missing.length/limit),missingTickets:preview,
      note:'Compara tickets por fecha AGENDADA recuperados de Oracle. No usa filtros de DATA ni FechaEfectiva. Si hay errores, el diagnóstico es parcial.'
    },errors.length ? 502 : 200,cors);
  } catch(e) {
    return jsonResponse({ok:false,error:'Falló comparación de cobertura.',detail:String(e?.message||e)},502,cors);
  }
}

async function handleResourceLocation(request, env, url, cors) {
  const id = String(url.searchParams.get("resourceId") || "").trim();
  if (!id || id.length > 128) return jsonResponse({ok:false,error:"Indicar resourceId (máximo 128 caracteres)."},400,cors);
  try {
    // Consulta directa; puede encontrar recursos que no aparezcan en el listado global.
    const chain = [];
    const seen = new Set();
    let current = id;
    for (let depth=0; current && depth<100; depth++) {
      if (seen.has(current)) return jsonResponse({ok:false,error:"Ciclo en jerarquía de recursos.",chain},502,cors);
      seen.add(current);
      let raw;
      try {
        raw = await oracleDiagnosticResourceGet(env, `/${encodeURIComponent(current)}`,
          new URLSearchParams({fields:RESOURCE_DIAG_FIELDS}));
      } catch (error) {
        if (chain.length === 0) throw error;
        return jsonResponse({ok:true,resourceId:id,chain,root:chain[chain.length-1],
          hierarchyComplete:false,missingParentId:current,
          configuredTreeMatches:chain.filter(n=>DEFAULT_TREES.includes(n.resourceId)).map(n=>n.resourceId),
          note:"No se pudo consultar un ancestro: revisar permisos del usuario API.",
          detail:String(error?.message||error)},200,cors);
      }
      const row = resourceSummary(raw);
      if (!row.resourceId) throw new Error(`Oracle no devolvió resourceId para ${current}`);
      chain.push(row);
      current = row.parentResourceId;
    }
    if (current) throw new Error("Profundidad máxima de jerarquía alcanzada (100).");
    return jsonResponse({ok:true,resourceId:id,chain,root:chain[chain.length-1]||null,
      hierarchyComplete:true,
      configuredTreeMatches:chain.filter(n=>DEFAULT_TREES.includes(n.resourceId)).map(n=>n.resourceId),
      coveredByConfiguredTree:chain.some(n=>DEFAULT_TREES.includes(n.resourceId)),
      note:"chain se ordena desde el recurso consultado hasta su raíz."},200,cors);
  } catch (error) {
    return jsonResponse({ok:false,error:"No se pudo ubicar el recurso.",detail:String(error?.message||error)},502,cors);
  }
}


/* =========================================================
   DIAGNOSTICO GLOBAL DE ACTIVIDADES, SIN FILTRO resources
   Sólo lectura; no modifica el operativo ni sincronizaciones.
   ========================================================= */
async function handleUnfilteredActivityDiagnostic(request, env, url, cors) {
  const today = ymdInTimeZone(new Date());
  const from = String(url.searchParams.get("from") || addDaysToYmd(today,-1)).trim();
  const to = String(url.searchParams.get("to") || today).trim();
  const includeItems = url.searchParams.get("includeItems") === "1";
  const ticket = String(url.searchParams.get("ticket") || "").trim().toUpperCase();
  const maxPages = Number(url.searchParams.get("maxPages") || 10);
  if (!validYmd(from) || !validYmd(to) || from > to ||
      (Date.parse(to+"T00:00:00Z") - Date.parse(from+"T00:00:00Z")) / 86400000 > 30) {
    return jsonResponse({ok:false,error:"Rango inválido: from/to YYYY-MM-DD, máximo 31 días inclusivos."},400,cors);
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 20)
    return jsonResponse({ok:false,error:"maxPages debe estar entre 1 y 20."},400,cors);
  if (ticket && !/^[A-Z0-9-]{1,64}$/.test(ticket))
    return jsonResponse({ok:false,error:"ticket inválido."},400,cors);

  const base = String(env.OFSC_BASE_URL || "").replace(/\/+$/, "");
  if (!base) return jsonResponse({ok:false,error:"Falta OFSC_BASE_URL"},503,cors);
  const pageSize = 5000;
  let offset=0, count=0, pages=0, oracleHasMore=false;
  const byResource=new Map(), byStatus=new Map(), byActivityType=new Map();
  const ticketMatches=[];
  const samples=[];
  const items=[];
  try {
    for (let n=0; n<maxPages; n++) {
      // No incluir resources, includeChildren ni q: consulta realmente global.
      const params = new URLSearchParams({
        dateFrom:from,dateTo:to,limit:String(pageSize),offset:String(offset),
        fields:"activityId,apptNumber,resourceId,date,status,activityType,XA_resource_name,XA_contract_activity,XA_Node,XA_Eventticket"
      });
      const response = await fetch(`${base}/rest/ofscCore/v1/activities?${params.toString()}`, {
        method:"GET", headers:{Authorization:basicAuth(env),Accept:"application/json"}
      });
      if (!response.ok) {
        const body=await response.text().catch(()=>"");
        return jsonResponse({ok:false,source:"oracle_activities_without_resources",from,to,
          error:`Oracle HTTP ${response.status}`,
          detail:body.slice(0,1200),
          note:"La consulta omitió resources completamente. No se sustituyó por los siete árboles."},502,cors);
      }
      const data=await response.json();
      const batch=Array.isArray(data.items)?data.items:[];
      pages++;
      for (const a of batch) {
        count++;
        const resource=String(a.resourceId??"(sin recurso)");
        const status=String(a.status??"(sin estado)");
        const activityType=String(a.activityType??"(sin tipo)");
        byResource.set(resource,(byResource.get(resource)||0)+1);
        byStatus.set(status,(byStatus.get(status)||0)+1);
        byActivityType.set(activityType,(byActivityType.get(activityType)||0)+1);
        const brief={activityId:a.activityId??null,apptNumber:a.apptNumber??null,
          resourceId:a.resourceId??null,resourceName:a.XA_resource_name??null,
          contractor:a.XA_contract_activity??null,date:a.date??null,status:a.status??null,
          activityType:a.activityType??null,node:a.XA_Node??null,eventTicket:a.XA_Eventticket??null};
        if (samples.length<20) samples.push(brief);
        if (ticket && String(a.apptNumber||"").trim().toUpperCase()===ticket) ticketMatches.push(brief);
        if (includeItems && items.length<1000) items.push(brief);
      }
      offset+=batch.length;
      const reportedTotal=Number(data.totalResults);
      oracleHasMore=data.hasMore===true || batch.length===pageSize ||
        (Number.isFinite(reportedTotal) && reportedTotal>offset);
      if (!batch.length || !oracleHasMore) break;
    }
    const ranked=m=>[...m].map(([value,quantity])=>({value,count:quantity})).sort((a,b)=>b.count-a.count || a.value.localeCompare(b.value));
    return jsonResponse({ok:true,source:"oracle_activities_without_resources",from,to,
      parameters:{resources:"OMITIDO",includeChildren:"OMITIDO",q:"OMITIDO"},
      pagination:{pageSize,pages,maxPages,read:count,truncated:oracleHasMore && pages===maxPages},
      distinctResources:byResource.size,byResource:ranked(byResource),
      byStatus:ranked(byStatus),byActivityType:ranked(byActivityType),
      ticket:ticket||null,ticketMatches,samples,
      ...(includeItems?{items,itemsTruncated:count>items.length}:{}),
      note:"byResource lista recursos asignados a actividades, NO necesariamente raíces de árboles. /api/recursos/arboles muestra la jerarquía. Si truncated=true repetir con maxPages mayor o fechas separadas."},200,cors);
  } catch(error) {
    return jsonResponse({ok:false,error:"Falló diagnóstico sin árbol",detail:String(error?.message||error)},502,cors);
  }
}


function etaOperativoSinNotas(body, requested) {
  if(!requested)return body;
  try {
    const payload=JSON.parse(body);
    if(payload && Array.isArray(payload.items)){
      payload.items=payload.items.map(item=>{
        const row={...item};
        delete row.XA_Activity_Notes;
        delete row.closure_notes;
        return row;
      });
      return JSON.stringify(payload);
    }
  }catch(error){ console.warn('Operativo sin notas: JSON original conservado', String(error)); }
  return body;
}

async function handleOperativoProxy(request, env, url, cors) {
  const base = String(env.OPERATIVO_SHEETS_URL || "").trim();
  if (!base) return jsonResponse({ok:false,error:"Falta OPERATIVO_SHEETS_URL"},503,cors);

  const refresh = url.searchParams.get("refresh") === "1";
  const cacheUrl = new URL(url.toString());
  cacheUrl.searchParams.delete("refresh");
  const cacheKey = new Request(cacheUrl.toString(), {method:"GET"});
  const cache = caches.default;

  try {
    if (!refresh) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const headers = new Headers(hit.headers);
        Object.entries(cors).forEach(([k,v]) => headers.set(k,v));
        headers.set("X-Operativo-Cache","HIT");
        return new Response(hit.body,{status:hit.status,headers});
      }
    }

    const upstream = new URL(base);
    for (const [k,v] of url.searchParams.entries()) {
      if (k !== "refresh") upstream.searchParams.set(k,v);
    }

    const r = await fetch(upstream.toString(), {
      method: "GET",
      redirect: "follow",
      headers: {"Accept":"application/json"}
    });
    const body = etaOperativoSinNotas(await r.text(), url.searchParams.get('sin_notas') === '1');
    const contentType = r.headers.get("Content-Type") || "application/json; charset=utf-8";

    const publicHeaders = {
      ...cors,
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=120",
      "X-Operativo-Cache": "MISS"
    };

    const response = new Response(body,{status:r.status,headers:publicHeaders});

    // Guardar sólo respuestas correctas durante 2 minutos.
    if (r.ok) {
      const cacheHeaders = new Headers({
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=120"
      });
      await cache.put(cacheKey,new Response(body,{status:r.status,headers:cacheHeaders}));
    }

    return response;
  } catch(error) {
    // Si el upstream falla, intentar servir una copia cacheada aunque sea anterior.
    const stale = await cache.match(cacheKey);
    if (stale) {
      const headers = new Headers(stale.headers);
      Object.entries(cors).forEach(([k,v]) => headers.set(k,v));
      headers.set("X-Operativo-Cache","STALE");
      headers.set("Warning",'110 - "Respuesta operativa desde cache por error upstream"');
      return new Response(stale.body,{status:stale.status,headers});
    }
    return jsonResponse({ok:false,error:"Proxy operativo: "+String(error?.message||error)},502,cors);
  }
}

export default {
  async scheduled(controller,env,ctx) {
    // Doble seguro: cursor PAUSADO y variable HISTORY_CRON_ENABLED desactivada por defecto.
    if (String(env.HISTORY_CRON_ENABLED || "false").toLowerCase() !== "true") {
      console.log("OFSC_HISTORY_SCHEDULED PAUSADO por configuración");
      return;
    }
    ctx.waitUntil(runHistoryScheduledStep(env)
      .then(result => console.log('OFSC_HISTORY_SCHEDULED',JSON.stringify(result)))
      .catch(error => { console.error('OFSC_HISTORY_SCHEDULED_ERROR',String(error?.message || error)); throw error; }));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors
      });
    }


    // Actividades sin filtro de árbol, exclusivamente para diagnóstico.
    if (request.method === "GET" && url.pathname === "/api/diagnostico/comparar-cobertura") {
      return handleCoverageComparison(request, env, url, cors);
    }
    if (request.method === "GET" && url.pathname === "/api/diagnostico/todos-recursos") {
      return handleDiscoveredActivities(request, env, url, cors);
    }
    if (request.method === "GET" && url.pathname === "/api/recursos/todos") {
      return handleAllResources(request, env, url, cors);
    }
    if (request.method === "GET" && url.pathname === "/api/diagnostico/sin-arbol") {
      return handleUnfilteredActivityDiagnostic(request, env, url, cors);
    }

    // Diagnóstico autenticado de jerarquías OFSC (sin cambios operativos).
    if (request.method === "GET" && url.pathname === "/api/recursos/arboles") {
      return handleResourceTrees(request, env, cors);
    }
    if (request.method === "GET" && url.pathname === "/api/recursos/ubicacion") {
      return handleResourceLocation(request, env, url, cors);
    }

    // Proxy CORS para el operativo servido por Apps Script / Google Sheets.
    if (request.method === "GET" && url.pathname === "/api/operativo") {
      return handleOperativoProxy(request, env, url, cors);
    }

    // Control y prueba manual del programador: nunca exponer cursor sin autenticación.
    if (url.pathname === "/api/historico/cron-status") {
      if (request.method !== "GET") return jsonResponse({ok:false,error:"Requiere GET"},405,cors);
      if (!historyAuthorized(request,env)) return jsonResponse({ok:false,error:"No autorizado"},401,cors);
      try {
        const cursor=await env.DB.prepare("SELECT * FROM historico_cursor WHERE id=1").first();
        return jsonResponse({ok:true,cursor},200,cors);
      } catch(error) {return jsonResponse({ok:false,error:String(error?.message||error)},503,cors);}
    }
    if (url.pathname === "/api/historico/cron-test") {
      if (request.method !== "POST") return jsonResponse({ok:false,error:"Requiere POST"},405,cors);
      if (!historyAuthorized(request,env)) return jsonResponse({ok:false,error:"No autorizado"},401,cors);
      if (String(env.HISTORY_CRON_ENABLED || "false").toLowerCase() !== "true") return jsonResponse({ok:true,skipped:true,reason:"CONFIG_PAUSADO"},200,cors);
      try { return jsonResponse(await runHistoryScheduledStep(env),200,cors); }
      catch(error) { return jsonResponse({ok:false,error:String(error?.message||error)},502,cors); }
    }

    // V19: completar únicamente columnas Tableau en la misma tabla histórica.
    if (url.pathname === '/api/historico/complementar') {
      if (request.method !== 'POST') return jsonResponse({ok:false,error:'Requiere POST'},405,cors);
      return handleHistoryTableauComplement(request,env,cors);
    }

    // Sincronización histórica autenticada: sólo POST.
    if (url.pathname === "/api/historico/sync") {
      if (request.method !== "POST") return jsonResponse({ok:false,error:"Requiere POST"},405,cors);
      return handleHistorySync(request,env,url,cors);
    }
    if (request.method === "GET" && url.pathname === "/api/historico") return handleHistoryRows(env,url,cors);
    if (request.method === "GET" && url.pathname === "/api/historico/tickets") return handleHistoryLastStatus(env,url,cors);
    if (request.method === "GET" && url.pathname === "/api/historico/resumen") return handleHistorySummary(env,url,cors);

    if (request.method !== "GET") {
      return jsonResponse({
        error: "Método no permitido."
      }, 405, cors);
    }

    if (url.pathname === "/api/db-check") {
      if (!env.DB) return jsonResponse({ok:false,error:"Falta binding DB"},503,cors);
      try {
        const [nodes, tasks, events] = await Promise.all([
          env.DB.prepare("SELECT COUNT(*) AS total FROM nodos_contratistas").first(),
          env.DB.prepare("SELECT COUNT(*) AS total FROM reglas_tareas").first(),
          env.DB.prepare("SELECT COUNT(*) AS total FROM reglas_eventos").first()
        ]);
        return jsonResponse({ok:true,database:"nodos",tables:{
          nodos_contratistas:nodes?.total ?? 0,
          reglas_tareas:tasks?.total ?? 0,
          reglas_eventos:events?.total ?? 0
        }},200,cors);
      } catch(error) {
        return jsonResponse({ok:false,error:String(error?.message || error)},503,cors);
      }
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "infra-activities-proxy",
        classification: {
          source: "D1",
          d1Binding: "DB",
          tables: [
            "nodos_contratistas",
            "reglas_tareas",
            "reglas_eventos"
          ],
          fields: [
            "Capa",
            "SubCapa",
            "TipificacionTarea",
            "Origen",
            "Contratista"
          ]
        },
        endpoints: {
          dbCheck: "/api/db-check",
          resourceTrees: "/api/recursos/arboles",
          allResources: "/api/recursos/todos?page=1&limit=200",
          discoveredActivities: "/api/diagnostico/todos-recursos?from=YYYY-MM-DD&to=YYYY-MM-DD&ticket=...",
          unfilteredActivities: "/api/diagnostico/sin-arbol?from=YYYY-MM-DD&to=YYYY-MM-DD",
          resourceLocation: "/api/recursos/ubicacion?resourceId=1001-0008 (Bearer HISTORY_SYNC_TOKEN)",
          // RUTAS EXISTENTES: SIN CAMBIOS
          infra: "/api/infra",
          all: "/api/all",
          generic: "/api/activities?scope=infra|all",

          // DIAGNOSTICO POR TICKET
          ticket:
            "/api/ticket?apptNumber=260922VRG00015",
          ticketCustomRange:
            "/api/ticket?apptNumber=260922VRG00015&from=2026-09-01&to=2026-10-29",

          // NUEVAS RUTAS
          allduplicate:
            "/api/allduplicate",

          allduplicateContractor:
            "/api/allduplicate?contractor=INSERTEL",

          finalRange:
            "/api/final_range?from=YYYY-MM-DD&to=YYYY-MM-DD&tree=USAC",

          allduplicateRange:
            "/api/allduplicate_range?from=YYYY-MM-DD&to=YYYY-MM-DD",

          allduplicateRangeTree:
            "/api/allduplicate_range?from=YYYY-MM-DD&to=YYYY-MM-DD&tree=USAC",

          allduplicateRangeContractor:
            "/api/allduplicate_range?from=YYYY-MM-DD&to=YYYY-MM-DD&contractor=INSERTEL"
        }
      }, 200, cors);
    }


    /* =====================================================
       DIAGNOSTICO RAPIDO POR TICKET
       ===================================================== */

    if (url.pathname === "/api/ticket") {
      return handleTicketLookup(request, env, url, cors);
    }


    /* =====================================================
       DATASET FINAL - MISMA FUENTE DEL FRONT
       ===================================================== */

    if (url.pathname === "/api/final_range") {
      return handleFinalRange(request, env, url, cors);
    }


    /* =====================================================
       NUEVAS RUTAS
       ===================================================== */

    if (url.pathname === "/api/allduplicate") {
      return handleAllDuplicate(
        request,
        env,
        url,
        cors
      );
    }

    if (url.pathname === "/api/allduplicate_range") {
      return handleAllDuplicateRange(
        request,
        env,
        url,
        cors
      );
    }


    /* =====================================================
       A PARTIR DE ACA SE MANTIENE LA LOGICA ANTERIOR
       ===================================================== */

    const scope = resolveScope(
      url.pathname,
      url
    );

    if (!scope) {
      return jsonResponse({
        error: "Ruta no encontrada."
      }, 404, cors);
    }

    const defaults = defaultRange(scope);

    const dateFrom =
      url.searchParams.get("dateFrom") ||
      defaults.dateFrom;

    const dateTo =
      url.searchParams.get("dateTo") ||
      defaults.dateTo;

    if (
      !validYmd(dateFrom) ||
      !validYmd(dateTo)
    ) {
      return jsonResponse({
        error:
          "dateFrom y dateTo deben usar formato YYYY-MM-DD."
      }, 400, cors);
    }

    const trees =
      scope === "infra"
        ? ["INFRA"]
        : DEFAULT_TREES;

    try {
      const results = await Promise.all(
        trees.map(tree =>
          fetchTree(
            env,
            tree,
            dateFrom,
            dateTo
          )
        )
      );

      const rawItems = results.flat();

      // Comportamiento anterior:
      // deduplicar por Número de Orden y conservar
      // la ocurrencia más futura.
      const dedupedItems =
        dedupeByOrderKeepFurthest(
          rawItems
        );

      const duplicatesRemoved =
        rawItems.length -
        dedupedItems.length;

      let items = dedupedItems;

      let outsideCaba = 0;
      let invalidCoordinates = 0;

      // /api/infra: filtro CABA.
      // /api/all: sin filtro geográfico.
      if (scope === "infra") {
        const cabaResult =
          filterInsideCaba(
            dedupedItems
          );

        items =
          cabaResult.items;

        outsideCaba =
          cabaResult.outsideCaba;

        invalidCoordinates =
          cabaResult.invalidCoordinates;
      }

      const byTree = {};

      for (const tree of trees) {
        byTree[tree] = 0;
      }

      for (const item of items) {
        byTree[item.Arbol] =
          (byTree[item.Arbol] || 0) + 1;
      }

      return jsonResponse({
        meta: {
          scope,
          trees,
          dateFrom,
          dateTo,
          generatedAt:
            new Date().toISOString(),
          timezone: TIMEZONE,

          count: items.length,
          rawCount: rawItems.length,
          duplicatesRemoved,

          cabaFilterApplied:
            scope === "infra",

          outsideCaba,
          invalidCoordinates,

          byTree
        },

        items
      }, 200, cors);

    } catch (error) {
      console.error(error);

      return jsonResponse({
        error:
          "No se pudo completar la consulta.",

        detail:
          String(
            error?.message ||
            error
          )
      }, 502, cors);
    }
  }
};
