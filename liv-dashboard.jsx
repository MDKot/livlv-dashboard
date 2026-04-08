import { useState, useEffect, useCallback, useRef } from "react";
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const TC = "#FF5C35", SC = "#7B61FF", UC = "#F0B429", MC = "#00E5C3";
const NC = "#C084FC", BC = "#38BDF8";
const mono = "'Courier New',monospace";
const vc = vt => vt === "beach_club" ? BC : NC;
const vl = vt => vt === "beach_club" ? "LIV Beach" : "LIV Las Vegas";
const $ = n => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n || 0);
const N = n => new Intl.NumberFormat("en-US").format(Math.round(n || 0));
const abbr = n => n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`;
const pct = (a, b) => b > 0 ? Math.min(100, (a / b) * 100) : 0;
const fd = d => { try { const dt = new Date(d + "T12:00:00"); return dt.toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric" }); } catch { return d; } };
const normKey = (name, date) => (name || "").toLowerCase().replace(/[^a-z0-9]/g, "") + "_" + (date || "").replace(/-/g, "");

// ─── VENUE CLASSIFICATION ─────────────────────────────────────────────────────
function classifyVenue(n = "") {
  const l = (n || "").toLowerCase();
  if (l.includes("beach") || l.includes("pool") || l.includes("day")) return "beach_club";
  return "nightclub";
}

// ─── TICKET TYPE LABELS ───────────────────────────────────────────────────────
const TL = { male_ga: "Male GA", female_ga: "Female GA", expedited: "Expedited", vip_backstage: "VIP Backstage" };
const TO = ["male_ga", "female_ga", "expedited", "vip_backstage"];

// ─── TYPE MERGING ─────────────────────────────────────────────────────────────
function mergeTypes(a = {}, b = {}) {
  const out = {};
  [...new Set([...Object.keys(a), ...Object.keys(b)])].forEach(k => {
    out[k] = { sold: (a[k]?.sold || 0) + (b[k]?.sold || 0), revenue: (a[k]?.revenue || 0) + (b[k]?.revenue || 0), price: a[k]?.price || b[k]?.price || 0 };
  });
  return out;
}

// ─── API STUBS (return null when keys not configured) ─────────────────────────
const CFG = {
  tixr:     { base: "https://studio.tixr.com/api/v1",
    lv: { publicKey: "", privateKey: "", groupId: "1841" },
    bc: { publicKey: "", privateKey: "", groupId: "1927" } },
  speakeasy:{ base: "https://production.speakeasygo.com/partners" },
  urvenue:  { base: "https://api.urvenue.com/v1",
    lv: { apiKey: "YOUR_UV_LV_API_KEY",       venueId: "YOUR_UV_LV_VENUE_ID" },
    bc: { apiKey: "YOUR_UV_BC_API_KEY",       venueId: "YOUR_UV_BC_VENUE_ID" } },
  meta: {
    lv: { accessToken: "YOUR_META_LV_ACCESS_TOKEN", adAccountId: "YOUR_META_LV_AD_ACCOUNT_ID" },
    bc: { accessToken: "YOUR_META_BC_ACCESS_TOKEN", adAccountId: "YOUR_META_BC_AD_ACCOUNT_ID" },
  },
};
async function fetchTIXR(c) {
  if (!c.publicKey || !c.privateKey) return null;
  try {
    // TIXR uses HMAC-SHA256: sign publicKey+timestamp with privateKey
    const ts = Math.floor(Date.now() / 1000).toString();
    const encoder = new TextEncoder();
    const keyData = encoder.encode(c.privateKey);
    const msgData = encoder.encode(c.publicKey + ts);
    const cryptoKey = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sigBuf = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
    const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
    const headers = {
      "X-Public-Key": c.publicKey,
      "X-Timestamp": ts,
      "X-Signature": sig,
      "Content-Type": "application/json",
    };
    const url = `${c.base}/groups/${c.groupId}/events?status=active`;
    const d = await (await fetch(url, { headers })).json();
    return (d.events || d.data || []).map(e => ({ ...e, _account: c._account }));
  } catch (err) { console.error("TIXR fetch error:", err); return null; }
}
async function fetchSpeakeasy(c) {
  if (!c.token || c.token.startsWith("YOUR_")) return null;
  const base = "https://production.speakeasygo.com/partners";
  const headers = { "token": c.token };

  // Normalize Speakeasy ticket_name → internal key
  function spkTypeKey(name = "") {
    const n = name.toLowerCase();
    if (n.includes("vip") || n.includes("backstage")) return "vip_backstage";
    if (n.includes("expedited"))                        return "expedited";
    if (n.includes("female"))                           return "female_ga";
    if (n.includes("male"))                             return "male_ga";
    return name.toLowerCase().replace(/[^a-z0-9]/g, "_");
  }

  try {
    // Fetch event list and stats in parallel — paginate stats to get all 144+
    const [evRes, statRes] = await Promise.all([
      fetch(`${base}/events?skip=0&take=200&orderBy=startDateTime%7Casc&version=PUBLISHED&eventStatus=APPROVED&status=ENABLED&timeVersion=UPCOMING&isDiscounted=false`, { headers }),
      fetch(`${base}/events/statistics?skip=0&take=200`, { headers }),
    ]);
    const [evData, statData] = await Promise.all([evRes.json(), statRes.json()]);

    const events = evData.list || evData.data || evData.events || [];
    const stats  = statData.list || statData.data || statData.events || [];

    // Build stats lookup by event_id (e.g. "EVE-6QNGL4")
    const statMap = {};
    stats.forEach(s => {
      if (s.event_id) statMap[s.event_id] = s;
    });

    return events.map(e => {
      // Events endpoint uses id or event_id to match
      const s = statMap[e.id] || statMap[e.event_id] || {};

      // Map ticket_types array → internal object keyed by type
      const ticketTypes = {};
      (s.ticket_types || []).forEach(t => {
        const key = spkTypeKey(t.ticket_name);
        ticketTypes[key] = {
          sold:    t.tickets_sold || 0,
          price:   t.price || 0,
          revenue: t.revenue || 0,
        };
      });

      return {
        id:          `spk_${e.id || e.event_id}`,
        name:        e.title || e.name || e.event_name || "",
        date:        (e.startDateTime || e.start_date || e.date || "").slice(0, 10),
        venueName:   c._account === "bc" ? "LIV Beach" : "LIV Las Vegas",
        venueType:   c._account === "bc" ? "beach_club" : "nightclub",
        capacity:    e.capacity || 0,
        ticketsSold: s.ticket_sold || 0,
        tickets24h:  s.ticket_sold_last_24_hours || 0,
        revenue:     s.total_revenue || 0,
        goal:        0,
        ticketTypes,
        _source:     "speakeasy",
        _account:    c._account,
      };
    });
  } catch (err) { console.error("Speakeasy fetch error:", err); return null; }
}
async function fetchUrVenue(c) {
  if (!c.apiKey || c.apiKey.startsWith("YOUR_")) return null;
  try { const d = await (await fetch(`${c.base}/venues/${c.venueId}/events`, { headers: { Authorization: `Bearer ${c.apiKey}` } })).json(); return d.events || []; } catch { return null; }
}

async function fetchMeta(c) {
  if (!c.accessToken || c.accessToken.startsWith("YOUR_")) return null;
  try {
    const base = `https://graph.facebook.com/v19.0/act_${c.adAccountId}`;
    const fields = "name,status,objective,spend,impressions,reach,clicks,ctr,cpm,cpc,frequency,actions,action_values,purchase_roas";
    const url = `${base}/insights?fields=${fields}&date_preset=this_month&level=campaign&access_token=${c.accessToken}`;
    const d = await (await fetch(url)).json();
    return (d.data || []).map(item => ({ ...item, _account: c._account }));
  } catch (err) { console.error("Meta fetch error:", err); return null; }
}

// ─── MOCK DATA ────────────────────────────────────────────────────────────────
const VIP = new Set(["John Summit", "Dom Dolla", "Metro Boomin", "David Guetta", "SIDEPIECE", "Gorgon City", "Tiesto"]);

function buildPace(avg, days = 30) {
  return Array.from({ length: days }, (_, i) => ({ label: i === days - 1 ? "Today" : `${days - 1 - i}d`, tickets: Math.max(0, Math.round(avg * (0.4 + Math.random() * 1.2))) }));
}
function buildBookPace(total, days = 30) {
  const h = Array(days).fill(0); let r = total;
  for (let i = days - 1; i >= 0 && r > 0; i--) { if (Math.random() > 0.6) { h[i] = Math.min(r, 1 + Math.floor(Math.random() * 2)); r -= h[i]; } }
  return h.map((b, i) => ({ label: i === days - 1 ? "Today" : `${days - 1 - i}d`, booked: b }));
}
function buildTypes(total, rev, hasVIP) {
  if (!total) return {};
  const vS = hasVIP ? Math.round(total * 0.06) : 0, eS = Math.round(total * 0.13), rem = total - vS - eS;
  const mS = Math.round(rem * 0.48), fS = rem - mS, avg = rev / total;
  const t = {
    male_ga:   { sold: mS, price: Math.round(avg * 0.85), revenue: Math.round(mS * avg * 0.85) },
    female_ga: { sold: fS, price: Math.round(avg * 0.75), revenue: Math.round(fS * avg * 0.75) },
    expedited: { sold: eS, price: Math.round(avg * 1.4),  revenue: Math.round(eS * avg * 1.4) },
  };
  if (hasVIP) t.vip_backstage = { sold: vS, price: Math.round(avg * 3.5), revenue: Math.round(vS * avg * 3.5) };
  return t;
}
function lvTbls(p) {
  return [
    { id: `${p}a`, name: "Main Floor Row A", ms: 2000, cap: 14, bkd: Math.floor(7 + Math.random() * 6) },
    { id: `${p}b`, name: "Main Floor Row B", ms: 2000, cap: 10, bkd: Math.floor(4 + Math.random() * 5) },
    { id: `${p}c`, name: "Stage-Side Rail",  ms: 5000, cap: 6,  bkd: Math.floor(2 + Math.random() * 4) },
    { id: `${p}d`, name: "VIP Mezzanine",    ms: 7500, cap: 4,  bkd: Math.floor(1 + Math.random() * 3) },
    { id: `${p}e`, name: "Skybox Suite",     ms: 15000,cap: 2,  bkd: Math.floor(Math.random() * 2) },
  ].map(t => ({ ...t, capacity: t.cap, booked: t.bkd, revenue: t.bkd * t.ms * (0.9 + Math.random() * 0.2), bookingHistory: buildBookPace(t.bkd) }));
}
function bcTbls(p) {
  return [
    { id: `${p}a`, name: "Cabana Row A",      ms: 1500, cap: 18, bkd: Math.floor(9 + Math.random() * 8) },
    { id: `${p}b`, name: "Cabana Row B",      ms: 1500, cap: 14, bkd: Math.floor(6 + Math.random() * 7) },
    { id: `${p}c`, name: "Premium Pool Deck", ms: 3000, cap: 10, bkd: Math.floor(4 + Math.random() * 5) },
    { id: `${p}d`, name: "Infinity Edge VIP", ms: 5000, cap: 6,  bkd: Math.floor(2 + Math.random() * 4) },
    { id: `${p}e`, name: "Daybed Section",    ms: 800,  cap: 24, bkd: Math.floor(12 + Math.random() * 10) },
    { id: `${p}f`, name: "Sunset Terrace",    ms: 8000, cap: 3,  bkd: Math.floor(Math.random() * 3) },
  ].map(t => ({ ...t, capacity: t.cap, booked: t.bkd, revenue: t.bkd * t.ms * (0.85 + Math.random() * 0.25), bookingHistory: buildBookPace(t.bkd) }));
}

