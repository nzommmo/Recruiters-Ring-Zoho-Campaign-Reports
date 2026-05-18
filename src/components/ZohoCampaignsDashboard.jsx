import { useState, useEffect, useCallback } from "react";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const ZOHO_CONFIG = {
  CLIENT_ID: import.meta.env.VITE_ZOHO_CLIENT_ID || "",
  CLIENT_SECRET: import.meta.env.VITE_ZOHO_CLIENT_SECRET || "",
  TOKEN_URL: "/api/zoho-auth",
  API_BASE: "api/zoho-api",
  REFRESH_TOKEN: import.meta.env.VITE_ZOHO_REFRESH_TOKEN || "",
  BEARER_TOKEN: import.meta.env.VITE_ZOHO_BEARER_TOKEN || "",
};

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  if (ZOHO_CONFIG.REFRESH_TOKEN) {
    const body = new URLSearchParams({
      client_id: ZOHO_CONFIG.CLIENT_ID,
      client_secret: ZOHO_CONFIG.CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: ZOHO_CONFIG.REFRESH_TOKEN,
    });
    const res = await fetch(ZOHO_CONFIG.TOKEN_URL, { method: "POST", body });
    const data = await res.json();
    if (data.access_token) {
      cachedToken = data.access_token;
      tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
      return cachedToken;
    }
  }
  return ZOHO_CONFIG.BEARER_TOKEN;
}

async function zohoFetch(path, params = {}) {
  const token = await getAccessToken();
  const url = new URL(`${ZOHO_CONFIG.API_BASE}${path}`, window.location.origin);
  url.searchParams.set("resfmt", "JSON");
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  if (!res.ok) throw new Error(`Zoho API ${res.status}: ${res.statusText}`);
  return res.json();
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const pct = (v) => (v == null || v === "" ? "—" : `${parseFloat(v).toFixed(1)}%`);
const num = (v) => (v == null || v === "" ? "—" : parseInt(v, 10).toLocaleString());

const COUNTRY_NAMES = {
  us: "United States", ke: "Kenya", gb: "United Kingdom", ca: "Canada",
  au: "Australia", in: "India", de: "Germany", fr: "France", ma: "Morocco",
  ng: "Nigeria", za: "South Africa", ae: "UAE", sg: "Singapore",
};
const countryName = (code) => COUNTRY_NAMES[code?.toLowerCase()] || code?.toUpperCase() || "Unknown";

// ─── SUB-COMPONENTS ───────────────────────────────────────────────────────────

function KpiCard({ icon, label, value, sub, accent = false }) {
  return (
    <div className={`kpi-card ${accent ? "kpi-card--accent" : ""}`}>
      <span className="kpi-icon" aria-hidden="true">{icon}</span>
      <p className="kpi-label">{label}</p>
      <p className="kpi-value">{value}</p>
      {sub && <p className="kpi-sub">{sub}</p>}
    </div>
  );
}

function DonutChart({ segments, size = 120 }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  let cumulative = 0;
  const r = 44;
  const circumference = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r={r} fill="none" stroke="#f3ede3" strokeWidth="12" />
      {segments.map((seg, i) => {
        const dash = total > 0 ? (seg.value / total) * circumference : 0;
        const offset = -cumulative * (circumference / (total || 1)) + circumference * 0.25;
        const el = (
          <circle key={i} cx="50" cy="50" r={r} fill="none" stroke={seg.color}
            strokeWidth="12"
            strokeDasharray={`${dash} ${circumference - dash}`}
            strokeDashoffset={offset} strokeLinecap="butt"
            style={{ transition: "stroke-dasharray 0.6s ease" }}
          />
        );
        cumulative += seg.value;
        return el;
      })}
    </svg>
  );
}

