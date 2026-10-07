import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { zohoFetchAll } from "../constants/api"

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const STATUSES = [
  ["active", "Active"],
  ["recent", "Recent"],
  ["mostrecent", "Most recent"],
  ["unsub", "Unsubscribed"],
  ["bounce", "Bounced"],
];
const PAGE_SIZE = 25;

// ─── NORMALISERS ─────────────────────────────────────────────────────────────
// The JSON envelope key is not documented as clearly as the XML one, so we try the
// likely keys and fall back to the first array in the response.
const firstArray = (data, keys) => {
  for (const k of keys) if (Array.isArray(data?.[k])) return data[k];
  return (data && Object.values(data).find(Array.isArray)) || [];
};
const extractLists = (d) => firstArray(d, ["list_of_details", "lists"]);
const extractContacts = (d) =>
  firstArray(d, ["list_of_details", "result_of_subscribers", "contacts", "subscribers"]);

const normList = (l) => ({
  key: l.listkey,
  name: l.listname || "(unnamed)",
  contacts: parseInt(l.noofcontacts, 10) || 0,
  unsubs: parseInt(l.noofunsubcnt, 10) || 0,
  bounces: parseInt(l.noofbouncecnt, 10) || 0,
  owner: l.owner || "",
  isPublic: String(l.is_public) === "true",
  created: l.created_date ? new Date(parseInt(l.created_date, 10)) : null,
});

const normContact = (c) => {
  const email = String(c.contact_email || c.email || "").trim().toLowerCase();
  return {
    email,
    firstname: (c.firstname || "").trim(),
    lastname: (c.lastname || "").trim(),
    company: (c.companyname || "").trim(),
    phone: (c.phone || "").trim(),
    domain: email.includes("@") ? email.split("@")[1] : "",
  };
};

const fullName = (c) => [c.firstname, c.lastname].filter(Boolean).join(" ");
const fmt = (n) => (n == null ? "—" : n.toLocaleString());

// Cells starting with = + - @ can execute as formulas when the CSV is opened in Excel.
const csvCell = (v) => {
  let s = String(v ?? "");
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
};

