import React, { useState, useMemo, useEffect } from "react";
import Papa from "papaparse";

// ───────────────────────────────────────────────────────────────────────────
//  RO PUBLIC DATA — ENGLISH
//  A lightweight English-language window into Romanian public registries:
//   1. ANAF  — fiscal data (VAT status, activity, e-Invoice) by CUI
//   2. SEAP  — public procurement contracts via data.gov.ro CKAN
//   3. AI    — natural-language question → structured query (via Claude API)
//
//  Notes on data sources:
//   • ANAF endpoint:  https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva
//     - Public POST endpoint, no API key. Browser calls are blocked by CORS,
//       so we route through a public proxy. For production, run your own
//       proxy (10 lines of Express) or call from your backend.
//   • data.gov.ro CKAN:  https://data.gov.ro/api/3/action/datastore_search
//     - JSONP-friendly. Datasets per year (achizitii-publice-2024, etc.).
//     - You point at a specific resource_id (CSV exposed as a datastore).
//   • ONRC has no clean public REST API — most of the fields it exposes
//     (registration number, legal form, activity status) come back inside
//     the ANAF response already (nrRegCom, formajuridica, stareinregistrare).
// ───────────────────────────────────────────────────────────────────────────

// Public CORS proxy. Replace with your own in production.
const PROXY = "/api/proxy?url=";
const ANAF_URL = "https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva";

// data.gov.ro publishes one dataset per year, each with several CSV resources
// (Contracts, Participation notices, Direct purchases, etc). The resource_id
// values below are the live ones for the "Contracte" CSV per year.
// If a resource_id 404s, the user can paste a fresh one — data.gov.ro
// occasionally re-publishes resources with new UUIDs.
const SEAP_FILES = {
  "2024-q1": { label: "Q1 2024", path: "/data/contracts-2024-q1.csv" },
};

// In-memory cache: parsed rows survive tab-switches
const seapCache = {};

// ───────────────────────────────────────────────────────────────────────────
//  Field translation table — ANAF responds in Romanian. We render in English.
// ───────────────────────────────────────────────────────────────────────────
const ANAF_LABELS = {
  cui:                  "Tax ID (CUI)",
  denumire:             "Legal name",
  adresa:               "Fiscal address",
  nrRegCom:             "Trade Register no.",
  telefon:              "Phone",
  fax:                  "Fax",
  codPostal:            "Postal code",
  stareinregistrare:    "Registration status",
  datainregistrare:     "Registration date",
  codCAEN:              "CAEN code",
  iban:                 "IBAN",
  statusROeFactura:     "e-Invoice registered",
  organFiscalCompetent: "Competent fiscal authority",
  formadeproprietate:   "Form of ownership",
  formaorganizare:      "Organisational form",
  formajuridica:        "Legal form",
};

// Romanian status strings we translate on the fly.
const STATUS_EN = (ro = "") => {
  const s = ro.toLowerCase();
  if (s.includes("functiune") || s.includes("funcțiune")) return "Active";
  if (s.includes("inactiv"))    return "Inactive";
  if (s.includes("radiat"))     return "Struck off";
  if (s.includes("suspendat"))  return "Suspended";
  return ro || "—";
};

// ───────────────────────────────────────────────────────────────────────────
//  ANAF lookup
// ───────────────────────────────────────────────────────────────────────────
async function fetchAnaf(cui) {
  const cleanCui = String(cui).replace(/^RO/i, "").trim();
  const today = new Date().toISOString().slice(0, 10);
  const body = JSON.stringify([{ cui: Number(cleanCui), data: today }]);

  console.log("[ANAF] sending →", { cui: cleanCui, date: today });

  const res = await fetch(PROXY + encodeURIComponent(ANAF_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  console.log("[ANAF] HTTP status:", res.status);
  if (!res.ok) throw new Error(`Proxy returned ${res.status}`);
  const data = await res.json();
  console.log("[ANAF] parsed:", data);

  const hit = data.found && data.found[0];
  if (!hit) throw new Error(`CUI ${cleanCui} not found in ANAF registry`);
  return hit;
}

// ───────────────────────────────────────────────────────────────────────────
//  data.gov.ro CKAN — discover the "Contracte" resource for a given year
// ───────────────────────────────────────────────────────────────────────────
async function loadProcurementData(key) {
  if (seapCache[key]) return seapCache[key];
  const file = SEAP_FILES[key];
  if (!file) throw new Error(`Unknown dataset: ${key}`);

  console.log("[SEAP] loading", file.path);
  const res = await fetch(file.path);
  if (!res.ok) throw new Error(`Failed to load ${file.path}: ${res.status}`);
  const text = await res.text();

  return new Promise((resolve, reject) => {
    Papa.parse(text, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        console.log("[SEAP] parsed", result.data.length, "rows");
        seapCache[key] = result.data;
        resolve(result.data);
      },
      error: reject,
    });
  });
}