function BarRow({ label, value, max, color }) {
  const pctVal = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="bar-row">
      <span className="bar-label">{label}</span>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${pctVal}%`, background: color }}
          role="progressbar" aria-valuenow={Math.round(pctVal)} aria-valuemin={0} aria-valuemax={100} />
      </div>
      <span className="bar-value">{num(value)}</span>
    </div>
  );
}

function CampaignRow({ camp, selected, onClick }) {
  return (
    <button
      className={`campaign-row ${selected ? "campaign-row--active" : ""}`}
      onClick={onClick}
      aria-pressed={selected}
    >
      <span className="campaign-dot" aria-hidden="true" />
      <span className="campaign-info">
        <span className="campaign-name">{camp.campaign_name}</span>
        <span className="campaign-date">{camp.created_date_string || camp.created_time || ""}</span>
      </span>
      <span className="campaign-sent-time">{camp.sent_date_string || ""}</span>
    </button>
  );
}

// ─── MAIN DASHBOARD ───────────────────────────────────────────────────────────
export default function ZohoCampaignsDashboard() {
  const [campaigns, setCampaigns] = useState([]);
  const [report, setReport] = useState(null);
  const [selectedKey, setSelectedKey] = useState(null);
  const [selectedName, setSelectedName] = useState(null);
  const [loading, setLoading] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);

  const loadCampaigns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await zohoFetch("/recentcampaigns");

      const list =
        data?.recent_campaigns ||
        data?.list ||
        data?.list_of_campaigns ||
        (Array.isArray(data) ? data : []);

      // ── exclude drafts ────────────────────────────────────────────────────
      const sent = list.filter(
        (c) => (c.campaign_status || "").toLowerCase() !== "draft"
      );

      if (!sent.length) setError(`No sent campaigns found. Status: ${data?.status || "unknown"}.`);

      setCampaigns(sent);
      if (!selectedKey && sent.length) {
        setSelectedKey(sent[0].campaign_key);
        setSelectedName(sent[0].campaign_name);
      }
      setLastRefresh(new Date().toLocaleTimeString());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadReport = useCallback(async (key, name) => {
    if (!key) return;
    setReport(null);
    setReportLoading(true);
    try {
      const data = await zohoFetch("/campaignreports", { campaignkey: key });

      const stats    = data?.["campaign-reports"]?.[0]   || {};
      const details  = data?.["campaign-details"]?.[0]   || {};
      const reach    = data?.["campaign-reach"]?.[0]     || {};
      const location = data?.["campaign-by-loaction"]    || {};

      setReport({ stats: { campaign_name: name, ...stats }, details, reach, location });
    } catch (e) {
      setError(e.message);
    } finally {
      setReportLoading(false);
    }
  }, []);

  useEffect(() => { loadCampaigns(); }, [loadCampaigns]);
  useEffect(() => { if (selectedKey) loadReport(selectedKey, selectedName); }, [selectedKey]);

  const handleSelect = (camp) => {
    setSelectedKey(camp.campaign_key);
    setSelectedName(camp.campaign_name);
  };

  const s = report?.stats || {};

  const engagementSegments = s.open_percent != null ? [
    { label: "Opened",   value: parseFloat(s.open_percent || 0),             color: "#c2410c" },
    { label: "Clicked",  value: parseFloat(s.unique_clicked_percent || 0),   color: "#7c3aed" },
    { label: "Bounced",  value: parseFloat(s.bounce_percent || 0),           color: "#d1d5db" },
    {
      label: "Unopened",
      value: Math.max(
        0,
        100
          - parseFloat(s.open_percent || 0)
          - parseFloat(s.unique_clicked_percent || 0)
          - parseFloat(s.bounce_percent || 0)
      ),
      color: "#f3ede3",
    },
  ] : [];

  const locationEntries = report?.location
    ? Object.entries(report.location).sort((a, b) => b[1] - a[1])
    : [];
  const locationMax = locationEntries[0]?.[1] || 1;

  return (
    <>
      <style>{`
        .zcd { font-family: 'DM Sans', system-ui, sans-serif; color: #1a1208; }
        .zcd-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:1.5rem; flex-wrap:wrap; gap:.75rem; }
        .zcd-title { font-size:1.5rem; font-weight:600; color:#1a1208; letter-spacing:-.02em; }
        .zcd-title span { color:#c2410c; }
        .zcd-eyebrow { font-size:.7rem; font-weight:600; letter-spacing:.12em; text-transform:uppercase; color:#c2410c; margin-bottom:.25rem; }
        .zcd-refresh { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
        .zcd-meta { font-size:.75rem; color:#9ca3af; }
        .btn-refresh { background:#fff5ee; border:1px solid rgba(194,65,12,.3); color:#c2410c; padding:6px 14px; border-radius:8px; font-size:.8rem; font-weight:500; cursor:pointer; transition:background .15s; }
        .btn-refresh:hover { background:#ffe8d9; }
        .btn-refresh:disabled { opacity:.5; cursor:not-allowed; }

        .zcd-grid { display:grid; grid-template-columns:300px 1fr; gap:1.25rem; align-items:start; }
        @media(max-width:800px){ .zcd-grid { grid-template-columns:1fr; } }

        .panel { background:#fff; border:1px solid rgba(26,18,8,.1); border-radius:14px; overflow:hidden; }
        .panel-head { padding:1rem 1.25rem; border-bottom:1px solid rgba(26,18,8,.08); display:flex; align-items:center; justify-content:space-between; }
        .panel-title { font-size:.8rem; font-weight:600; color:#6b7280; letter-spacing:.04em; text-transform:uppercase; }

        .campaign-row { display:grid; grid-template-columns:8px 1fr auto; align-items:center; gap:10px; width:100%; padding:10px 1.25rem; border:none; background:none; text-align:left; cursor:pointer; border-bottom:1px solid rgba(26,18,8,.06); transition:background .12s; }
        .campaign-row:last-child { border-bottom:none; }
        .campaign-row:hover { background:#fff8f4; }
        .campaign-row--active { background:#fff5ee !important; }
        .campaign-dot { width:8px; height:8px; border-radius:50%; background:#c2410c; flex-shrink:0; border-radius:50%; }
        .campaign-info { min-width:0; }
        .campaign-name { font-size:.85rem; font-weight:500; color:#1a1208; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:block; }
        .campaign-date { font-size:.7rem; color:#9ca3af; display:block; margin-top:2px; }
        .campaign-sent-time { font-size:.7rem; color:#9ca3af; white-space:nowrap; flex-shrink:0; }

        .kpi-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:.75rem; padding:1.25rem; }
        .kpi-card { background:#faf7f3; border:1px solid rgba(26,18,8,.08); border-radius:10px; padding:.85rem 1rem; }
        .kpi-card--accent { background:#fff5ee; border-color:rgba(194,65,12,.25); }
        .kpi-icon { font-size:1.1rem; }
        .kpi-label { font-size:.7rem; font-weight:600; color:#9ca3af; text-transform:uppercase; letter-spacing:.06em; margin:4px 0 2px; }
        .kpi-value { font-size:1.35rem; font-weight:700; color:#1a1208; line-height:1.1; }
        .kpi-card--accent .kpi-value { color:#c2410c; }
        .kpi-sub { font-size:.7rem; color:#9ca3af; margin-top:2px; }

        .report-body { padding:1.25rem; }
        .section-label { font-size:.72rem; font-weight:600; color:#9ca3af; text-transform:uppercase; letter-spacing:.07em; margin-bottom:.75rem; }

        .donut-section { display:flex; align-items:center; gap:1.5rem; margin-bottom:1.5rem; flex-wrap:wrap; }
        .donut-legend { display:flex; flex-direction:column; gap:8px; }
        .legend-item { display:flex; align-items:center; gap:8px; font-size:.8rem; }
        .legend-dot { width:10px; height:10px; border-radius:50%; flex-shrink:0; }
        .legend-name { color:#6b7280; flex:1; }
        .legend-val { font-weight:600; color:#1a1208; }

        .bar-row { display:grid; grid-template-columns:110px 1fr 55px; align-items:center; gap:10px; margin-bottom:8px; }
        .bar-label { font-size:.75rem; color:#6b7280; text-align:right; }
        .bar-track { height:8px; background:#f3ede3; border-radius:99px; overflow:hidden; }
        .bar-fill { height:100%; border-radius:99px; transition:width .5s ease; }
        .bar-value { font-size:.78rem; font-weight:500; color:#1a1208; }

        .divider { border:none; border-top:1px solid rgba(26,18,8,.08); margin:1rem 0; }
        .stat-row { display:flex; justify-content:space-between; font-size:.8rem; padding:5px 0; border-bottom:1px solid rgba(26,18,8,.05); }
        .stat-row:last-child { border:none; }
        .stat-name { color:#6b7280; }
        .stat-val { font-weight:600; color:#1a1208; }

        .meta-grid { display:grid; grid-template-columns:1fr 1fr; gap:.5rem .75rem; }
        .meta-item { font-size:.78rem; }
        .meta-key { color:#9ca3af; margin-bottom:2px; }
        .meta-val { font-weight:500; color:#1a1208; word-break:break-word; }

        .skeleton { background:linear-gradient(90deg,#f3ede3 25%,#ffe8d9 50%,#f3ede3 75%); background-size:200% 100%; animation:shimmer 1.4s infinite; border-radius:6px; }
        @keyframes shimmer { to { background-position:-200% 0; } }
        .skel-kpi { height:80px; }
        .skel-bar { height:20px; margin-bottom:8px; }

        .error-banner { background:#fef2f2; border:1px solid #fca5a5; color:#991b1b; border-radius:10px; padding:.75rem 1rem; font-size:.82rem; margin-bottom:1rem; }
        .empty-state { padding:2rem 1.25rem; text-align:center; color:#9ca3af; font-size:.85rem; }
      `}</style>

      <div className="zcd">
        <div className="zcd-header">
          <div>
            <p className="zcd-eyebrow">Email Marketing</p>
            <h1 className="zcd-title">Campaigns <span>Dashboard</span></h1>
          </div>
          <div className="zcd-refresh">
            {lastRefresh && <span className="zcd-meta">Updated {lastRefresh}</span>}
            <button className="btn-refresh" onClick={loadCampaigns} disabled={loading}>
              {loading ? "Loading…" : "↻ Refresh"}
            </button>
          </div>
        </div>

        {error && <div className="error-banner">⚠️ {error}</div>}

        <div className="zcd-grid">

          {/* ── Campaign list ── */}
          <div className="panel">
            <div className="panel-head">
              <p className="panel-title">Sent Campaigns</p>
              {campaigns.length > 0 && (
                <span style={{ fontSize: ".72rem", color: "#9ca3af" }}>{campaigns.length} total</span>
              )}
            </div>
            {loading && campaigns.length === 0 ? (
              <div style={{ padding: "1.25rem" }}>
                {[0,1,2,3].map(i => (
                  <div key={i} className="skeleton" style={{ height: 48, marginBottom: 8, borderRadius: 8 }} />
                ))}
              </div>
            ) : campaigns.length === 0 ? (
              <div className="empty-state">No sent campaigns found.</div>
            ) : (
              campaigns.map((c) => (
                <CampaignRow
                  key={c.campaign_key}
                  camp={c}
                  selected={selectedKey === c.campaign_key}
                  onClick={() => handleSelect(c)}
                />
              ))
            )}
          </div>

          {/* ── Report panel ── */}
          <div className="panel">
            {reportLoading ? (
              <div style={{ padding: "1.25rem" }}>
                <p className="panel-title" style={{ marginBottom: "1rem" }}>Loading report…</p>
                <div className="kpi-grid" style={{ padding: 0, marginBottom: "1rem" }}>
                  {[0,1,2,3,4,5].map(i => <div key={i} className="skeleton skel-kpi" />)}
                </div>
                {[0,1,2,3].map(i => <div key={i} className="skeleton skel-bar" />)}
              </div>
            ) : !report ? (
              <div className="empty-state">Select a campaign to view its report.</div>
            ) : (
              <>
                <div className="panel-head">
                  <p className="panel-title" style={{ color: "#1a1208", textTransform: "none", fontSize: ".9rem" }}>
                    {s.campaign_name || selectedName}
                  </p>
                </div>

                <div className="kpi-grid">
                  <KpiCard icon="📤" label="Sent"       value={num(s.emails_sent_count)} accent />
                  <KpiCard icon="📬" label="Delivered"  value={num(s.delivered_count)}   sub={`${pct(s.delivered_percent)} rate`} />
                  <KpiCard icon="👁"  label="Opens"      value={num(s.opens_count)}       sub={`${pct(s.open_percent)} rate`} accent />
                  <KpiCard icon="🖱"  label="Clicks"     value={pct(s.unique_clicked_percent)} sub="unique CTR" />
                  <KpiCard icon="⚠️" label="Bounces"    value={pct(s.bounce_percent)}    sub={s.hardbounce_count ? `${num(s.hardbounce_count)} hard` : undefined} />
                  <KpiCard icon="🚫" label="Unsubs"     value={pct(s.unsubscribe_percent)} />
                </div>

                <div className="report-body">

                  <p className="section-label">Engagement breakdown</p>
                  <div className="donut-section">
                    <DonutChart segments={engagementSegments} />
                    <div className="donut-legend">
                      {engagementSegments.map((seg) => (
                        <div key={seg.label} className="legend-item">
                          <span className="legend-dot" style={{ background: seg.color }} />
                          <span className="legend-name">{seg.label}</span>
                          <span className="legend-val">{seg.value.toFixed(1)}%</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <hr className="divider" />

                  <p className="section-label">Delivery funnel</p>
                  {[
                    { label: "Delivered", value: parseInt(s.delivered_count) || 0, color: "#c2410c" },
                    { label: "Opened",    value: parseInt(s.opens_count)     || 0, color: "#7c3aed" },
                    { label: "Unopened",  value: parseInt(s.unopened)        || 0, color: "#d1d5db" },
                  ].map(row => (
                    <BarRow key={row.label} {...row} max={parseInt(s.emails_sent_count) || 1} />
                  ))}

                  {locationEntries.length > 0 && (
                    <>
                      <hr className="divider" />
                      <p className="section-label">Opens by country</p>
                      {locationEntries.slice(0, 6).map(([code, count]) => (
                        <BarRow key={code} label={countryName(code)} value={count} max={locationMax} color="#c2410c" />
                      ))}
                    </>
                  )}

                  <hr className="divider" />

                  <p className="section-label">Additional stats</p>
                  {[
                    ["Spam reports",      s.spams_count ? `${num(s.spams_count)} (${pct(s.spam_percent)})` : "—"],
                    ["Forwards",          num(s.forwards_count)],
                    ["Auto-replies",      num(s.autoreply_count)],
                    ["Clicks / open rate", s.clicksperopenrate ? `${parseFloat(s.clicksperopenrate).toFixed(1)}%` : "—"],
                    ["Soft bounces",      num(s.softbounce_count)],
                    ["Complaints",        s.complaints_count ? `${num(s.complaints_count)} (${pct(s.complaints_percent)})` : "—"],
                  ].map(([name, val]) => (
                    <div key={name} className="stat-row">
                      <span className="stat-name">{name}</span>
                      <span className="stat-val">{val}</span>
                    </div>
                  ))}

                  {report.details && Object.keys(report.details).length > 0 && (
                    <>
                      <hr className="divider" />
                      <p className="section-label">Campaign details</p>
                      <div className="meta-grid">
                        {[
                          ["Subject", report.details.email_subject],
                          ["From",    report.details.email_from],
                          ["Sent",    report.details.sent_time],
                          ["Created", report.details.created_time],
                          ["Type",    report.details.email_type],
                          ["Format",  report.details.email_options],
                        ].filter(([, v]) => v).map(([k, v]) => (
                          <div key={k} className="meta-item">
                            <p className="meta-key">{k}</p>
                            <p className="meta-val">{v}</p>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}