function downloadCsv(rows, filename) {
  const header = ["Email", "First name", "Last name", "Company", "Phone"];
  const lines = rows.map((c) =>
    [c.email, c.firstname, c.lastname, c.company, c.phone].map(csvCell).join(",")
  );
  const blob = new Blob([[header.map(csvCell).join(","), ...lines].join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ─── COMPONENT ───────────────────────────────────────────────────────────────
export default function ListsContactsPanel() {
  const [lists, setLists] = useState([]);
  const [listsLoading, setListsLoading] = useState(false);
  const [listQuery, setListQuery] = useState("");
  const [selected, setSelected] = useState(null);

  const [status, setStatus] = useState("active");
  const [contacts, setContacts] = useState([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [progress, setProgress] = useState(0);

  const [filters, setFilters] = useState({ q: "", domain: "", company: "", hasPhone: false });
  const [sort, setSort] = useState({ key: "email", dir: "asc" });
  const [page, setPage] = useState(0);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  // ── load all lists ──
  const loadLists = useCallback(async () => {
    setListsLoading(true);
    setError(null);
    try {
      const rows = await zohoFetchAll(
        "/getmailinglists",
        { sort: "asc" },
        { extract: extractLists, pageSize: 100 }
      );
      const normalised = rows.map(normList).filter((l) => l.key);
      setLists(normalised);
      setSelected((cur) => cur || normalised[0] || null);
    } catch (e) {
      setError(`Could not load lists. ${e.message}`);
    } finally {
      setListsLoading(false);
    }
  }, []);

  useEffect(() => { loadLists(); }, [loadLists]);

  // ── load contacts for the selected list + status ──
  useEffect(() => {
    if (!selected) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setContacts([]);
    setProgress(0);
    setPage(0);
    setContactsLoading(true);
    setError(null);

    zohoFetchAll(
      "/getlistsubscribers",
      { listkey: selected.key, status, sort: "asc" },
      { extract: extractContacts, pageSize: 200, onProgress: setProgress, signal: ctrl.signal }
    )
      .then((rows) => {
        // zuid is the account id, not a contact id, so email is the unique key
        const seen = new Set();
        const unique = rows.map(normContact).filter((c) => {
          if (!c.email || seen.has(c.email)) return false;
          seen.add(c.email);
          return true;
        });
        setContacts(unique);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(`Could not load contacts. ${e.message}`);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setContactsLoading(false);
      });

    return () => ctrl.abort();
  }, [selected, status]);

  // ── derived data ──
  const domainOptions = useMemo(() => {
    const counts = {};
    contacts.forEach((c) => c.domain && (counts[c.domain] = (counts[c.domain] || 0) + 1));
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 50);
  }, [contacts]);

  const filtered = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    const co = filters.company.trim().toLowerCase();
    const out = contacts.filter((c) => {
      if (filters.domain && c.domain !== filters.domain) return false;
      if (filters.hasPhone && !c.phone) return false;
      if (co && !c.company.toLowerCase().includes(co)) return false;
      if (q && !`${c.email} ${fullName(c)}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const dir = sort.dir === "asc" ? 1 : -1;
    const val = (c) => (sort.key === "name" ? fullName(c) : c[sort.key] || "").toLowerCase();
    return out.sort((a, b) => {
      const av = val(a), bv = val(b);
      // empty values always sink to the bottom
      if (!av !== !bv) return av ? -1 : 1;
      return av.localeCompare(bv) * dir;
    });
  }, [contacts, filters, sort]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const rows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const filtersActive = filters.q || filters.domain || filters.company || filters.hasPhone;

  const visibleLists = lists.filter((l) =>
    l.name.toLowerCase().includes(listQuery.trim().toLowerCase())
  );
  const totals = useMemo(
    () => lists.reduce((t, l) => ({
      contacts: t.contacts + l.contacts,
      unsubs: t.unsubs + l.unsubs,
      bounces: t.bounces + l.bounces,
    }), { contacts: 0, unsubs: 0, bounces: 0 }),
    [lists]
  );

  const setFilter = (patch) => { setFilters((f) => ({ ...f, ...patch })); setPage(0); };
  const toggleSort = (key) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  const arrow = (key) => (sort.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : "");
  const clearFilters = () => setFilter({ q: "", domain: "", company: "", hasPhone: false });

  const statusLabel = STATUSES.find(([v]) => v === status)?.[1] || status;

  return (
    <>
      <style>{`
        .lc { font-family:'DM Sans', system-ui, sans-serif; color:#1a1208; }
        .lc-head { display:flex; align-items:center; justify-content:space-between; gap:.75rem; flex-wrap:wrap; margin-bottom:1.25rem; }
        .lc-title { font-size:1.5rem; font-weight:600; letter-spacing:-.02em; margin:0; }
        .lc-btn { background:#fff5ee; border:1px solid rgba(194,65,12,.3); color:#c2410c; padding:6px 14px; border-radius:8px; font-size:.8rem; font-weight:500; cursor:pointer; }
        .lc-btn:hover { background:#ffe8d9; }
        .lc-btn:disabled { opacity:.5; cursor:not-allowed; }
        .lc-btn:focus-visible, .lc-input:focus-visible, .lc-list-row:focus-visible, .lc-th:focus-visible { outline:2px solid #c2410c; outline-offset:2px; }

        .lc-kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:.75rem; margin-bottom:1.25rem; }
        .lc-kpi { background:#faf7f3; border:1px solid rgba(26,18,8,.08); border-radius:10px; padding:.85rem 1rem; }
        .lc-kpi--accent { background:#fff5ee; border-color:rgba(194,65,12,.25); }
        .lc-kpi-label { font-size:.72rem; font-weight:600; color:#9ca3af; margin:0 0 4px; }
        .lc-kpi-value { font-size:1.35rem; font-weight:700; line-height:1.1; margin:0; }
        .lc-kpi--accent .lc-kpi-value { color:#c2410c; }

        .lc-grid { display:grid; grid-template-columns:300px 1fr; gap:1.25rem; align-items:start; }
        @media(max-width:800px){ .lc-grid { grid-template-columns:1fr; } }
        .lc-panel { background:#fff; border:1px solid rgba(26,18,8,.1); border-radius:14px; overflow:hidden; min-width:0; }
        .lc-panel-head { padding:1rem 1.25rem; border-bottom:1px solid rgba(26,18,8,.08); display:flex; align-items:center; justify-content:space-between; gap:.5rem; flex-wrap:wrap; }
        .lc-panel-title { font-size:.9rem; font-weight:600; margin:0; }
        .lc-muted { font-size:.75rem; color:#9ca3af; }

        .lc-input { border:1px solid rgba(26,18,8,.15); border-radius:8px; padding:7px 10px; font-size:.82rem; font-family:inherit; background:#fff; color:#1a1208; min-width:0; }
        .lc-search { margin:.75rem 1.25rem; width:calc(100% - 2.5rem); box-sizing:border-box; }
        .lc-list-scroll { max-height:520px; overflow-y:auto; }
        .lc-list-row { display:block; width:100%; text-align:left; padding:10px 1.25rem; border:none; border-bottom:1px solid rgba(26,18,8,.06); background:none; cursor:pointer; font-family:inherit; }
        .lc-list-row:hover { background:#fff8f4; }
        .lc-list-row--active { background:#fff5ee; box-shadow:inset 3px 0 0 #c2410c; }
        .lc-list-name { display:block; font-size:.85rem; font-weight:500; color:#1a1208; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .lc-list-meta { display:block; font-size:.72rem; color:#9ca3af; margin-top:2px; }

        .lc-tabs { display:flex; gap:4px; padding:.75rem 1.25rem 0; flex-wrap:wrap; }
        .lc-tab { border:1px solid rgba(26,18,8,.12); background:#fff; color:#6b7280; border-radius:99px; padding:4px 12px; font-size:.78rem; cursor:pointer; font-family:inherit; }
        .lc-tab[aria-pressed="true"] { background:#c2410c; border-color:#c2410c; color:#fff; }
        .lc-tab:focus-visible { outline:2px solid #c2410c; outline-offset:2px; }

        .lc-filters { display:flex; gap:.5rem; flex-wrap:wrap; align-items:center; padding:.75rem 1.25rem; border-bottom:1px solid rgba(26,18,8,.08); }
        .lc-check { display:flex; align-items:center; gap:6px; font-size:.8rem; color:#6b7280; cursor:pointer; }

        .lc-table-wrap { overflow-x:auto; }
        .lc-table { width:100%; border-collapse:collapse; font-size:.82rem; }
        .lc-table th, .lc-table td { text-align:left; padding:9px 1.25rem; border-bottom:1px solid rgba(26,18,8,.06); white-space:nowrap; }
        .lc-th { background:none; border:none; padding:0; font:inherit; font-weight:600; font-size:.75rem; color:#6b7280; cursor:pointer; }
        .lc-table tbody tr:hover { background:#fff8f4; }
        .lc-dash { color:#c9c3b8; }

        .lc-foot { display:flex; justify-content:space-between; align-items:center; padding:.75rem 1.25rem; gap:.5rem; flex-wrap:wrap; }
        .lc-pager { display:flex; align-items:center; gap:8px; }

        .lc-bar { height:3px; background:#f3ede3; overflow:hidden; }
        .lc-bar > span { display:block; height:100%; width:40%; background:#c2410c; animation:lc-slide 1.1s infinite ease-in-out; }
        @keyframes lc-slide { from { transform:translateX(-100%); } to { transform:translateX(350%); } }
        @media (prefers-reduced-motion: reduce) { .lc-bar > span { animation:none; width:100%; } }

        .lc-error { background:#fef2f2; border:1px solid #fca5a5; color:#991b1b; border-radius:10px; padding:.75rem 1rem; font-size:.82rem; margin-bottom:1rem; }
        .lc-empty { padding:2rem 1.25rem; text-align:center; color:#9ca3af; font-size:.85rem; }
      `}</style>

      <div className="lc">
        <div className="lc-head">
          <h1 className="lc-title">Lists and contacts</h1>
          <button className="lc-btn" onClick={loadLists} disabled={listsLoading}>
            {listsLoading ? "Loading…" : "Refresh lists"}
          </button>
        </div>

        {error && <div className="lc-error" role="alert">{error}</div>}

        <div className="lc-kpis">
          <div className="lc-kpi lc-kpi--accent">
            <p className="lc-kpi-label">Lists</p>
            <p className="lc-kpi-value">{fmt(lists.length)}</p>
          </div>
          <div className="lc-kpi">
            <p className="lc-kpi-label">Contacts across all lists</p>
            <p className="lc-kpi-value">{fmt(totals.contacts)}</p>
          </div>
          <div className="lc-kpi">
            <p className="lc-kpi-label">Unsubscribed</p>
            <p className="lc-kpi-value">{fmt(totals.unsubs)}</p>
          </div>
          <div className="lc-kpi">
            <p className="lc-kpi-label">Bounced</p>
            <p className="lc-kpi-value">{fmt(totals.bounces)}</p>
          </div>
        </div>

        <div className="lc-grid">
          {/* ── Lists ── */}
          <div className="lc-panel">
            <div className="lc-panel-head">
              <p className="lc-panel-title">Mailing lists</p>
              <span className="lc-muted">{visibleLists.length} shown</span>
            </div>
            <input
              className="lc-input lc-search"
              type="search"
              placeholder="Search lists"
              aria-label="Search lists"
              value={listQuery}
              onChange={(e) => setListQuery(e.target.value)}
            />
            <div className="lc-list-scroll">
              {listsLoading && lists.length === 0 ? (
                <div className="lc-empty">Loading lists…</div>
              ) : visibleLists.length === 0 ? (
                <div className="lc-empty">No lists match your search.</div>
              ) : (
                visibleLists.map((l) => (
                  <button
                    key={l.key}
                    className={`lc-list-row ${selected?.key === l.key ? "lc-list-row--active" : ""}`}
                    onClick={() => setSelected(l)}
                    aria-pressed={selected?.key === l.key}
                  >
                    <span className="lc-list-name">{l.name}</span>
                    <span className="lc-list-meta">
                      {fmt(l.contacts)} contacts, {fmt(l.unsubs)} unsubscribed, {l.isPublic ? "public" : "private"}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* ── Contacts ── */}
          <div className="lc-panel">
            <div className="lc-panel-head">
              <p className="lc-panel-title">{selected ? selected.name : "Contacts"}</p>
              <button
                className="lc-btn"
                disabled={!filtered.length}
                onClick={() =>
                  downloadCsv(filtered, `${(selected?.name || "contacts").replace(/[^\w-]+/g, "_")}-${status}.csv`)
                }
              >
                Export {filtered.length ? fmt(filtered.length) : ""} to CSV
              </button>
            </div>

            <div className="lc-tabs" role="group" aria-label="Contact status">
              {STATUSES.map(([value, label]) => (
                <button key={value} className="lc-tab" aria-pressed={status === value} onClick={() => setStatus(value)}>
                  {label}
                </button>
              ))}
            </div>

            <div className="lc-filters">
              <input
                className="lc-input"
                type="search"
                placeholder="Search name or email"
                aria-label="Search name or email"
                value={filters.q}
                onChange={(e) => setFilter({ q: e.target.value })}
              />
              <input
                className="lc-input"
                type="search"
                placeholder="Company contains"
                aria-label="Filter by company"
                value={filters.company}
                onChange={(e) => setFilter({ company: e.target.value })}
              />
              <select
                className="lc-input"
                aria-label="Filter by email domain"
                value={filters.domain}
                onChange={(e) => setFilter({ domain: e.target.value })}
              >
                <option value="">All domains</option>
                {domainOptions.map(([d, n]) => (
                  <option key={d} value={d}>{d} ({n})</option>
                ))}
              </select>
              <label className="lc-check">
                <input
                  type="checkbox"
                  checked={filters.hasPhone}
                  onChange={(e) => setFilter({ hasPhone: e.target.checked })}
                />
                Has phone
              </label>
              {filtersActive && (
                <button className="lc-btn" onClick={clearFilters}>Clear filters</button>
              )}
            </div>

            {contactsLoading && <div className="lc-bar" role="progressbar" aria-label="Loading contacts"><span /></div>}

            {!selected ? (
              <div className="lc-empty">Select a list to see its contacts.</div>
            ) : contactsLoading && contacts.length === 0 ? (
              <div className="lc-empty">
                Loading {statusLabel.toLowerCase()} contacts{progress ? `, ${fmt(progress)} fetched so far` : ""}…
              </div>
            ) : filtered.length === 0 ? (
              <div className="lc-empty">
                {contacts.length === 0
                  ? `No ${statusLabel.toLowerCase()} contacts in this list.`
                  : "No contacts match these filters."}
              </div>
            ) : (
              <>
                <div className="lc-table-wrap">
                  <table className="lc-table">
                    <thead>
                      <tr>
                        {[["email", "Email"], ["name", "Name"], ["company", "Company"], ["phone", "Phone"]].map(([k, label]) => (
                          <th key={k} scope="col" aria-sort={sort.key === k ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                            <button className="lc-th" onClick={() => toggleSort(k)}>{label}{arrow(k)}</button>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((c) => (
                        <tr key={c.email}>
                          <td>{c.email}</td>
                          <td>{fullName(c) || <span className="lc-dash">—</span>}</td>
                          <td>{c.company || <span className="lc-dash">—</span>}</td>
                          <td>{c.phone || <span className="lc-dash">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="lc-foot">
                  <span className="lc-muted">
                    {fmt(filtered.length)} of {fmt(contacts.length)} contacts
                    {contactsLoading ? ", still loading…" : ""}
                  </span>
                  <div className="lc-pager">
                    <button className="lc-btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</button>
                    <span className="lc-muted">Page {page + 1} of {pageCount}</span>
                    <button className="lc-btn" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>Next</button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}