const EVENTS = [
  { v: "LIV Las Vegas", n: "Matroda",                  d: "2026-02-27", c: 1800, g: 72000,  tS: 1340, sS: 380,  tR: 52000,  sR: 14500, t24: 48  },
  { v: "LIV Las Vegas", n: "Gorgon City",               d: "2026-02-28", c: 1800, g: 90000,  tS: 1280, sS: 420,  tR: 59000,  sR: 18000, t24: 62  },
  { v: "LIV Las Vegas", n: "Four Color Zack",           d: "2026-03-01", c: 1800, g: 63000,  tS: 890,  sS: 310,  tR: 34000,  sR: 11000, t24: 31  },
  { v: "LIV Las Vegas", n: "Irv G",                     d: "2026-03-05", c: 1800, g: 54000,  tS: 620,  sS: 280,  tR: 22000,  sR: 9500,  t24: 18  },
  { v: "LIV Las Vegas", n: "John Summit",               d: "2026-03-06", c: 1800, g: 108000, tS: 1560, sS: 190,  tR: 82000,  sR: 9000,  t24: 94  },
  { v: "LIV Las Vegas", n: "Knock2",                    d: "2026-03-07", c: 1800, g: 72000,  tS: 980,  sS: 340,  tR: 40000,  sR: 13000, t24: 43  },
  { v: "LIV Las Vegas", n: "Simp City",                 d: "2026-03-08", c: 1800, g: 54000,  tS: 540,  sS: 290,  tR: 19000,  sR: 10000, t24: 22  },
  { v: "LIV Las Vegas", n: "Tiesto",                    d: "2026-03-13", c: 1800, g: 144000, tS: 1720, sS: 60,   tR: 118000, sR: 4000,  t24: 108 },
  { v: "LIV Las Vegas", n: "Dom Dolla",                 d: "2026-03-14", c: 1800, g: 126000, tS: 1640, sS: 110,  tR: 104000, sR: 7000,  t24: 87  },
  { v: "LIV Las Vegas", n: "Beltran B2B Ben Sterling",  d: "2026-03-15", c: 1800, g: 72000,  tS: 760,  sS: 320,  tR: 30000,  sR: 12000, t24: 29  },
  { v: "LIV Las Vegas", n: "Tiesto",                    d: "2026-03-20", c: 1800, g: 144000, tS: 1680, sS: 80,   tR: 115000, sR: 5000,  t24: 91  },
  { v: "LIV Las Vegas", n: "Special Guest",             d: "2026-03-21", c: 1800, g: 90000,  tS: 640,  sS: 290,  tR: 29000,  sR: 11000, t24: 34  },
  { v: "LIV Las Vegas", n: "Kettama",                   d: "2026-03-22", c: 1800, g: 72000,  tS: 820,  sS: 300,  tR: 32000,  sR: 11500, t24: 27  },
  { v: "LIV Las Vegas", n: "Metro Boomin",              d: "2026-03-27", c: 1800, g: 126000, tS: 1480, sS: 240,  tR: 97000,  sR: 14000, t24: 76  },
  { v: "LIV Las Vegas", n: "Disco Dom",                 d: "2026-03-28", c: 1800, g: 72000,  tS: 680,  sS: 310,  tR: 26000,  sR: 12000, t24: 24  },
  { v: "LIV Las Vegas", n: "Eric DLUX",                 d: "2026-03-29", c: 1800, g: 63000,  tS: 590,  sS: 270,  tR: 21000,  sR: 9500,  t24: 19  },
  { v: "LIV Las Vegas", n: "Gorgon City",               d: "2026-04-03", c: 1800, g: 90000,  tS: 410,  sS: 180,  tR: 19000,  sR: 8000,  t24: 38  },
  { v: "LIV Las Vegas", n: "Dombresky",                 d: "2026-04-10", c: 1800, g: 72000,  tS: 320,  sS: 140,  tR: 12000,  sR: 5500,  t24: 22  },
  { v: "LIV Las Vegas", n: "Cloonee",                   d: "2026-04-11", c: 1800, g: 72000,  tS: 300,  sS: 130,  tR: 11500,  sR: 5000,  t24: 17  },
  { v: "LIV Las Vegas", n: "Metro Boomin",              d: "2026-04-17", c: 1800, g: 126000, tS: 290,  sS: 110,  tR: 13500,  sR: 5000,  t24: 31  },
  { v: "LIV Las Vegas", n: "Dom Dolla",                 d: "2026-04-24", c: 1800, g: 126000, tS: 280,  sS: 120,  tR: 13000,  sR: 5500,  t24: 28  },
  { v: "LIV Las Vegas", n: "Prospa",                    d: "2026-04-25", c: 1800, g: 72000,  tS: 190,  sS: 90,   tR: 7500,   sR: 3500,  t24: 11  },
  { v: "LIV Beach",     n: "Cloonee",                   d: "2026-03-07", c: 2200, g: 99000,  tS: 1420, sS: 640,  tR: 61000,  sR: 26000, t24: 71  },
  { v: "LIV Beach",     n: "Shamir Kelly",              d: "2026-03-08", c: 2200, g: 66000,  tS: 840,  sS: 560,  tR: 31000,  sR: 20000, t24: 38  },
  { v: "LIV Beach",     n: "Irv G",                     d: "2026-03-13", c: 2200, g: 77000,  tS: 960,  sS: 580,  tR: 37000,  sR: 22000, t24: 44  },
  { v: "LIV Beach",     n: "SIDEPIECE",                 d: "2026-03-14", c: 2200, g: 110000, tS: 1580, sS: 520,  tR: 71000,  sR: 22000, t24: 82  },
  { v: "LIV Beach",     n: "Kromi",                     d: "2026-03-15", c: 2200, g: 66000,  tS: 640,  sS: 480,  tR: 22000,  sR: 17000, t24: 26  },
  { v: "LIV Beach",     n: "Shamir Kelly",              d: "2026-03-20", c: 2200, g: 66000,  tS: 520,  sS: 410,  tR: 18500,  sR: 14500, t24: 19  },
  { v: "LIV Beach",     n: "Dom Dolla",                 d: "2026-03-21", c: 2200, g: 132000, tS: 1740, sS: 380,  tR: 90000,  sR: 19000, t24: 103 },
  { v: "LIV Beach",     n: "Special Guest",             d: "2026-03-22", c: 2200, g: 88000,  tS: 480,  sS: 360,  tR: 17000,  sR: 13000, t24: 22  },
  { v: "LIV Beach",     n: "Westend",                   d: "2026-03-27", c: 2200, g: 77000,  tS: 420,  sS: 340,  tR: 15000,  sR: 12000, t24: 17  },
  { v: "LIV Beach",     n: "Disco Lines",               d: "2026-03-28", c: 2200, g: 88000,  tS: 390,  sS: 310,  tR: 14000,  sR: 11000, t24: 14  },
  { v: "LIV Beach",     n: "Vice - Sunday Circuit",     d: "2026-03-29", c: 2200, g: 66000,  tS: 340,  sS: 280,  tR: 12000,  sR: 10000, t24: 12  },
  { v: "LIV Beach",     n: "Sam Feldt",                 d: "2026-04-03", c: 2200, g: 88000,  tS: 310,  sS: 250,  tR: 11000,  sR: 9000,  t24: 16  },
  { v: "LIV Beach",     n: "John Summit",               d: "2026-04-04", c: 2200, g: 132000, tS: 420,  sS: 220,  tR: 19000,  sR: 9500,  t24: 51  },
  { v: "LIV Beach",     n: "Sommer Ray",                d: "2026-04-10", c: 2200, g: 77000,  tS: 280,  sS: 240,  tR: 9500,   sR: 8500,  t24: 18  },
  { v: "LIV Beach",     n: "Dom Dolla",                 d: "2026-04-11", c: 2200, g: 132000, tS: 360,  sS: 190,  tR: 16000,  sR: 8000,  t24: 33  },
  { v: "LIV Beach",     n: "Kromi",                     d: "2026-04-12", c: 2200, g: 66000,  tS: 210,  sS: 180,  tR: 7500,   sR: 6500,  t24: 9   },
  { v: "LIV Beach",     n: "David Guetta",              d: "2026-04-18", c: 2200, g: 176000, tS: 390,  sS: 160,  tR: 18000,  sR: 7000,  t24: 42  },
  { v: "LIV Beach",     n: "David Guetta",              d: "2026-04-25", c: 2200, g: 176000, tS: 320,  sS: 140,  tR: 15000,  sR: 6000,  t24: 36  },
];

function buildMock() {
  const tixr = EVENTS.map((e, i) => {
    const vip = VIP.has(e.n);
    return { id: `tixr_${i}`, name: e.n, date: e.d, venueName: e.v, venueType: classifyVenue(e.v), capacity: e.c, ticketsSold: e.tS, tickets24h: Math.round(e.t24 * 0.6), ticketTypes: buildTypes(e.tS, e.tR, vip), revenue: e.tR, goal: e.g * (e.tS / (e.tS + e.sS)), paceHistory: buildPace(e.tS / 45) };
  });
  const spk = EVENTS.map((e, i) => {
    const vip = VIP.has(e.n);
    return { id: `spk_${i}`, name: e.n, date: e.d, venueName: e.v, venueType: classifyVenue(e.v), capacity: e.c, ticketsSold: e.sS, tickets24h: Math.round(e.t24 * 0.4), ticketTypes: buildTypes(e.sS, e.sR, vip), revenue: e.sR, goal: e.g * (e.sS / (e.tS + e.sS)), paceHistory: buildPace(e.sS / 45) };
  });
  const uv = EVENTS.map((e, i) => {
    const beach = classifyVenue(e.v) === "beach_club";
    const tables = beach ? bcTbls(`bc${i}`) : lvTbls(`lv${i}`);
    return { eventName: e.n, venueName: e.v, date: e.d, tables, totalBooked: tables.reduce((s, t) => s + t.booked, 0), totalCapacity: tables.reduce((s, t) => s + t.capacity, 0), totalRevenue: tables.reduce((s, t) => s + t.revenue, 0), totalMinSpend: tables.reduce((s, t) => s + t.minSpend * t.capacity, 0), paceHistory: buildBookPace(tables.reduce((s, t) => s + t.booked, 0)) };
  });
  return { tixr, spk, uv };
}