function searchProcurementLocal(rows, q) {
  if (!q || !q.trim()) return rows.slice(0, 50);
  const needle = q.toLowerCase().trim();
  const hits = [];
  for (const row of rows) {
    for (const v of Object.values(row)) {
      if (v && String(v).toLowerCase().includes(needle)) {
        hits.push(row);
        break;
      }
    }
    if (hits.length >= 200) break;
  }
  return hits;
}

// ───────────────────────────────────────────────────────────────────────────
//  Natural-language question → structured intent  (uses the Claude API)
// ───────────────────────────────────────────────────────────────────────────
async function askAI(question) {
  const sys = `You are a routing layer for a Romanian public-data lookup tool.
You receive a question in English and must respond with ONLY a JSON object
(no prose, no markdown fences) describing how to answer it. Schema:

{ "intent": "anaf" | "procurement" | "explain",
  "cui":    string | null,        // Romanian tax ID, digits only
  "query":  string | null,        // free-text keyword(s) for procurement search
  "year":   "2022" | "2023" | "2024" | null,
  "explanation": string           // 1-2 sentence English summary of what you'll do
}

Rules:
- If the user names a company, infer that you need its CUI but leave cui:null
  and set intent:"explain" with an explanation telling them to provide the CUI.
- If the user gives a CUI (digits, optionally prefixed RO), intent="anaf".
- If the question is about contracts, tenders, suppliers, CPV codes, public
  procurement → intent="procurement", pick a recent year, extract keywords.
- Default year is 2024 if unspecified.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: sys,
      messages: [{ role: "user", content: question }],
    }),
  });
  const json = await res.json();
  const text = (json.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
    .replace(/^```(?:json)?|```$/g, "")
    .trim();
  try { return JSON.parse(text); }
  catch { return { intent: "explain", explanation: text || "Could not parse AI response." }; }
}

// ───────────────────────────────────────────────────────────────────────────
//  UI
// ───────────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("anaf");
  return (
    <div style={S.page}>
      <style>{CSS}</style>

      <header style={S.header}>
        <div style={S.brandRow}>
          <div style={S.flag} aria-hidden>
            <span style={{ background: "#002B7F" }} />
            <span style={{ background: "#FCD116" }} />
            <span style={{ background: "#CE1126" }} />
          </div>
          <div>
            <h1 style={S.h1}>Romanian Public Data <em>in English</em></h1>
            <p style={S.tagline}>
              ANAF fiscal lookup · SEAP procurement search · Natural-language queries.
              Open registries, no account, no fees.
            </p>
          </div>
        </div>
        <nav style={S.tabs}>
          {[
            ["anaf",        "Company / ANAF"],
            ["procurement", "Procurement / SEAP"],
            ["ai",          "Ask in English"],
            ["about",       "Sources"],
          ].map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
                    style={{ ...S.tab, ...(tab === k ? S.tabActive : {}) }}>
              {label}
            </button>
          ))}
        </nav>
      </header>

      <main style={S.main}>
        {tab === "anaf"        && <AnafPanel />}
        {tab === "procurement" && <ProcurementPanel />}
        {tab === "ai"          && <AIPanel />}
        {tab === "about"       && <AboutPanel />}
      </main>

      <footer style={S.footer}>
        <span>Data: ANAF · data.gov.ro · ONRC (via ANAF fields)</span>
        <span style={{ opacity: 0.5 }}>
          For production, route ANAF calls through your own proxy or backend.
        </span>
      </footer>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
function AnafPanel() {
  const [cui, setCui]       = useState("");
  const [data, setData]     = useState(null);
  const [err, setErr]       = useState("");
  const [busy, setBusy]     = useState(false);

  const run = async (value) => {
  const target = (value ?? cui).trim();
  if (!target) return;
  setCui(target);
  setBusy(true); setErr(""); setData(null);
  try { setData(await fetchAnaf(target)); }
  catch (e) { console.error("LOOKUP FAILED:", e); setErr(e.message); }
  finally { setBusy(false); }
};

  return (
    <section>
      <h2 style={S.h2}>Look up a Romanian company</h2>
      <p style={S.lead}>
        Enter a Tax ID (CUI / CIF) — digits only, or prefixed with <code>RO</code>.
        Returns live data from ANAF: legal name, address, VAT status, activity
        status, e-Invoice registration, and Trade Register number.
      </p>

      <div style={S.queryBar}>
        <input
          value={cui}
          onChange={(e) => setCui(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder="e.g. 14837428"
          style={S.input}
          autoFocus
        />
        <button onClick={() => run()} disabled={busy} style={S.btn}>
          {busy ? "Querying ANAF…" : "Look up"}
        </button>
      </div>

      <div style={S.exampleRow}>
        Try:
        {["14837428", "8939059", "23093488"].map((c) => (
  <button key={c} style={S.chip}
          onClick={() => run(c)}>
    {c}
  </button>
))}
      </div>

      {err  && <div style={S.error}>⚠ {err}</div>}
      {data && <AnafResult data={data} />}
    </section>
  );
}

function AnafResult({ data }) {
  const g  = data.date_generale          || {};
  const v  = data.inregistrare_scop_Tva  || {};
  const i  = data.stare_inactiv          || {};
  const f  = data.inregistrare_RTVAI     || {};
  const ef = data.inregistrare_SplitTVA  || {};

  const isActive = !i.statusInactivi;
  const isVAT    = v.scpTVA;
  const onEFact  = g.statusRO_e_Factura;

  return (
    <article style={S.result}>
      <header style={S.resultHead}>
        <div>
          <div style={S.companyName}>{g.denumire || "—"}</div>
          <div style={S.companyMeta}>
            CUI {g.cui} · Reg. Com. {g.nrRegCom || "—"} · {g.formajuridica || "—"}
          </div>
        </div>
        <div style={S.badgeRow}>
          <Badge ok={isActive} label={isActive ? "Active" : "Inactive"} />
          <Badge ok={isVAT}    label={isVAT ? "VAT registered" : "Not VAT registered"} />
          <Badge ok={onEFact}  label={onEFact ? "On e-Invoice" : "Not on e-Invoice"} />
        </div>
      </header>

      <div style={S.grid}>
        <Field label="Legal name"          value={g.denumire} />
        <Field label="Tax ID (CUI)"        value={g.cui} mono />
        <Field label="Trade Register no."  value={g.nrRegCom} mono />
        <Field label="Registration status" value={STATUS_EN(g.stareinregistrare)} />
        <Field label="Registered since"    value={g.data_inregistrare} mono />
        <Field label="CAEN code"           value={g.codCAEN} mono />
        <Field label="Fiscal address"      value={g.adresa} wide />
        <Field label="Postal code"         value={g.cod_postal} mono />
        <Field label="Phone"               value={g.telefon} mono />
        <Field label="IBAN"                value={g.iban} mono />
        <Field label="Legal form"          value={g.forma_juridica} />
        <Field label="Form of ownership"   value={g.forma_de_proprietate} />
        <Field label="Competent authority" value={g.organFiscalCompetent} wide />
      </div>

      <details style={S.details}>
        <summary>VAT history & status</summary>
        <div style={S.subgrid}>
          <Field label="VAT registered" value={isVAT ? "Yes" : "No"} />
          <Field label="Effective from" value={v.perioade_TVA?.[0]?.data_inceput_ScpTVA || "—"} mono />
          <Field label="Ends"           value={v.perioade_TVA?.[0]?.data_sfarsit_ScpTVA || "—"} mono />
          <Field label="Cash VAT"       value={f.statusTvaIncasare ? "Yes" : "No"} />
        </div>
      </details>

      <details style={S.details}>
        <summary>Raw ANAF response</summary>
        <pre style={S.pre}>{JSON.stringify(data, null, 2)}</pre>
      </details>
    </article>
  );
}

// ───────────────────────────────────────────────────────────────────────────
function ProcurementPanel() {
  const [dataset, setDataset] = useState("2024-q1");
  const [q, setQ]       = useState("");
  const [rows, setRows] = useState([]);
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState("");
  const [loading, setLoading] = useState(true);

  // Load CSV when dataset changes
  useEffect(() => {
    setLoading(true); setErr(""); setResults(null);
    loadProcurementData(dataset)
      .then((data) => { setRows(data); setLoading(false); })
      .catch((e) => { setErr(e.message); setLoading(false); });
  }, [dataset]);

  const run = (value) => {
  const target = value ?? q;
  setQ(target);
  setBusy(true); setErr("");
  try {
    const hits = searchProcurementLocal(rows, target);
    setResults({ records: hits, total: hits.length, all: rows.length });
  } catch (e) { setErr(e.message); }
  finally { setBusy(false); }
};

  return (
    <section>
      <h2 style={S.h2}>Search public procurement contracts</h2>
      <p style={S.lead}>
        Full-text search across SEAP contract awards. Data sourced from
        data.gov.ro quarterly exports and bundled with the app for instant search.
        Currently <strong>Q1 2024 only</strong> — additional quarters coming soon.
      </p>

      <div style={S.queryBar}>
        <select value={dataset} onChange={(e) => setDataset(e.target.value)} style={S.select}>
          {Object.entries(SEAP_FILES).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !loading && run()}
          placeholder='Supplier name, CPV code, authority, county…'
          style={{ ...S.input, flex: 1 }}
          disabled={loading}
        />
        <button onClick={() => run()} disabled={busy || loading} style={S.btn}>
          {loading ? "Loading data…" : busy ? "Searching…" : "Search"}
        </button>
      </div>

      <div style={S.exampleRow}>
        Try:
        {["medicamente", "servicii IT", "Bucuresti", "33141000"].map((s) => (
  <button key={s} style={S.chip}
          onClick={() => run(s)}
          disabled={loading}>
    {s}
  </button>
))}
      </div>

      {loading && <div style={S.empty}>Loading {SEAP_FILES[dataset].label} contracts…</div>}
      {err && <div style={S.error}>⚠ {err}</div>}
      {results && <ProcurementResults results={results} />}
    </section>
  );
}

function ProcurementResults({ results }) {
  const records = results.records || [];
  if (!records.length) return <div style={S.empty}>No contracts matched.</div>;

  const cols = [
    ["Date",      "Data contract"],
    ["Authority", "Autoritate contractanta"],
    ["Supplier",  "Ofertant"],
    ["CPV",       "Cod CPV"],
    ["Object",    "Denumire CPV"],
    ["Value",     "Valoare contract (RON)"],
    ["County",    "Oras"],
  ];

  return (
    <div>
      <div style={S.resultsCount}>
        {records.length} matches (of {results.all.toLocaleString()} contracts in dataset)
      </div>
      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>{cols.map(([l]) => <th key={l} style={S.th}>{l}</th>)}</tr>
          </thead>
          <tbody>
            {records.map((r, i) => (
              <tr key={i} style={i % 2 ? S.trAlt : null}>
                {cols.map(([l, k]) => (
                  <td key={l} style={S.td}>{String(r[k] ?? "—").slice(0, 200)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
function AIPanel() {
  const [q, setQ]       = useState("");
  const [plan, setPlan] = useState(null);
  const [result, setR]  = useState(null);
  const [err, setErr]   = useState("");
  const [busy, setBusy] = useState(false);

  const examples = [
    "What's the VAT status of CUI 14837428?",
    "Find IT services contracts from 2024",
    "Show me medicine procurement contracts last year",
    "Is Borg Design active?",
  ];

  const run = async (question = q) => {
    if (!question.trim()) return;
    setBusy(true); setErr(""); setPlan(null); setR(null);
    try {
      const p = await askAI(question);
      setPlan(p);
      if (p.intent === "anaf" && p.cui) {
        setR({ type: "anaf", data: await fetchAnaf(p.cui) });
      } else if (p.intent === "procurement") {
        const year = p.year || "2024";
        const data = await searchProcurement({ year, q: p.query || "", limit: 15 });
        setR({ type: "procurement", data });
      }
    } catch (e) { console.error("LOOKUP FAILED:", e); setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <section>
      <h2 style={S.h2}>Ask in plain English</h2>
      <p style={S.lead}>
        Type a question; an AI layer translates it into the right registry
        call. Useful when you don't know whether your answer lives in ANAF,
        SEAP, or both.
      </p>

      <div style={S.queryBar}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder="e.g. Find IT services contracts won in 2024"
          style={{ ...S.input, flex: 1 }}
        />
        <button onClick={() => run()} disabled={busy} style={S.btn}>
          {busy ? "Thinking…" : "Ask"}
        </button>
      </div>

      <div style={S.exampleRow}>
        Try:
        {examples.map((e) => (
          <button key={e} style={S.chip}
                  onClick={() => { setQ(e); setTimeout(() => run(e), 0); }}>
            {e}
          </button>
        ))}
      </div>

      {err  && <div style={S.error}>⚠ {err}</div>}
      {plan && (
        <div style={S.plan}>
          <strong>Plan:</strong> {plan.explanation || "—"}
          <span style={S.planTag}>{plan.intent}</span>
        </div>
      )}
      {result?.type === "anaf"        && <AnafResult data={result.data} />}
      {result?.type === "procurement" && <ProcurementResults res={result.data} />}
    </section>
  );
}

// ───────────────────────────────────────────────────────────────────────────
function AboutPanel() {
  return (
    <section>
      <h2 style={S.h2}>Where the data comes from</h2>
      <div style={S.sources}>
        <Source
          name="ANAF"
          full="National Agency for Fiscal Administration"
          endpoint="webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva"
          what="VAT registration, fiscal activity status, e-Invoice enrolment, Trade Register number, CAEN code, registered address, IBAN. Public, no key. POST JSON. Max 100 CUIs per call, 1 req/s."
        />
        <Source
          name="SEAP / SICAP"
          full="Electronic Public Procurement System (mirrored via data.gov.ro)"
          endpoint="data.gov.ro/api/3/action/datastore_search"
          what="All awarded contracts, participation notices, direct purchases — one dataset per year (achizitii-publice-YYYY). Full-text search across all columns. CKAN datastore_search supports filters and SQL."
        />
        <Source
          name="ONRC"
          full="National Trade Register Office"
          endpoint="(no clean public API)"
          what="The registration number, legal form, and activity status that nominally come from ONRC are already returned inside the ANAF response (nrRegCom, formajuridica, stareinregistrare). For shareholders, directors, share capital — those require an ONRC paid certificate."
        />
      </div>

      <h3 style={S.h3}>Architecture notes</h3>
      <ul style={S.bulletList}>
        <li>ANAF blocks browser CORS, so we route through a public proxy. In production, run your own (a 10-line Express handler does it).</li>
        <li>data.gov.ro CKAN is CORS-friendly and returns JSON directly.</li>
        <li>The AI layer is a thin translation step — it never invents data, only routes your question to the right registry call.</li>
        <li>Resource IDs on data.gov.ro change when files are re-uploaded. The app discovers them at runtime via <code>package_show</code>, so it self-heals.</li>
      </ul>

      <h3 style={S.h3}>What this <em>doesn't</em> do (yet)</h3>
      <ul style={S.bulletList}>
        <li>Cross-register correlation in a single query (e.g. "active companies with turnover &gt; 5M that won IT contracts"). That needs server-side joins on bulk SEAP data.</li>
        <li>Administrator / shareholder lookup. ONRC paywalls this.</li>
        <li>Balance-sheet history. Available via <code>webservicesp.anaf.ro/bilant</code> — a logical next endpoint to wire in.</li>
      </ul>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────────────────
//  Atoms
// ───────────────────────────────────────────────────────────────────────────
function Field({ label, value, mono, wide }) {
  return (
    <div style={{ ...S.field, ...(wide ? S.fieldWide : {}) }}>
      <div style={S.fieldLabel}>{label}</div>
      <div style={{ ...S.fieldValue, ...(mono ? S.mono : {}) }}>
        {value || value === 0 ? String(value) : "—"}
      </div>
    </div>
  );
}

function Badge({ ok, label }) {
  return (
    <span style={{ ...S.badge, ...(ok ? S.badgeOk : S.badgeBad) }}>
      <span style={S.badgeDot} /> {label}
    </span>
  );
}

function Source({ name, full, endpoint, what }) {
  return (
    <div style={S.source}>
      <div style={S.sourceName}>{name}</div>
      <div style={S.sourceFull}>{full}</div>
      <div style={{ ...S.fieldValue, ...S.mono, marginTop: 6, opacity: 0.7 }}>
        {endpoint}
      </div>
      <p style={S.sourceWhat}>{what}</p>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
//  Styles
// ───────────────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700;1,9..144,400&family=JetBrains+Mono:wght@400;500&family=Manrope:wght@400;500;600;700&display=swap');
  * { box-sizing: border-box; }
  body { margin: 0; }
  button, input, select { font: inherit; }
  button { cursor: pointer; }
  ::selection { background: #fde047; color: #111; }
`;

const PALETTE = {
  bg:      "#fafaf7",
  ink:     "#0f1419",
  paper:   "#ffffff",
  rule:    "#e8e5dc",
  muted:   "#6b6b66",
  accent:  "#ce1126",   // RO red
  accent2: "#002b7f",   // RO blue
  ok:      "#15803d",
  bad:     "#b91c1c",
};

const S = {
  page: {
    minHeight: "100vh",
    background: PALETTE.bg,
    color: PALETTE.ink,
    fontFamily: "'Manrope', system-ui, sans-serif",
    fontSize: 15,
    lineHeight: 1.55,
  },
  header: {
    padding: "40px 48px 0",
    maxWidth: 1200,
    margin: "0 auto",
  },
  brandRow: { display: "flex", gap: 22, alignItems: "flex-start" },
  flag: {
    width: 14, height: 56,
    display: "grid", gridTemplateRows: "1fr 1fr 1fr",
    borderRadius: 2, overflow: "hidden", flexShrink: 0,
    boxShadow: "0 1px 2px rgba(0,0,0,0.08)", marginTop: 8,
  },
  h1: {
    fontFamily: "'Fraunces', serif",
    fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em",
    margin: "0 0 6px", lineHeight: 1.1,
    color: PALETTE.ink,
  },
  tagline: { margin: 0, color: PALETTE.muted, fontSize: 15, maxWidth: 620 },
  tabs: {
    display: "flex", gap: 0,
    marginTop: 32, borderBottom: `1px solid ${PALETTE.rule}`,
  },
  tab: {
    background: "transparent", border: "none",
    padding: "14px 20px",
    fontSize: 14, fontWeight: 500,
    color: PALETTE.muted,
    borderBottom: "2px solid transparent",
    marginBottom: -1,
  },
  tabActive: {
    color: PALETTE.ink,
    borderBottom: `2px solid ${PALETTE.accent}`,
  },
  main: {
    maxWidth: 1200,
    margin: "0 auto",
    padding: "40px 48px 80px",
  },
  h2: {
    fontFamily: "'Fraunces', serif",
    fontSize: 28, fontWeight: 600, letterSpacing: "-0.01em",
    margin: "0 0 8px",
    color: PALETTE.ink,
  },
  h3: {
    fontFamily: "'Fraunces', serif",
    fontSize: 18, fontWeight: 600,
    margin: "32px 0 12px",
    color: PALETTE.ink,
  },
  lead: { color: PALETTE.muted, maxWidth: 720, margin: "0 0 28px" },
  queryBar: {
    display: "flex", gap: 8, marginBottom: 12, alignItems: "stretch",
  },
  input: {
    flex: 1, minWidth: 0,
    padding: "12px 16px",
    background: PALETTE.paper,
    color: PALETTE.ink,
    border: `1px solid ${PALETTE.rule}`,
    borderRadius: 4,
    fontSize: 15,
    fontFamily: "'JetBrains Mono', monospace",
    outline: "none",
  },
  select: {
    padding: "12px 16px",
    background: PALETTE.paper,
    color: PALETTE.ink,
    border: `1px solid ${PALETTE.rule}`,
    borderRadius: 4, fontSize: 14,
  },
  btn: {
    padding: "12px 24px",
    background: PALETTE.ink, color: PALETTE.paper,
    border: "none", borderRadius: 4,
    fontSize: 14, fontWeight: 600,
    letterSpacing: "0.01em",
  },
  exampleRow: {
    display: "flex", flexWrap: "wrap", gap: 6,
    alignItems: "center",
    fontSize: 13, color: PALETTE.muted, marginBottom: 24,
  },
  chip: {
    background: "transparent",
    border: `1px solid ${PALETTE.rule}`,
    borderRadius: 999,
    padding: "4px 12px",
    fontSize: 12,
    color: PALETTE.ink,
    fontFamily: "'JetBrains Mono', monospace",
  },
  error: {
    background: "#fef2f2", color: "#991b1b",
    border: "1px solid #fecaca",
    padding: "12px 16px", borderRadius: 4,
    fontSize: 14, marginBottom: 16,
  },
  empty: { color: PALETTE.muted, padding: 32, textAlign: "center" },
  result: {
    background: PALETTE.paper,
    border: `1px solid ${PALETTE.rule}`,
    borderRadius: 6,
    overflow: "hidden",
  },
  resultHead: {
    padding: "24px 28px",
    borderBottom: `1px solid ${PALETTE.rule}`,
    display: "flex", justifyContent: "space-between",
    gap: 16, flexWrap: "wrap",
  },
  companyName: {
    fontFamily: "'Fraunces', serif",
    fontSize: 24, fontWeight: 600, letterSpacing: "-0.01em",
  },
  companyMeta: {
    color: PALETTE.muted, fontSize: 13, marginTop: 4,
    fontFamily: "'JetBrains Mono', monospace",
  },
  badgeRow: { display: "flex", flexWrap: "wrap", gap: 6 },
  badge: {
    display: "inline-flex", alignItems: "center", gap: 6,
    padding: "4px 10px",
    borderRadius: 999, fontSize: 12, fontWeight: 500,
    border: "1px solid",
  },
  badgeOk:  { background: "#f0fdf4", color: PALETTE.ok, borderColor: "#bbf7d0" },
  badgeBad: { background: "#fef2f2", color: PALETTE.bad, borderColor: "#fecaca" },
  badgeDot: {
    width: 6, height: 6, borderRadius: 999, background: "currentColor",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 0,
  },
  subgrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: 0, marginTop: 12,
  },
  field: {
    padding: "16px 28px",
    borderRight: `1px solid ${PALETTE.rule}`,
    borderBottom: `1px solid ${PALETTE.rule}`,
  },
  fieldWide: { gridColumn: "1 / -1" },
  fieldLabel: {
    fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em",
    color: PALETTE.muted, fontWeight: 600, marginBottom: 4,
  },
  fieldValue: { fontSize: 15, color: PALETTE.ink },
  mono: { fontFamily: "'JetBrains Mono', monospace", fontSize: 13 },
  details: {
    padding: "14px 28px",
    borderTop: `1px solid ${PALETTE.rule}`,
    fontSize: 14,
  },
  pre: {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 12,
    background: "#0f1419", color: "#d1d5db",
    padding: 16, borderRadius: 4, overflow: "auto",
    maxHeight: 400,
  },
  resultsCount: {
    fontSize: 13, color: PALETTE.muted, margin: "8px 0 12px",
    fontFamily: "'JetBrains Mono', monospace",
  },
  tableWrap: {
    background: PALETTE.paper,
    border: `1px solid ${PALETTE.rule}`,
    borderRadius: 6, overflow: "auto",
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: {
    textAlign: "left", padding: "12px 14px",
    fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em",
    color: PALETTE.muted, fontWeight: 600,
    borderBottom: `1px solid ${PALETTE.rule}`,
    background: "#fafaf7", position: "sticky", top: 0,
  },
  td: {
    padding: "12px 14px",
    borderBottom: `1px solid ${PALETTE.rule}`,
    verticalAlign: "top",
  },
  trAlt: { background: "#fafaf7" },
  plan: {
    background: "#fef9c3",
    border: "1px solid #fde68a",
    padding: "12px 16px", borderRadius: 4,
    fontSize: 14, marginBottom: 16,
    display: "flex", justifyContent: "space-between",
    alignItems: "center", gap: 12, flexWrap: "wrap",
  },
  planTag: {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
    background: PALETTE.ink, color: PALETTE.paper,
    padding: "2px 8px", borderRadius: 999,
    textTransform: "uppercase", letterSpacing: "0.06em",
  },
  sources: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
    gap: 16, marginTop: 16,
  },
  source: {
    background: PALETTE.paper,
    border: `1px solid ${PALETTE.rule}`,
    borderRadius: 6, padding: "20px 22px",
  },
  sourceName: {
    fontFamily: "'Fraunces', serif",
    fontSize: 22, fontWeight: 600,
  },
  sourceFull: { fontSize: 13, color: PALETTE.muted },
  sourceWhat: { fontSize: 14, marginTop: 12, marginBottom: 0 },
  bulletList: { fontSize: 14, color: PALETTE.ink, paddingLeft: 20 },
  footer: {
    borderTop: `1px solid ${PALETTE.rule}`,
    padding: "20px 48px",
    maxWidth: 1200, margin: "0 auto",
    display: "flex", justifyContent: "space-between",
    fontSize: 12, color: PALETTE.muted, gap: 16, flexWrap: "wrap",
  },
};