// ─── AGGREGATION ──────────────────────────────────────────────────────────────
function aggregate(tixr, spk, uv) {
  const map = new Map();
  tixr.forEach(e => {
    const k = normKey(e.name, e.date);
    map.set(k, { ...e, uvData: null });
  });
  spk.forEach(e => {
    const k = normKey(e.name, e.date);
    if (map.has(k)) {
      const ex = map.get(k);
      map.set(k, { ...ex, ticketsSold: ex.ticketsSold + e.ticketsSold, revenue: ex.revenue + e.revenue, goal: ex.goal + e.goal, tickets24h: (ex.tickets24h || 0) + (e.tickets24h || 0), ticketTypes: mergeTypes(ex.ticketTypes, e.ticketTypes) });
    } else {
      map.set(k, { ...e, uvData: null });
    }
  });
  uv.forEach(u => {
    const k = normKey(u.eventName, u.date);
    if (map.has(k)) map.set(k, { ...map.get(k), uvData: u });
  });
  const today = new Date();
  return Array.from(map.values()).map(e => {
    const daysToEvent = Math.ceil((new Date(e.date) - today) / 86400000);
    const daysOnSale = Math.max(1, 90 - daysToEvent);
    const dailyPace = e.ticketsSold / daysOnSale;
    const projSold = Math.min(e.capacity, e.ticketsSold + dailyPace * Math.max(0, daysToEvent));
    return { ...e, daysToEvent, dailyPace, projRevenue: (projSold / e.capacity) * e.goal };
  }).sort((a, b) => new Date(a.date) - new Date(b.date));
}

// ─── ARTIST SUMMARY ───────────────────────────────────────────────────────────
function artistSummary(events, name) {
  const m = events.filter(e => e.name.toLowerCase() === name.toLowerCase());
  if (!m.length) return null;
  return {
    name, eventCount: m.length, events: m,
    venues: [...new Set(m.map(e => e.venueName))],
    totalSold: m.reduce((s, e) => s + e.ticketsSold, 0),
    totalCap: m.reduce((s, e) => s + e.capacity, 0),
    totalRevenue: m.reduce((s, e) => s + e.revenue, 0),
    totalGoal: m.reduce((s, e) => s + e.goal, 0),
    total24h: m.reduce((s, e) => s + (e.tickets24h || 0), 0),
    totalUvRev: m.reduce((s, e) => s + (e.uvData?.totalRevenue || 0), 0),
    totalUvBooked: m.reduce((s, e) => s + (e.uvData?.totalBooked || 0), 0),
    totalUvCap: m.reduce((s, e) => s + (e.uvData?.totalCapacity || 0), 0),
  };
}

// ─── UI ATOMS ─────────────────────────────────────────────────────────────────
function KPI({ label, value, sub, color, glow, sm }) {
  return (
    <div style={{ padding: sm ? "12px 14px" : "16px 18px", background: "#141418", border: "1px solid #242428", borderRadius: 10, position: "relative", overflow: "hidden" }}>
      {glow && <div style={{ position: "absolute", top: -20, right: -20, width: 80, height: 80, borderRadius: "50%", background: color || MC, opacity: .08, filter: "blur(20px)" }} />}
      <div style={{ fontSize: 9, letterSpacing: "0.14em", color: "#555", fontFamily: mono, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: sm ? 16 : 22, fontWeight: 700, color: color || "#fff", letterSpacing: "-0.02em", lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "#444", fontFamily: mono, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}
function PBar({ label, val, max, color, sub, striped }) {
  const p = pct(val, max), c = p < 40 ? "#ff4d4d" : p < 70 ? "#ffaa00" : color;
  return (
    <div style={{ marginBottom: 11 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: "#888" }}>{label}</span>
        <span style={{ fontSize: 10, color: c, fontFamily: mono }}>{p.toFixed(1)}%</span>
      </div>
      <div style={{ height: 4, background: "rgba(255,255,255,.05)", borderRadius: 999, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${p}%`, background: c, borderRadius: 999, opacity: striped ? .65 : 1, backgroundImage: striped ? `repeating-linear-gradient(90deg,${c} 0,${c} 8px,transparent 8px,transparent 14px)` : undefined, transition: "width 1.2s" }} />
      </div>
      {sub && <div style={{ fontSize: 10, color: "#444", fontFamily: mono, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}
function SBar({ a, b, total, ca = MC, cb = UC, h = 4 }) {
  return (
    <div style={{ height: h, background: "rgba(255,255,255,.05)", borderRadius: 999, overflow: "hidden", display: "flex" }}>
      <div style={{ height: "100%", width: `${pct(a, total)}%`, background: ca, transition: "width 1s" }} />
      <div style={{ height: "100%", width: `${pct(b, total)}%`, background: cb, transition: "width 1s" }} />
    </div>
  );
}
function Tip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#0a0a0c", border: "1px solid #1e1e1e", padding: "8px 12px", borderRadius: 7, fontFamily: mono, fontSize: 11 }}>
      <div style={{ color: "#555", marginBottom: 4 }}>{label}</div>
      {payload.map(p => <div key={p.dataKey} style={{ color: p.color || "#ccc" }}>{p.dataKey}: {N(p.value)}</div>)}
    </div>
  );
}
function VPill({ vt }) {
  const c = vc(vt);
  return <span style={{ fontSize: 9, padding: "2px 6px", background: `${c}18`, color: c, border: `1px solid ${c}44`, borderRadius: 99, fontFamily: mono, fontWeight: 700, whiteSpace: "nowrap" }}>{vl(vt)}</span>;
}
function Delta({ n }) {
  if (!n) return null;
  return <span style={{ fontSize: 9, padding: "2px 6px", background: "rgba(0,229,195,.1)", color: MC, border: `1px solid ${MC}33`, borderRadius: 99, fontFamily: mono, fontWeight: 700, whiteSpace: "nowrap" }}>+{N(n)} today</span>;
}
function VBtn({ label, sub, active, count, accent, onClick }) {
  return (
    <button onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", flex: 1, background: active ? `${accent}12` : "rgba(255,255,255,.025)", border: `1px solid ${active ? accent + "55" : "rgba(255,255,255,.06)"}`, borderRadius: 10, cursor: "pointer", transition: "all .2s", justifyContent: "center" }}>
      <div style={{ textAlign: "left" }}>
        <div style={{ fontFamily: mono, fontSize: 11, fontWeight: 700, color: active ? accent : "#666" }}>{label}</div>
        {sub && <div style={{ fontSize: 9, color: active ? `${accent}99` : "#333", fontFamily: mono }}>{sub}</div>}
      </div>
      <span style={{ marginLeft: "auto", padding: "2px 7px", background: active ? `${accent}25` : "rgba(255,255,255,.04)", borderRadius: 99, fontSize: 10, color: active ? accent : "#444", fontFamily: mono }}>{count}</span>
    </button>
  );
}

// ─── ARTIST PANEL ─────────────────────────────────────────────────────────────
function ArtistPanel({ summary }) {
  const { name, eventCount, totalSold, totalCap, totalRevenue, totalGoal, total24h, totalUvRev, totalUvBooked, totalUvCap, venues, events: evts } = summary;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ padding: "16px 20px", background: "#141418", border: "1px solid #242428", borderRadius: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <h2 style={{ fontSize: 19, fontWeight: 700 }}>{name}</h2>
              <span style={{ fontSize: 9, padding: "2px 8px", background: "rgba(0,229,195,.1)", color: MC, border: `1px solid ${MC}33`, borderRadius: 99, fontFamily: mono, fontWeight: 700 }}>ARTIST VIEW</span>
            </div>
            <div style={{ fontSize: 10, color: "#555", fontFamily: mono }}>{eventCount} events — {venues.join(", ")}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: MC }}>{$(totalRevenue)}</div>
            <div style={{ fontSize: 10, color: "#444", fontFamily: mono }}>{pct(totalRevenue, totalGoal).toFixed(1)}% of goal</div>
            {totalUvRev > 0 && <div style={{ fontSize: 12, fontWeight: 600, color: UC, marginTop: 2 }}>{$(totalUvRev)} <span style={{ fontSize: 10, fontWeight: 400, color: "#444" }}>tables</span></div>}
          </div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
        <KPI sm label="Total Sold" value={N(totalSold)} sub={`${N(totalCap - totalSold)} left`} />
        <KPI sm label="Last 24h" value={`+${N(total24h)}`} color={MC} sub="across all dates" />
        <KPI sm label="Revenue" value={$(totalRevenue)} sub={`${pct(totalRevenue, totalGoal).toFixed(0)}% of goal`} color={MC} />
        {totalUvBooked > 0
          ? <KPI sm label="VIP Tables" value={`${totalUvBooked}/${totalUvCap}`} sub={$(totalUvRev)} color={UC} />
          : <KPI sm label="Sellthrough" value={`${pct(totalSold, totalCap).toFixed(0)}%`} sub={`${N(totalSold)}/${N(totalCap)}`} color={MC} />}
      </div>
      <div style={{ padding: "16px 20px", background: "#141418", border: "1px solid #242428", borderRadius: 10 }}>
        <div style={{ fontSize: 9, letterSpacing: "0.14em", color: "#444", fontFamily: mono, textTransform: "uppercase", marginBottom: 12 }}>All Dates</div>
        {evts.map(e => {
          const p = pct(e.ticketsSold, e.capacity), c = vc(e.venueType);
          return (
            <div key={e.id} style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 12, alignItems: "center", padding: "9px 0", borderBottom: "1px solid rgba(255,255,255,.04)" }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <VPill vt={e.venueType} />
                  <span style={{ fontSize: 9, color: "#555", fontFamily: mono }}>{fd(e.date)}</span>
                  {e.tickets24h > 0 && <Delta n={e.tickets24h} />}
                </div>
                <div style={{ height: 3, background: "rgba(255,255,255,.05)", borderRadius: 999, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${p}%`, background: c, borderRadius: 999 }} />
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{N(e.ticketsSold)}</div>
                <div style={{ fontSize: 9, color: "#444", fontFamily: mono }}>sold</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{$(e.revenue)}</div>
                <div style={{ fontSize: 9, color: "#444", fontFamily: mono }}>rev</div>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ padding: "16px 20px", background: "#141418", border: "1px solid #242428", borderRadius: 10 }}>
        <div style={{ fontSize: 9, letterSpacing: "0.14em", color: "#444", fontFamily: mono, textTransform: "uppercase", marginBottom: 12 }}>Combined Pacing</div>
        <PBar label="Sellthrough" val={totalSold} max={totalCap} color={MC} sub={`${N(totalSold)} / ${N(totalCap)}`} />
        <PBar label="Revenue vs Goal" val={totalRevenue} max={totalGoal} color={MC} sub={`${$(totalRevenue)} / ${$(totalGoal)}`} />
        {totalUvBooked > 0 && <PBar label="VIP Table Fill" val={totalUvBooked} max={totalUvCap} color={UC} sub={`${totalUvBooked}/${totalUvCap} — ${$(totalUvRev)}`} />}
      </div>
    </div>
  );
}

// ─── MAIN DASHBOARD ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const [allEvents, setAllEvents] = useState([]);
  const [sel, setSel] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastSync, setLastSync] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [showCfg, setShowCfg] = useState(false);
  const [isMock, setIsMock] = useState(true);
  const [tab, setTab] = useState("overview");
  const [venueFilter, setVenueFilter] = useState("all");
  const [artistFilter, setArtistFilter] = useState(null);
  const [artistSearch, setArtistSearch] = useState("");
  const [focusTblId, setFocusTblId] = useState(null);
  const [expanded, setExpanded] = useState({});

  // TIXR
  const [tixrLvPub,  setTixrLvPub]  = useState("j1cgewh8xvLxiE8xG5jb");
  const [tixrLvPriv, setTixrLvPriv] = useState("JrKfkPOuVOV7QABgNSRo");
  const [tixrLvGrp,  setTixrLvGrp]  = useState(CFG.tixr.lv.groupId);
  const [tixrBcPub,  setTixrBcPub]  = useState("Y7wbU4DGbGkxm3ZHsUEx");
  const [tixrBcPriv, setTixrBcPriv] = useState("zfdqsGmBOM815cmKPyYK");
  const [tixrBcGrp,  setTixrBcGrp]  = useState(CFG.tixr.bc.groupId);
  // Speakeasy
  const [spkLvToken, setSpkLvToken] = useState("9QRm0GFvcZ3GjGUzdlpJCP9vEtB/51xMGPiRV5V1ldFIPJDWe75UP3M9MR80+5ps0Z1kuHmEGzxNyTwZIzFjJkg0PxPZrWCKTJeNuSuONcyMk6b2zjU6WwdMqSbIRRuey750CZzjyYbh0bDOcxwnyw==");
  const [spkBcToken, setSpkBcToken] = useState("9QRm0GFvcZ3GjGUzdlpJCP9vEtB/51xMGPiRV5V1ldFIPJDWe75UP3M9MR80+5psbnKfbZ3pjdt8RwQ2zqHh7L6UsnDquR5aMF+ZedUuYwAnGIlHWYvFtGTdwp11Amm/M0fX1ELGh6/Y7x3Tp2duQw==");
  // UrVenue
  const [uvLvKey,    setUvLvKey]    = useState(CFG.urvenue.lv.apiKey);
  const [uvLvId,     setUvLvId]     = useState(CFG.urvenue.lv.venueId);
  const [uvBcKey,    setUvBcKey]    = useState(CFG.urvenue.bc.apiKey);
  const [uvBcId,     setUvBcId]     = useState(CFG.urvenue.bc.venueId);
  // Meta
  const [metaLvToken, setMetaLvToken] = useState(CFG.meta.lv.accessToken);
  const [metaLvAcct,  setMetaLvAcct]  = useState(CFG.meta.lv.adAccountId);
  const [metaBcToken, setMetaBcToken] = useState(CFG.meta.bc.accessToken);
  const [metaBcAcct,  setMetaBcAcct]  = useState(CFG.meta.bc.adAccountId);
  const [metaCampaigns, setMetaCampaigns] = useState([]);
  const timer = useRef(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); else setSyncing(true);
    try {
      const base = { tixr: CFG.tixr.base, uv: CFG.urvenue.base };
      const [trLv, trBc, srLv, srBc, urLv, urBc, mtLv, mtBc] = await Promise.all([
        fetchTIXR({ base: base.tixr, publicKey: tixrLvPub, privateKey: tixrLvPriv, groupId: tixrLvGrp, _account: "lv" }),
        fetchTIXR({ base: base.tixr, publicKey: tixrBcPub, privateKey: tixrBcPriv, groupId: tixrBcGrp, _account: "bc" }),
        fetchSpeakeasy({ token: spkLvToken, _account: "lv" }),
        fetchSpeakeasy({ token: spkBcToken, _account: "bc" }),
        fetchUrVenue({ base: base.uv, apiKey: uvLvKey, venueId: uvLvId, _account: "lv" }),
        fetchUrVenue({ base: base.uv, apiKey: uvBcKey, venueId: uvBcId, _account: "bc" }),
        fetchMeta({ accessToken: metaLvToken, adAccountId: metaLvAcct, _account: "lv" }),
        fetchMeta({ accessToken: metaBcToken, adAccountId: metaBcAcct, _account: "bc" }),
      ]);
      const mt = [...(mtLv || []), ...(mtBc || [])];
      setMetaCampaigns(mt);
      const tr = [...(trLv || []), ...(trBc || [])];
      const sr = [...(srLv || []), ...(srBc || [])];
      const ur = [...(urLv || []), ...(urBc || [])];
      const anyLive = tr.length > 0 || sr.length > 0 || ur.length > 0;
      setIsMock(!anyLive);
      // Only fall back to mock when ALL platforms fail — never mix real + mock data
      const mock = anyLive ? null : buildMock();
      const agg = aggregate(
        anyLive ? tr : mock.tixr,
        anyLive ? sr : mock.spk,
        anyLive ? ur : mock.uv,
      );
      setAllEvents(agg);
      setSel(prev => agg.find(e => e.id === prev?.id) || agg[0] || null);
      setLastSync(new Date());
    } catch (err) {
      console.error("load error", err);
      // Only show mock on total failure — show empty state if some platforms responded
      const mock = buildMock();
      const agg = aggregate(mock.tixr, mock.spk, mock.uv);
      setAllEvents(agg);
      setSel(agg[0] || null);
      setIsMock(true);
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  }, [tixrLvPub, tixrLvPriv, tixrLvGrp, tixrBcPub, tixrBcPriv, tixrBcGrp, spkLvToken, spkBcToken, uvLvKey, uvLvId, uvBcKey, uvBcId, metaLvToken, metaLvAcct, metaBcToken, metaBcAcct]);

  useEffect(() => { load(); }, []);
  useEffect(() => {
    clearInterval(timer.current);
    timer.current = setInterval(() => load(true), 30000);
    return () => clearInterval(timer.current);
  }, [load]);
  useEffect(() => { setFocusTblId(null); }, [sel?.id]);

  // ── DERIVED ──
  const upcomingEvents = allEvents.filter(e => e.daysToEvent >= -1); // drop day after event
  const pastEvents     = allEvents.filter(e => e.daysToEvent < -1).slice().reverse(); // most recent first

  const viewingPast = venueFilter === "past";
  const baseEvents  = viewingPast ? pastEvents : upcomingEvents;

  const visible = baseEvents.filter(e => {
    if (artistFilter) return e.name.toLowerCase() === artistFilter.toLowerCase();
    if (viewingPast) return true;
    return venueFilter === "all" || e.venueType === venueFilter;
  });

  const allArtists = Array.from(
    upcomingEvents.reduce((m, e) => {
      const k = e.name.toLowerCase();
      m.set(k, { name: e.name, count: (m.get(k)?.count || 0) + 1, sold: (m.get(k)?.sold || 0) + e.ticketsSold });
      return m;
    }, new Map()).values()
  ).sort((a, b) => b.sold - a.sold);
  const filteredArtists = artistSearch ? allArtists.filter(a => a.name.toLowerCase().includes(artistSearch.toLowerCase())) : allArtists;

  const totRev  = visible.reduce((s, e) => s + e.revenue, 0);
  const totGoal = visible.reduce((s, e) => s + e.goal, 0);
  const totSold = visible.reduce((s, e) => s + e.ticketsSold, 0);
  const totCap  = visible.reduce((s, e) => s + e.capacity, 0);
  const tot24h  = visible.reduce((s, e) => s + (e.tickets24h || 0), 0);
  const uvRev   = visible.reduce((s, e) => s + (e.uvData?.totalRevenue || 0), 0);
  const uvBkd   = visible.reduce((s, e) => s + (e.uvData?.totalBooked || 0), 0);
  const uvCap   = visible.reduce((s, e) => s + (e.uvData?.totalCapacity || 0), 0);
  const ncCount = upcomingEvents.filter(e => e.venueType === "nightclub").length;
  const bcCount = upcomingEvents.filter(e => e.venueType === "beach_club").length;

  const ev = (sel && visible.find(e => e.id === sel.id)) ? sel : (viewingPast ? null : visible[0] || null);
  const uvd = ev?.uvData || null;
  const focusTbl = focusTblId ? uvd?.tables?.find(t => t.id === focusTblId) : uvd?.tables?.[0];
  const accent = artistFilter ? MC : venueFilter === "nightclub" ? NC : venueFilter === "beach_club" ? BC : MC;
  const artSum = artistFilter ? artistSummary(allEvents, artistFilter) : null;
  const toggleExpand = (key, e) => { e.stopPropagation(); setExpanded(p => ({ ...p, [key]: !p[key] })); };

  return (
    <div style={{ minHeight: "100vh", background: "#07070a", color: "#d8d8e0", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      <style>{`
        * { box-sizing: border-box; }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        @keyframes spin { to { transform: rotate(360deg); } }
        .hov:hover { background: rgba(255,255,255,.05) !important; }
        .trow:hover { background: rgba(240,180,41,.04) !important; border-color: rgba(240,180,41,.2) !important; }
        .chip:hover { border-color: rgba(255,255,255,.15) !important; color: #aaa !important; }
        .tktbox:hover { filter: brightness(1.15); }
        ::-webkit-scrollbar { width: 3px; } ::-webkit-scrollbar-thumb { background: #1e1e1e; border-radius: 4px; }
      `}</style>

      {/* HEADER */}
      <header style={{ height: 52, borderBottom: "1px solid #111", padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, background: "#07070a", zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", gap: 3 }}>
            {[TC, SC, UC].map(c => <div key={c} style={{ width: 7, height: 7, borderRadius: 2, background: c }} />)}
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, letterSpacing: "-0.02em" }}>LIV Nightclub & Beach</div>
            <div style={{ fontSize: 9, color: "#333", fontFamily: mono, letterSpacing: "0.08em" }}>TIXR · SPEAKEASY · URVENUE</div>
          </div>
          {isMock && <span style={{ fontSize: 9, padding: "2px 7px", background: "rgba(255,200,0,.08)", color: "#ffc000", border: "1px solid rgba(255,200,0,.2)", borderRadius: 99, fontFamily: mono }}>DEMO DATA</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {lastSync && <span style={{ fontSize: 10, color: "#2a2a2a", fontFamily: mono }}>{syncing ? "↻ syncing…" : `synced ${lastSync.toLocaleTimeString()}`}</span>}
          <button onClick={() => setShowCfg(c => !c)} style={{ padding: "5px 11px", fontSize: 10, background: "transparent", border: "1px solid #1e1e1e", color: "#555", borderRadius: 6, cursor: "pointer", fontFamily: mono }}>⚙ config</button>
          <button onClick={() => load(true)} style={{ padding: "5px 11px", fontSize: 10, background: `${accent}0f`, border: `1px solid ${accent}33`, color: accent, borderRadius: 6, cursor: "pointer", fontFamily: mono }}>↻ refresh</button>
        </div>
      </header>

      {/* CONFIG PANEL */}
      {showCfg && (
        <div style={{ background: "#0a0a0c", borderBottom: "1px solid #111", padding: "16px 24px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 24, maxWidth: 960 }}>
            {[
              { label: "TIXR", color: TC,
                lv: [[tixrLvPub, setTixrLvPub, "LIV Las Vegas — Public Key"], [tixrLvPriv, setTixrLvPriv, "LIV Las Vegas — Private Key"], [tixrLvGrp, setTixrLvGrp, "LIV Las Vegas — Group ID"]],
                bc: [[tixrBcPub, setTixrBcPub, "LIV Beach — Public Key"],     [tixrBcPriv, setTixrBcPriv, "LIV Beach — Private Key"],     [tixrBcGrp, setTixrBcGrp, "LIV Beach — Group ID"]] },
              { label: "SPEAKEASY", color: SC,
                lv: [[spkLvToken, setSpkLvToken, "LIV Las Vegas — Token"]],
                bc: [[spkBcToken, setSpkBcToken, "LIV Beach — Token"]] },
              { label: "URVENUE", color: UC,
                lv: [[uvLvKey, setUvLvKey, "LIV Las Vegas — API Key"],     [uvLvId, setUvLvId, "LIV Las Vegas — Venue ID"]],
                bc: [[uvBcKey, setUvBcKey, "LIV Beach — API Key"],         [uvBcId, setUvBcId, "LIV Beach — Venue ID"]] },
            ].map(({ label, color, lv, bc }) => (
              <div key={label}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                  <div style={{ width: 7, height: 7, borderRadius: 2, background: color }} />
                  <span style={{ fontSize: 10, fontFamily: mono, color: "#888", letterSpacing: "0.1em", fontWeight: 700 }}>{label}</span>
                </div>
                {/* LIV Las Vegas */}
                <div style={{ fontSize: 9, color: NC, fontFamily: mono, letterSpacing: "0.08em", marginBottom: 5, textTransform: "uppercase" }}>● LIV Las Vegas</div>
                {lv.map(([val, set, ph]) => (
                  <input key={ph} value={val} onChange={e => set(e.target.value)} placeholder={ph}
                    style={{ display: "block", width: "100%", padding: "6px 10px", background: "#0f0f11", border: "1px solid #1a1a1e", borderRadius: 6, color: "#aaa", fontSize: 11, fontFamily: mono, marginBottom: 5, outline: "none" }} />
                ))}
                {/* LIV Beach */}
                <div style={{ fontSize: 9, color: BC, fontFamily: mono, letterSpacing: "0.08em", marginBottom: 5, marginTop: 6, textTransform: "uppercase" }}>● LIV Beach</div>
                {bc.map(([val, set, ph]) => (
                  <input key={ph} value={val} onChange={e => set(e.target.value)} placeholder={ph}
                    style={{ display: "block", width: "100%", padding: "6px 10px", background: "#0f0f11", border: "1px solid #1a1a1e", borderRadius: 6, color: "#aaa", fontSize: 11, fontFamily: mono, marginBottom: 5, outline: "none" }} />
                ))}
              </div>
            ))}
          </div>
          {/* META ADS */}
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid #1a1a1e" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
              <div style={{ width: 7, height: 7, borderRadius: 2, background: "#1877F2" }} />
              <span style={{ fontSize: 10, fontFamily: mono, color: "#888", letterSpacing: "0.1em", fontWeight: 700 }}>META ADS</span>
              <span style={{ fontSize: 9, color: "#555", fontFamily: mono, marginLeft: 4 }}>optional — for campaign analytics per event</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              {[
                { venue: "LIV Las Vegas", col: NC, fields: [[metaLvToken, setMetaLvToken, "Access Token"], [metaLvAcct, setMetaLvAcct, "Ad Account ID"]] },
                { venue: "LIV Beach",     col: BC, fields: [[metaBcToken, setMetaBcToken, "Access Token"], [metaBcAcct, setMetaBcAcct, "Ad Account ID"]] },
              ].map(({ venue, col, fields }) => (
                <div key={venue}>
                  <div style={{ fontSize: 9, color: col, fontFamily: mono, letterSpacing: "0.08em", marginBottom: 6, textTransform: "uppercase" }}>● {venue}</div>
                  {fields.map(([val, set, ph]) => (
                    <input key={ph} value={val} onChange={e => set(e.target.value)} placeholder={ph}
                      style={{ display: "block", width: "100%", padding: "6px 10px", background: "#0f0f11", border: "1px solid #1a1a1e", borderRadius: 6, color: "#aaa", fontSize: 11, fontFamily: mono, marginBottom: 5, outline: "none" }} />
                  ))}
                </div>
              ))}
            </div>
          </div>
          <button onClick={() => { load(); setShowCfg(false); }} style={{ marginTop: 12, padding: "7px 16px", background: MC, color: "#000", fontWeight: 700, border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12 }}>Connect & Refresh</button>
        </div>
      )}

      {/* LOADING */}
      {loading ? (
        <div style={{ height: "70vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14 }}>
          <div style={{ width: 26, height: 26, border: "2px solid #1a1a1e", borderTopColor: MC, borderRadius: "50%", animation: "spin .7s linear infinite" }} />
          <span style={{ fontSize: 11, color: "#333", fontFamily: mono }}>Loading events…</span>
        </div>
      ) : (
        <div style={{ padding: "16px 24px", animation: "fadeUp .4s ease" }}>

          {/* ARTIST FILTER BAR */}
          <div style={{ marginBottom: 12, background: "#0e0e12", border: "1px solid #1a1a1e", borderRadius: 10, padding: "10px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 9, color: "#444", fontFamily: mono, letterSpacing: "0.12em", textTransform: "uppercase", flexShrink: 0 }}>Artist</span>
              <input value={artistSearch} onChange={e => setArtistSearch(e.target.value)} placeholder="Search…"
                style={{ padding: "4px 9px", background: "#111116", border: "1px solid #1e1e22", borderRadius: 6, color: "#aaa", fontSize: 11, fontFamily: mono, width: 140, outline: "none" }} />
              {artistFilter && (
                <button onClick={() => { setArtistFilter(null); setArtistSearch(""); }}
                  style={{ padding: "3px 9px", fontSize: 10, background: `${MC}15`, border: `1px solid ${MC}44`, color: MC, borderRadius: 6, cursor: "pointer", fontFamily: mono, fontWeight: 700 }}>✕ Clear</button>
              )}
            </div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", maxHeight: 62, overflowY: "auto" }}>
              {filteredArtists.map(a => {
                const active = artistFilter === a.name;
                return (
                  <button key={a.name} className="chip"
                    onClick={() => { setArtistFilter(active ? null : a.name); setArtistSearch(""); setSel(null); }}
                    style={{ padding: "3px 9px", fontSize: 10, background: active ? `${MC}18` : "rgba(255,255,255,.03)", border: `1px solid ${active ? MC + "66" : "rgba(255,255,255,.07)"}`, color: active ? MC : "#666", borderRadius: 99, cursor: "pointer", fontFamily: mono, whiteSpace: "nowrap", transition: "all .12s" }}>
                    {a.name}{a.count > 1 && <span style={{ marginLeft: 4, fontSize: 9, opacity: .6 }}>×{a.count}</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* VENUE FILTER */}
          {!artistFilter && (
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <VBtn label="All Venues" sub={`${upcomingEvents.length} upcoming`} active={venueFilter === "all"} count={upcomingEvents.length} accent={MC} onClick={() => { setVenueFilter("all"); setSel(null); }} />
              <VBtn label="LIV Las Vegas" sub="Nightclub · 10:30pm" active={venueFilter === "nightclub"} count={ncCount} accent={NC} onClick={() => { setVenueFilter("nightclub"); setSel(null); }} />
              <VBtn label="LIV Beach" sub="Daylife · 11:30am" active={venueFilter === "beach_club"} count={bcCount} accent={BC} onClick={() => { setVenueFilter("beach_club"); setSel(null); }} />
              <VBtn label="Past Events" sub={`${pastEvents.length} completed`} active={venueFilter === "past"} count={pastEvents.length} accent="#555" onClick={() => { setVenueFilter("past"); setSel(null); }} />
            </div>
          )}

          {/* KPI STRIP */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 8, marginBottom: 16 }}>
            {/* Total combined revenue */}
            <KPI label={viewingPast ? "Past Total Revenue" : "Total Revenue"} value={$(totRev + uvRev)} sub={viewingPast ? `${visible.length} events` : `of ${$(totGoal)} — ${pct(totRev+uvRev, totGoal).toFixed(0)}%`} color={viewingPast ? "#555" : accent} glow />
            {/* Ticket revenue only */}
            <KPI label="Ticket Revenue" value={$(totRev)} sub={`${N(totSold)} sold · ${N(totCap - totSold)} left`} color={MC} />
            {/* Table min-spend only */}
            <KPI label="Table Min-Spend" value={$(uvRev)} sub={`${uvBkd} of ${uvCap} tables booked`} color={UC} />
            {/* 24h velocity */}
            <KPI label="Last 24h" value={`+${N(tot24h)}`} sub="new tickets" color={tot24h > 0 ? MC : "#555"} />
            {/* Revenue split bar */}
            <div style={{ padding: "14px 16px", background: "#141418", border: "1px solid #242428", borderRadius: 10 }}>
              <div style={{ fontSize: 9, letterSpacing: "0.12em", color: "#555", fontFamily: mono, textTransform: "uppercase", marginBottom: 8 }}>Revenue Split</div>
              <SBar a={totRev} b={uvRev} total={totRev + uvRev} h={5} />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
                <div>
                  <div style={{ fontSize: 9, color: MC, fontFamily: mono, letterSpacing: "0.06em" }}>TICKETS</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: MC }}>{abbr(totRev)}</div>
                  <div style={{ fontSize: 9, color: "#444", fontFamily: mono }}>{pct(totRev, totRev+uvRev).toFixed(0)}%</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 9, color: UC, fontFamily: mono, letterSpacing: "0.06em" }}>TABLE MIN-SPEND</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: UC }}>{abbr(uvRev)}</div>
                  <div style={{ fontSize: 9, color: "#444", fontFamily: mono }}>{pct(uvRev, totRev+uvRev).toFixed(0)}%</div>
                </div>
              </div>
            </div>
          </div>

          {/* MAIN GRID */}
          <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 12, alignItems: "start" }}>

            {/* EVENT LIST */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "600px", overflowY: "auto", paddingRight: 4 }}>
              {visible.length === 0 && (
                <div style={{ padding: 20, textAlign: "center", color: "#aaa", fontFamily: mono, fontSize: 12, background: "#1a1a1e", borderRadius: 10, border: "1px solid #333" }}>No events match.</div>
              )}
              {visible.map(e => {
                const isSel = !artistFilter && ev?.id === e.id;
                const col = vc(e.venueType);
                const tk = normKey(e.name, e.date);
                const isExp = !!expanded[tk];
                const types = e.ticketTypes || {};
                const hasTypes = Object.keys(types).length > 0;
                // Tile computed values (hoisted from inline IIFE)
                const pctSold = e.capacity > 0 ? Math.round((e.ticketsSold / e.capacity) * 100) : 0;
                const maleSold = ["male_ga","vip_backstage","expedited"].reduce((s,k) => s + (types[k]?.sold || 0), 0);
                const femaleSold = types.female_ga?.sold || 0;
                const ratioTotal = maleSold + femaleSold;
                const mPct = ratioTotal > 0 ? Math.round((maleSold / ratioTotal) * 100) : 50;
                const fPct = 100 - mPct;
                const daysLabel = e.daysToEvent > 20 ? `${Math.round(e.daysToEvent/7)}w` : e.daysToEvent > 0 ? `${e.daysToEvent}d` : e.daysToEvent === 0 ? "Tonight" : `${Math.abs(e.daysToEvent)}d ago`;
                return (
                  <div key={e.id} style={{ borderRadius: 12, border: `2px solid ${isSel ? col : "#333"}`, background: isSel ? "#1e1e28" : "#141418", cursor: "pointer" }}
                    onClick={() => { if (!artistFilter) { setSel(e); setTab("overview"); } }}>

                    <div style={{ paddingTop: 14, paddingBottom: 14, paddingLeft: 18, paddingRight: 18 }}>
                          {/* Top row: venue bar + name + days + % sold */}
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                            <div style={{ width: 20, height: 4, background: col, borderRadius: 999, flexShrink: 0 }} />
                            <div style={{ fontSize: 9, color: col, fontFamily: mono, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", flex: 1 }}>{vl(e.venueType)}</div>
                            <div style={{ fontSize: 10, color: "#555", fontFamily: mono }}>{daysLabel}</div>
                            <div style={{ fontSize: 10, fontWeight: 700, color: pctSold >= 75 ? MC : pctSold >= 40 ? "#ffaa00" : "#888", fontFamily: mono }}>{pctSold}% sold</div>
                          </div>

                          {/* Artist name */}
                          <div style={{ fontSize: 17, fontWeight: 800, color: "#ffffff", marginBottom: 3, lineHeight: 1.2, letterSpacing: "-0.01em" }}>{e.name}</div>

                          {/* Date */}
                          <div style={{ fontSize: 12, color: "#777", marginBottom: 12, fontFamily: mono }}>{fd(e.date)}</div>

                          {/* Stats grid */}
                          <div style={{ display: "grid", gridTemplateColumns: e.uvData ? "1fr 1fr 1fr" : "1fr 1fr", gap: 10, marginBottom: 12 }}>
                            {/* Tickets sold */}
                            <div onClick={hasTypes ? (ev2 => { ev2.stopPropagation(); setExpanded(p => ({...p, [tk]: !p[tk]})); }) : undefined}
                              style={{ cursor: hasTypes ? "pointer" : "default" }}>
                              <div style={{ fontSize: 9, color: "#666", fontFamily: mono, letterSpacing: "0.08em", marginBottom: 4 }}>TICKETS SOLD {hasTypes && <span style={{ color: isExp ? col : "#555" }}>{isExp ? "▲" : "▼"}</span>}</div>
                              <div style={{ fontSize: 19, fontWeight: 800, color: col, letterSpacing: "-0.02em", lineHeight: 1 }}>{N(e.ticketsSold)}</div>
                              <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>{abbr(e.revenue)} rev.</div>
                            </div>
                            {/* Table min-spend */}
                            {e.uvData && (
                              <div>
                                <div style={{ fontSize: 9, color: "#666", fontFamily: mono, letterSpacing: "0.08em", marginBottom: 4 }}>TABLES BOOKED</div>
                                <div style={{ fontSize: 19, fontWeight: 800, color: UC, letterSpacing: "-0.02em", lineHeight: 1 }}>{e.uvData.totalBooked}<span style={{ fontSize: 11, color: "#555", fontWeight: 500 }}>/{e.uvData.totalCapacity}</span></div>
                                <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>{abbr(e.uvData.totalRevenue)} min.</div>
                              </div>
                            )}
                            {/* Total revenue */}
                            <div>
                              <div style={{ fontSize: 9, color: "#666", fontFamily: mono, letterSpacing: "0.08em", marginBottom: 4 }}>TOTAL REV.</div>
                              <div style={{ fontSize: 19, fontWeight: 800, color: "#fff", letterSpacing: "-0.02em", lineHeight: 1 }}>{abbr(e.revenue + (e.uvData?.totalRevenue || 0))}</div>
                              <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>{pct(e.revenue + (e.uvData?.totalRevenue||0), e.goal).toFixed(0)}% of goal</div>
                            </div>
                          </div>

                          {/* M/F ratio bar */}
                          {ratioTotal > 0 && (
                            <div style={{ marginBottom: 10 }}>
                              <div style={{ height: 3, borderRadius: 999, overflow: "hidden", display: "flex", marginBottom: 3 }}>
                                <div style={{ width: `${fPct}%`, background: "#ec4899", transition: "width .8s" }} />
                                <div style={{ width: `${mPct}%`, background: "#3b82f6" }} />
                              </div>
                              <div style={{ display: "flex", justifyContent: "space-between" }}>
                                <span style={{ fontSize: 9, color: "#ec4899", fontFamily: mono }}>♀ {fPct}%</span>
                                <span style={{ fontSize: 9, color: "#3b82f6", fontFamily: mono }}>{mPct}% ♂</span>
                              </div>
                            </div>
                          )}

                          {/* Bottom: 24h badge */}
                          {e.tickets24h > 0 && <div style={{ display: "flex" }}><Delta n={e.tickets24h} /></div>}
                        </div>

                    {/* Ticket type breakdown */}
                    {isExp && hasTypes && (
                      <div style={{ padding: "12px 18px 14px", borderTop: `1px solid #2a2a2a`, background: "#0f0f12" }}>
                        <div style={{ fontSize: 10, color: col, fontFamily: mono, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10, fontWeight: 700 }}>Ticket Types</div>
                        {TO.filter(k => types[k]).map(k => {
                          const t = types[k];
                          const bc = k === "vip_backstage" ? UC : k === "expedited" ? MC : col;
                          const sh = e.ticketsSold > 0 ? Math.round((t.sold / e.ticketsSold) * 100) : 0;
                          return (
                            <div key={k} style={{ marginBottom: 10 }}>
                              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                                <span style={{ fontSize: 12, color: "#ddd" }}>{TL[k]}</span>
                                <span style={{ fontSize: 11, color: "#999", fontFamily: mono }}>{N(t.sold)} — {abbr(t.revenue)}</span>
                              </div>
                              <div style={{ height: 4, background: "#2a2a2a", borderRadius: 999, overflow: "hidden" }}>
                                <div style={{ height: "100%", width: `${sh}%`, background: bc, borderRadius: 999 }} />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* RIGHT PANEL */}
            <div>
              {artSum ? (
                <ArtistPanel summary={artSum} />
              ) : ev ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

                  {/* Event header + tabs */}
                  <div style={{ padding: "14px 18px", background: "#141418", border: "1px solid #242428", borderRadius: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 12 }}>
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                          <h2 style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-0.02em" }}>{ev.name}</h2>
                          <VPill vt={ev.venueType} />
                        </div>
                        <div style={{ fontSize: 10, color: "#555", fontFamily: mono }}>{fd(ev.date)} — {N(ev.capacity)} cap — {ev.daysToEvent > 0 ? `${ev.daysToEvent} days out` : "Today"}</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 9, color: "#555", fontFamily: mono, letterSpacing: "0.1em", marginBottom: 2 }}>TOTAL REVENUE</div>
                        <div style={{ fontSize: 26, fontWeight: 800, color: "#fff", letterSpacing: "-0.02em" }}>{$(ev.revenue + (uvd?.totalRevenue || 0))}</div>
                        <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", marginTop: 6 }}>
                          <div style={{ textAlign: "right" }}>
                            <div style={{ fontSize: 9, color: MC, fontFamily: mono, letterSpacing: "0.06em" }}>TICKET REV.</div>
                            <div style={{ fontSize: 14, fontWeight: 700, color: MC }}>{$(ev.revenue)}</div>
                          </div>
                          {uvd && (
                            <div style={{ textAlign: "right" }}>
                              <div style={{ fontSize: 9, color: UC, fontFamily: mono, letterSpacing: "0.06em" }}>TABLE MIN-SPEND</div>
                              <div style={{ fontSize: 14, fontWeight: 700, color: UC }}>{$(uvd.totalRevenue)}</div>
                            </div>
                          )}
                        </div>
                        <div style={{ fontSize: 10, color: "#555", fontFamily: mono, marginTop: 4 }}>{pct(ev.revenue + (uvd?.totalRevenue || 0), ev.goal).toFixed(1)}% of goal</div>
                      </div>
                    </div>
                    <div style={{ display: "flex", borderBottom: "1px solid #151515" }}>
                      {[["overview", "Overview"], ["tickets", "Tickets"], ["vip", `VIP${uvd ? ` (${uvd.tables.length})` : ""}`]].map(([id, lbl]) => (
                        <button key={id} onClick={() => setTab(id)} style={{ padding: "6px 14px", fontSize: 11, background: "transparent", border: "none", borderBottom: `2px solid ${tab === id ? vc(ev.venueType) : "transparent"}`, color: tab === id ? "#fff" : "#555", cursor: "pointer", fontFamily: mono, marginBottom: -1, transition: "all .15s" }}>{lbl}</button>
                      ))}
                    </div>
                  </div>

                  {/* OVERVIEW TAB */}
                  {tab === "overview" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

                      {/* ── TOTAL REVENUE PACE BLOCK — FIRST ── */}
                      <div style={{ background: "#141418", border: `2px solid #1e3a2f`, borderRadius: 12, paddingTop: 18, paddingBottom: 18, paddingLeft: 20, paddingRight: 20 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                          <div style={{ width: 10, height: 10, borderRadius: 3, background: MC, flexShrink: 0 }} />
                          <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>Total Revenue Pace</div>
                          <div style={{ marginLeft: "auto", fontSize: 11, color: "#666", fontFamily: mono }}>{ev.daysToEvent > 0 ? `${ev.daysToEvent} days out` : "Tonight"}</div>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
                          <div>
                            <div style={{ fontSize: 11, color: "#777", marginBottom: 4 }}>Total So Far</div>
                            <div style={{ fontSize: 28, fontWeight: 800, color: MC, letterSpacing: "-0.02em" }}>{$(ev.revenue + (uvd?.totalRevenue || 0))}</div>
                            <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>tickets + tables</div>
                          </div>
                          <div>
                            <div style={{ fontSize: 11, color: "#777", marginBottom: 4 }}>Revenue Goal</div>
                            <div style={{ fontSize: 28, fontWeight: 800, color: "#fff", letterSpacing: "-0.02em" }}>{$(ev.goal)}</div>
                            <div style={{ fontSize: 11, marginTop: 2 }}>
                              <button onClick={() => { const g = prompt("Set revenue goal:", ev.goal); if (g && !isNaN(g)) { setAllEvents(prev => prev.map(x => x.id === ev.id ? {...x, goal: Number(g)} : x)); }}}
                                style={{ fontSize: 11, color: MC, background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline" }}>edit goal</button>
                            </div>
                          </div>
                          <div>
                            <div style={{ fontSize: 11, color: "#777", marginBottom: 4 }}>Projected Total</div>
                            <div style={{ fontSize: 28, fontWeight: 800, color: pct(ev.projRevenue, ev.goal) >= 80 ? MC : "#ffc000", letterSpacing: "-0.02em" }}>{$(ev.projRevenue)}</div>
                            <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>at current pace</div>
                          </div>
                        </div>
                        <div style={{ background: "#0f0f12", borderRadius: 8, height: 10, overflow: "hidden", marginBottom: 4 }}>
                          <div style={{ height: "100%", width: `${pct(ev.revenue + (uvd?.totalRevenue || 0), ev.goal)}%`, background: MC, borderRadius: 8, transition: "width 1s" }} />
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
                          <div style={{ fontSize: 12, color: MC, fontWeight: 700 }}>{pct(ev.revenue + (uvd?.totalRevenue || 0), ev.goal).toFixed(0)}% of goal reached</div>
                          <div style={{ fontSize: 11, color: "#555" }}>{$(ev.goal - ev.revenue - (uvd?.totalRevenue || 0))} remaining</div>
                        </div>
                      </div>

                      {/* ── TICKET SALES BLOCK ── */}
                      <div style={{ background: "#141418", border: "1px solid #2a2a2a", borderRadius: 12, paddingTop: 18, paddingBottom: 18, paddingLeft: 20, paddingRight: 20 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                          <div style={{ width: 10, height: 10, borderRadius: 3, background: vc(ev.venueType), flexShrink: 0 }} />
                          <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>Ticket Sales</div>
                          {ev.tickets24h > 0 && <Delta n={ev.tickets24h} />}
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
                          <div>
                            <div style={{ fontSize: 11, color: "#777", marginBottom: 4 }}>Sold</div>
                            <div style={{ fontSize: 28, fontWeight: 800, color: vc(ev.venueType), letterSpacing: "-0.02em" }}>{N(ev.ticketsSold)}</div>
                            <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>of {N(ev.capacity)} capacity</div>
                          </div>
                          <div>
                            <div style={{ fontSize: 11, color: "#777", marginBottom: 4 }}>Ticket Revenue</div>
                            <div style={{ fontSize: 28, fontWeight: 800, color: "#fff", letterSpacing: "-0.02em" }}>{$(ev.revenue)}</div>
                            <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>of {$(ev.goal)} goal</div>
                          </div>
                          <div>
                            <div style={{ fontSize: 11, color: "#777", marginBottom: 4 }}>Remaining</div>
                            <div style={{ fontSize: 28, fontWeight: 800, color: "#fff", letterSpacing: "-0.02em" }}>{N(ev.capacity - ev.ticketsSold)}</div>
                            <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>tickets left</div>
                          </div>
                        </div>
                        <div style={{ background: "#0f0f12", borderRadius: 8, height: 8, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${pct(ev.ticketsSold, ev.capacity)}%`, background: vc(ev.venueType), borderRadius: 8, transition: "width 1s" }} />
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
                          <div style={{ fontSize: 11, color: "#666" }}>{pct(ev.ticketsSold, ev.capacity).toFixed(0)}% sold</div>
                          <div style={{ fontSize: 11, color: "#666" }}>{pct(ev.revenue, ev.goal).toFixed(0)}% of revenue goal</div>
                        </div>
                      </div>

                      {/* ── VIP TABLE RESERVATIONS BLOCK ── */}
                      {uvd && (
                        <div style={{ background: "#141418", border: `1px solid #2a2a2a`, borderRadius: 12, paddingTop: 18, paddingBottom: 18, paddingLeft: 20, paddingRight: 20 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                            <div style={{ width: 10, height: 10, borderRadius: 3, background: UC, flexShrink: 0 }} />
                            <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>VIP Table Reservations</div>
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
                            <div>
                              <div style={{ fontSize: 11, color: "#777", marginBottom: 4 }}>Tables Booked</div>
                              <div style={{ fontSize: 28, fontWeight: 800, color: UC, letterSpacing: "-0.02em" }}>{uvd.totalBooked}</div>
                              <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>of {uvd.totalCapacity} available</div>
                            </div>
                            <div>
                              <div style={{ fontSize: 11, color: "#777", marginBottom: 4 }}>Table Revenue</div>
                              <div style={{ fontSize: 28, fontWeight: 800, color: "#fff", letterSpacing: "-0.02em" }}>{$(uvd.totalRevenue)}</div>
                              <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>collected so far</div>
                            </div>
                            <div>
                              <div style={{ fontSize: 11, color: "#777", marginBottom: 4 }}>Min-Spend Upside</div>
                              <div style={{ fontSize: 28, fontWeight: 800, color: "#fff", letterSpacing: "-0.02em" }}>{$(uvd.totalMinSpend - uvd.totalRevenue)}</div>
                              <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>remaining potential</div>
                            </div>
                          </div>
                          <div style={{ background: "#0f0f12", borderRadius: 8, height: 8, overflow: "hidden" }}>
                            <div style={{ height: "100%", width: `${pct(uvd.totalBooked, uvd.totalCapacity)}%`, background: UC, borderRadius: 8, transition: "width 1s" }} />
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
                            <div style={{ fontSize: 11, color: "#666" }}>{pct(uvd.totalBooked, uvd.totalCapacity).toFixed(0)}% of tables reserved</div>
                            <div style={{ fontSize: 11, color: "#666" }}>{$(uvd.totalRevenue)} of {$(uvd.totalMinSpend)} min-spend</div>
                          </div>
                        </div>
                      )}


                      {/* ── META CAMPAIGNS BLOCK ── */}
                      {(() => {
                        const evCampaigns = metaCampaigns.filter(c => {
                          const n = (c.name || "").toLowerCase();
                          return n.includes(ev.name.toLowerCase()) || n.includes(ev.date.replace(/-/g,"").slice(2));
                        });
                        if (evCampaigns.length === 0 && metaCampaigns.length === 0) return (
                          <div style={{ background: "#141418", border: "1px solid #1e2a3a", borderRadius: 12, paddingTop: 16, paddingBottom: 16, paddingLeft: 20, paddingRight: 20 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                              <div style={{ width: 10, height: 10, borderRadius: 3, background: "#1877F2", flexShrink: 0 }} />
                              <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>Meta Campaigns</div>
                            </div>
                            <div style={{ fontSize: 11, color: "#555" }}>Add your Meta Ad Account credentials in <button onClick={() => setShowCfg(true)} style={{ background: "none", border: "none", color: MC, fontSize: 11, cursor: "pointer", padding: 0, textDecoration: "underline" }}>⚙ config</button> to see campaign performance here.</div>
                          </div>
                        );
                        if (evCampaigns.length === 0) return null;
                        return (
                          <div style={{ background: "#141418", border: "1px solid #1e2a3a", borderRadius: 12, paddingTop: 18, paddingBottom: 18, paddingLeft: 20, paddingRight: 20 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                              <div style={{ width: 10, height: 10, borderRadius: 3, background: "#1877F2", flexShrink: 0 }} />
                              <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>Meta Campaigns ({evCampaigns.length})</div>
                            </div>
                            {evCampaigns.map((c, i) => {
                              const spend = parseFloat(c.spend || 0);
                              const purchases = (c.actions || []).find(a => a.action_type === "purchase")?.value || 0;
                              const purchaseVal = (c.action_values || []).find(a => a.action_type === "purchase")?.value || 0;
                              const roas = spend > 0 ? (purchaseVal / spend).toFixed(2) : "—";
                              const cpm = parseFloat(c.cpm || 0).toFixed(2);
                              const cpc = parseFloat(c.cpc || 0).toFixed(2);
                              const ctr = parseFloat(c.ctr || 0).toFixed(2);
                              return (
                                <div key={i} style={{ marginBottom: i < evCampaigns.length - 1 ? 16 : 0, paddingBottom: i < evCampaigns.length - 1 ? 16 : 0, borderBottom: i < evCampaigns.length - 1 ? "1px solid #1e1e1e" : "none" }}>
                                  <div style={{ fontSize: 11, color: "#aaa", marginBottom: 10, fontStyle: "italic" }}>{c.name}</div>
                                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 10 }}>
                                    {[["Spend", `$${spend.toFixed(0)}`,"#fff"],["Impressions", N(c.impressions||0),"#888"],["Reach", N(c.reach||0),"#888"],["Clicks", N(c.clicks||0),"#888"]].map(([l,v,col]) => (
                                      <div key={l}><div style={{ fontSize: 9, color: "#555", fontFamily: mono, letterSpacing: "0.08em", marginBottom: 3 }}>{l}</div><div style={{ fontSize: 15, fontWeight: 700, color: col }}>{v}</div></div>
                                    ))}
                                  </div>
                                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 10 }}>
                                    {[["CTR", `${ctr}%`,"#888"],["CPM", `$${cpm}`,"#888"],["CPC", `$${cpc}`,"#888"],["Freq.", parseFloat(c.frequency||0).toFixed(2),"#888"]].map(([l,v,col]) => (
                                      <div key={l}><div style={{ fontSize: 9, color: "#555", fontFamily: mono, letterSpacing: "0.08em", marginBottom: 3 }}>{l}</div><div style={{ fontSize: 15, fontWeight: 700, color: col }}>{v}</div></div>
                                    ))}
                                  </div>
                                  <div style={{ background: "#0f0f12", borderRadius: 8, paddingTop: 10, paddingBottom: 10, paddingLeft: 12, paddingRight: 12 }}>
                                    <div style={{ fontSize: 9, color: "#1877F2", fontFamily: mono, letterSpacing: "0.1em", marginBottom: 8, fontWeight: 700 }}>CONVERSIONS</div>
                                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10 }}>
                                      {[["Purchases", purchases],["Value", `$${parseFloat(purchaseVal).toFixed(0)}`],["ROAS", `${roas}x`],["Cost/Purch.", spend > 0 && purchases > 0 ? `$${(spend/purchases).toFixed(0)}` : "—"]].map(([l,v]) => (
                                        <div key={l}><div style={{ fontSize: 9, color: "#555", fontFamily: mono, letterSpacing: "0.08em", marginBottom: 3 }}>{l}</div><div style={{ fontSize: 15, fontWeight: 700, color: l === "ROAS" ? MC : "#fff" }}>{v}</div></div>
                                      ))}
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}

                    </div>
                  )}

                  {/* TICKETS TAB */}
                  {tab === "tickets" && (
                    <div style={{ padding: "14px 18px", background: "#141418", border: "1px solid #242428", borderRadius: 10, display: "flex", flexDirection: "column", gap: 14 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div style={{ fontSize: 9, letterSpacing: "0.14em", color: "#444", fontFamily: mono, textTransform: "uppercase" }}>30-Day Ticket Pace</div>
                        {ev.tickets24h > 0 && <Delta n={ev.tickets24h} />}
                      </div>
                      <ResponsiveContainer width="100%" height={170}>
                        <AreaChart data={ev.paceHistory}>
                          <defs>
                            <linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor={vc(ev.venueType)} stopOpacity={0.3} />
                              <stop offset="95%" stopColor={vc(ev.venueType)} stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="2 6" stroke="rgba(255,255,255,.03)" />
                          <XAxis dataKey="label" tick={{ fill: "#444", fontSize: 9, fontFamily: mono }} tickLine={false} axisLine={false} interval={5} />
                          <YAxis tick={{ fill: "#444", fontSize: 9, fontFamily: mono }} tickLine={false} axisLine={false} width={26} />
                          <Tooltip content={<Tip />} />
                          <Area type="monotone" dataKey="tickets" stroke={vc(ev.venueType)} strokeWidth={2} fill="url(#tg)" dot={false} />
                        </AreaChart>
                      </ResponsiveContainer>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                        <div style={{ padding: "10px 12px", background: "#111116", borderRadius: 8 }}>
                          <div style={{ fontSize: 9, color: "#555", fontFamily: mono, marginBottom: 3 }}>TOTAL SOLD</div>
                          <div style={{ fontSize: 17, fontWeight: 700 }}>{N(ev.ticketsSold)}</div>
                          <div style={{ fontSize: 10, color: "#444", fontFamily: mono }}>{N(ev.capacity - ev.ticketsSold)} remaining</div>
                        </div>
                        <div style={{ padding: "10px 12px", background: `${MC}08`, border: `1px solid ${MC}22`, borderRadius: 8 }}>
                          <div style={{ fontSize: 9, color: MC, fontFamily: mono, marginBottom: 3 }}>LAST 24H</div>
                          <div style={{ fontSize: 17, fontWeight: 700, color: MC }}>+{N(ev.tickets24h || 0)}</div>
                          <div style={{ fontSize: 10, color: "#444", fontFamily: mono }}>new tickets</div>
                        </div>
                        <div style={{ padding: "10px 12px", background: "#111116", borderRadius: 8 }}>
                          <div style={{ fontSize: 9, color: "#555", fontFamily: mono, marginBottom: 3 }}>DAILY AVG</div>
                          <div style={{ fontSize: 17, fontWeight: 700 }}>{N(ev.dailyPace)}</div>
                          <div style={{ fontSize: 10, color: "#444", fontFamily: mono }}>tickets/day</div>
                        </div>
                      </div>
                      {/* Ticket type breakdown in detail panel */}
                      {ev.ticketTypes && Object.keys(ev.ticketTypes).length > 0 && (
                        <div style={{ borderTop: "1px solid rgba(255,255,255,.06)", paddingTop: 14 }}>
                          <div style={{ fontSize: 9, letterSpacing: "0.14em", color: "#444", fontFamily: mono, textTransform: "uppercase", marginBottom: 12 }}>By Ticket Type</div>
                          {TO.filter(k => ev.ticketTypes[k]).map(k => {
                            const t = ev.ticketTypes[k];
                            const bc = k === "vip_backstage" ? UC : k === "expedited" ? MC : vc(ev.venueType);
                            const sh = ev.ticketsSold > 0 ? Math.round((t.sold / ev.ticketsSold) * 100) : 0;
                            return (
                              <div key={k} style={{ marginBottom: 10 }}>
                                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                                  <span style={{ fontSize: 11, color: "#aaa" }}>{TL[k]}</span>
                                  <div style={{ display: "flex", gap: 12, fontFamily: mono, fontSize: 10 }}>
                                    <span style={{ color: "#777" }}>{N(t.sold)} sold</span>
                                    <span style={{ color: bc, fontWeight: 700 }}>{$(t.revenue)}</span>
                                    <span style={{ color: "#555" }}>{sh}%</span>
                                  </div>
                                </div>
                                <div style={{ height: 4, background: "rgba(255,255,255,.05)", borderRadius: 999, overflow: "hidden" }}>
                                  <div style={{ height: "100%", width: `${sh}%`, background: bc, borderRadius: 999, transition: "width .8s" }} />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {/* VIP TABLES TAB */}
                  {tab === "vip" && (
                    uvd ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
                          <KPI sm label="Tables Booked" value={`${uvd.totalBooked}/${uvd.totalCapacity}`} color={UC} />
                          <KPI sm label="Table Revenue" value={$(uvd.totalRevenue)} sub={`${pct(uvd.totalRevenue, uvd.totalMinSpend).toFixed(0)}% of min-spend`} color={UC} />
                          <KPI sm label="Min-Spend Pot." value={$(uvd.totalMinSpend)} sub="if all fill" />
                          <KPI sm label="Avg/Booking" value={$(uvd.totalRevenue / Math.max(1, uvd.totalBooked))} sub="avg collected" />
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, alignItems: "start" }}>
                          {/* Section list */}
                          <div>
                            <div style={{ fontSize: 9, letterSpacing: "0.14em", color: "#444", fontFamily: mono, textTransform: "uppercase", marginBottom: 8 }}>Sections</div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                              {uvd.tables.map(t => {
                                const isSel = (focusTbl?.id || uvd.tables[0]?.id) === t.id;
                                const p = pct(t.booked, t.capacity);
                                const c = p >= 100 ? "#ff4d4d" : p >= 75 ? UC : MC;
                                return (
                                  <div key={t.id} className="trow" onClick={() => setFocusTblId(t.id)}
                                    style={{ padding: "9px 11px", background: isSel ? `${UC}0a` : "rgba(255,255,255,.02)", border: `1px solid ${isSel ? UC + "44" : "#111"}`, borderLeft: `3px solid ${isSel ? UC : "transparent"}`, borderRadius: 7, cursor: "pointer", transition: "all .15s" }}>
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                                      <span style={{ fontSize: 11, fontWeight: 600, color: isSel ? "#fff" : "#aaa" }}>{t.name}</span>
                                      <span style={{ fontSize: 9, padding: "2px 6px", background: p >= 100 ? "rgba(255,77,77,.1)" : p >= 75 ? `${UC}18` : `${MC}14`, color: c, borderRadius: 99, fontFamily: mono, fontWeight: 700 }}>{p >= 100 ? "FULL" : p >= 75 ? "HIGH" : "OPEN"}</span>
                                    </div>
                                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                                      <span style={{ fontSize: 10, color: c, fontFamily: mono }}>{t.booked}/{t.capacity}</span>
                                      <span style={{ fontSize: 10, color: "#444", fontFamily: mono }}>min {$(t.minSpend)}</span>
                                    </div>
                                    <div style={{ height: 3, background: "rgba(255,255,255,.05)", borderRadius: 999, overflow: "hidden" }}>
                                      <div style={{ height: "100%", width: `${p}%`, background: c, borderRadius: 999 }} />
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                          {/* Section detail */}
                          {focusTbl && (
                            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                              <div style={{ padding: "12px 14px", background: "#1a1508", border: `1px solid ${UC}22`, borderRadius: 10 }}>
                                <div style={{ fontSize: 9, color: UC, fontFamily: mono, letterSpacing: "0.1em", marginBottom: 6 }}>SECTION DETAIL</div>
                                <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>{focusTbl.name}</div>
                                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                                  {[["BOOKED", `${focusTbl.booked}/${focusTbl.capacity}`, UC], ["REVENUE", $(focusTbl.revenue), UC], ["MIN SPEND", $(focusTbl.minSpend), "#fff"], ["UPSIDE", $(focusTbl.minSpend * (focusTbl.capacity - focusTbl.booked)), "#fff"]].map(([l, v, c]) => (
                                    <div key={l} style={{ padding: "8px 10px", background: "#1a1a1e", borderRadius: 6 }}>
                                      <div style={{ fontSize: 9, color: "#555", fontFamily: mono, marginBottom: 2 }}>{l}</div>
                                      <div style={{ fontSize: 14, fontWeight: 700, color: c }}>{v}</div>
                                    </div>
                                  ))}
                                </div>
                                <div style={{ marginTop: 10 }}>
                                  <PBar label="Fill Rate" val={focusTbl.booked} max={focusTbl.capacity} color={UC} />
                                </div>
                              </div>
                              <div style={{ padding: "12px 14px", background: "#141418", border: "1px solid #242428", borderRadius: 10 }}>
                                <div style={{ fontSize: 9, letterSpacing: "0.14em", color: "#444", fontFamily: mono, textTransform: "uppercase", marginBottom: 10 }}>Booking Activity (30d)</div>
                                <ResponsiveContainer width="100%" height={100}>
                                  <BarChart data={focusTbl.bookingHistory} barSize={5}>
                                    <CartesianGrid strokeDasharray="2 6" stroke="rgba(255,255,255,.03)" />
                                    <XAxis dataKey="label" tick={{ fill: "#444", fontSize: 9, fontFamily: mono }} tickLine={false} axisLine={false} interval={6} />
                                    <YAxis tick={{ fill: "#444", fontSize: 9, fontFamily: mono }} tickLine={false} axisLine={false} width={18} allowDecimals={false} />
                                    <Tooltip content={<Tip />} />
                                    <Bar dataKey="booked" fill={UC} opacity={0.85} radius={[3, 3, 0, 0]} />
                                  </BarChart>
                                </ResponsiveContainer>
                              </div>
                            </div>
                          )}
                        </div>
                        {/* All-table pace chart */}
                        <div style={{ padding: "14px 18px", background: "#141418", border: "1px solid #242428", borderRadius: 10 }}>
                          <div style={{ fontSize: 9, letterSpacing: "0.14em", color: "#444", fontFamily: mono, textTransform: "uppercase", marginBottom: 10 }}>All-Table Booking Pace (30d)</div>
                          <ResponsiveContainer width="100%" height={120}>
                            <AreaChart data={uvd.paceHistory}>
                              <defs>
                                <linearGradient id="uvg" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="5%" stopColor={UC} stopOpacity={0.25} />
                                  <stop offset="95%" stopColor={UC} stopOpacity={0} />
                                </linearGradient>
                              </defs>
                              <CartesianGrid strokeDasharray="2 6" stroke="rgba(255,255,255,.03)" />
                              <XAxis dataKey="label" tick={{ fill: "#444", fontSize: 9, fontFamily: mono }} tickLine={false} axisLine={false} interval={5} />
                              <YAxis tick={{ fill: "#444", fontSize: 9, fontFamily: mono }} tickLine={false} axisLine={false} width={22} allowDecimals={false} />
                              <Tooltip content={<Tip />} />
                              <Area type="monotone" dataKey="booked" stroke={UC} strokeWidth={2} fill="url(#uvg)" dot={false} />
                            </AreaChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    ) : (
                      <div style={{ padding: 30, textAlign: "center", background: "#111116", border: "1px solid #1e1e22", borderRadius: 10, color: "#444", fontFamily: mono, fontSize: 11 }}>
                        No UrVenue data. Add credentials in ⚙ config.
                      </div>
                    )
                  )}
                </div>
              ) : (
                <div style={{ padding: 40, textAlign: "center", color: "#333", fontFamily: mono, fontSize: 11, background: "rgba(255,255,255,.015)", borderRadius: 10, border: "1px solid #111" }}>
                  Select an event to view details.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
