import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { zohoFetchAll } from "../constants/api";
import { loadListContacts, hasCachedContacts, clearContactCache } from "../constants/ZohoContacts";
import { extractLists, normList, fullName, fmt, downloadCsv } from "../constants/ZohoLists";

const PAGE_SIZE = 25;
const COLORS = ["#c2410c", "#7c3aed", "#0f766e", "#1d4ed8", "#a16207", "#be185d"];
// Lists to tick automatically the first time lists load. Change to match your list names.
const PRESELECT = /\bnts\b|recruiters?\s*ring|vetted/i;

export default function ListOverlapPanel() {
  const [lists, setLists] = useState([]);
  const [listsLoading, setListsLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(() => new Set());

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const [filters, setFilters] = useState({ q: "", minLists: 2, mustInclude: "" });
  const [page, setPage] = useState(0);

  const abortRef = useRef(null);
  const preselected = useRef(false);

  // ── load lists ──
  const loadLists = useCallback(async () => {
    setListsLoading(true);
    setError(null);
    try {
      const rows = await zohoFetchAll(
        "/getmailinglists",
        { sort: "asc" },
        { extract: extractLists, scope: "contact", pageSize: 100 }
      );
      const normalised = rows.map(normList).filter((l) => l.key);
      setLists(normalised);
      if (!preselected.current) {
        preselected.current = true;
        const auto = normalised.filter((l) => PRESELECT.test(l.name)).map((l) => l.key);
        if (auto.length) setSelected(new Set(auto));
      }
    } catch (e) {
      setError(`Could not load lists. ${e.message}`);
    } finally {
      setListsLoading(false);
    }
  }, []);

  useEffect(() => { loadLists(); }, [loadLists]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const toggle = (key) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  // ── fetch active contacts for every chosen list in parallel, then compare ──
  const compare = async (fresh = false) => {
    const chosen = lists.filter((l) => selected.has(l.key));
    if (chosen.length < 2) return;

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const allCached = !fresh && chosen.every((l) => hasCachedContacts(l.key, "active"));
    const started = performance.now();

    setRunning(true);
    setError(null);
    setResult(null);
    setPage(0);
    setFilters((f) => ({ ...f, minLists: 2, mustInclude: "" }));
    setProgress(
      Object.fromEntries(chosen.map((l) => [l.key, { name: l.name, rows: 0, expected: l.contacts, done: false }]))
    );
    const patch = (key, p) =>
      setProgress((prev) => (prev ? { ...prev, [key]: { ...prev[key], ...p } } : prev));

    try {
      const loaded = await Promise.all(
        chosen.map(async (l) => {
          const rows = await loadListContacts(l, {
            status: "active",
            force: fresh,
            signal: ctrl.signal,
            onProgress: (n) => patch(l.key, { rows: n }),
          });
          patch(l.key, { rows: rows.length, done: true });
          return rows;
        })
      );
      const data = {};
      chosen.forEach((l, i) => { data[l.key] = loaded[i]; });
      setResult({
        lists: chosen.map((l, i) => ({ key: l.key, name: l.name, color: COLORS[i % COLORS.length] })),
        data,
        at: new Date(),
        tookMs: performance.now() - started,
        cached: allCached,
      });
    } catch (e) {
      if (e.name !== "AbortError") setError(`Could not compare lists. ${e.message}`);
      ctrl.abort(); // stop the other lists still loading
    } finally {
      if (abortRef.current === ctrl) {
        setRunning(false);
        setProgress(null);
      }
    }
  };

  // ── analysis ──
  const analysis = useMemo(() => {
    if (!result) return null;
    const byEmail = new Map();
    for (const l of result.lists) {
      for (const c of result.data[l.key]) {
        let entry = byEmail.get(c.email);
        if (!entry) {
          entry = { ...c, listKeys: [] };
          byEmail.set(c.email, entry);
        } else {
          for (const f of ["firstname", "lastname", "company", "phone"]) {
            if (!entry[f] && c[f]) entry[f] = c[f];
          }
        }
        entry.listKeys.push(l.key);
      }
    }
    const all = [...byEmail.values()];
    const countsByN = {};
    all.forEach((c) => { countsByN[c.listKeys.length] = (countsByN[c.listKeys.length] || 0) + 1; });

    const pair = {};
    result.lists.forEach((a) => {
      pair[a.key] = {};
      result.lists.forEach((b) => { pair[a.key][b.key] = 0; });
    });
    all.forEach((c) => {
      if (c.listKeys.length < 2) return;
      for (const a of c.listKeys) for (const b of c.listKeys) if (a !== b) pair[a][b]++;
    });

    const colorOf = Object.fromEntries(result.lists.map((l) => [l.key, l.color]));
    const nameOf = Object.fromEntries(result.lists.map((l) => [l.key, l.name]));
    return {
      all, countsByN, pair, colorOf, nameOf,
      unique: all.length,
      overlapping: all.filter((c) => c.listKeys.length >= 2).length,
      inAll: countsByN[result.lists.length] || 0,
    };
  }, [result]);

  const rowsAll = useMemo(() => {
    if (!analysis) return [];
    const q = filters.q.trim().toLowerCase();
    return analysis.all
      .filter((c) =>
        c.listKeys.length >= filters.minLists &&
        (!filters.mustInclude || c.listKeys.includes(filters.mustInclude)) &&
        (!q || `${c.email} ${fullName(c)}`.toLowerCase().includes(q))
      )
      .sort((a, b) => b.listKeys.length - a.listKeys.length || a.email.localeCompare(b.email));
  }, [analysis, filters]);

  const pageCount = Math.max(1, Math.ceil(rowsAll.length / PAGE_SIZE));
  const pageRows = rowsAll.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const setFilter = (patch) => { setFilters((f) => ({ ...f, ...patch })); setPage(0); };

  const visibleLists = lists.filter((l) => l.name.toLowerCase().includes(query.trim().toLowerCase()));
  const selectedTotal = lists.filter((l) => selected.has(l.key)).reduce((n, l) => n + l.contacts, 0);
  const N = result?.lists.length || 0;

  const exportCsv = () =>
    downloadCsv(
      "list-overlap.csv",
      ["Email", "First name", "Last name", "Company", "Number of lists", "Lists"],
      rowsAll.map((c) => [
        c.email, c.firstname, c.lastname, c.company, c.listKeys.length,
        c.listKeys.map((k) => analysis.nameOf[k]).join("; "),
      ])
    );

  return (
    <>
      <style>{`
        .lo { font-family:'DM Sans', system-ui, sans-serif; color:#1a1208; }
        .lo-title { font-size:1.5rem; font-weight:600; letter-spacing:-.02em; margin:0 0 .25rem; }
        .lo-lede { font-size:.85rem; color:#6b7280; margin:0 0 1.25rem; max-width:62ch; line-height:1.5; }
        .lo-grid { display:grid; grid-template-columns:300px 1fr; gap:1.25rem; align-items:start; }
        @media(max-width:800px){ .lo-grid { grid-template-columns:1fr; } }
        .lo-panel { background:#fff; border:1px solid rgba(26,18,8,.1); border-radius:14px; overflow:hidden; min-width:0; }
        .lo-panel-head { padding:1rem 1.25rem; border-bottom:1px solid rgba(26,18,8,.08); display:flex; align-items:center; justify-content:space-between; gap:.5rem; flex-wrap:wrap; }
        .lo-panel-title { font-size:.9rem; font-weight:600; margin:0; }
        .lo-muted { font-size:.75rem; color:#9ca3af; }
        .lo-btn { background:#fff5ee; border:1px solid rgba(194,65,12,.3); color:#c2410c; padding:6px 14px; border-radius:8px; font-size:.8rem; font-weight:500; cursor:pointer; font-family:inherit; }
        .lo-btn:hover { background:#ffe8d9; }
        .lo-btn:disabled { opacity:.5; cursor:not-allowed; }
        .lo-btn--solid { background:#c2410c; color:#fff; border-color:#c2410c; }
        .lo-btn--solid:hover { background:#9a3412; }
        .lo-btn:focus-visible, .lo-input:focus-visible, .lo-pick:focus-within { outline:2px solid #c2410c; outline-offset:2px; }
        .lo-input { border:1px solid rgba(26,18,8,.15); border-radius:8px; padding:7px 10px; font-size:.82rem; font-family:inherit; background:#fff; color:#1a1208; min-width:0; }
        .lo-search { margin:.75rem 1.25rem; width:calc(100% - 2.5rem); box-sizing:border-box; }

        .lo-scroll { max-height:380px; overflow-y:auto; }
        .lo-pick { display:flex; gap:10px; align-items:flex-start; padding:9px 1.25rem; border-bottom:1px solid rgba(26,18,8,.06); cursor:pointer; }
        .lo-pick:hover { background:#fff8f4; }
        .lo-pick input { margin-top:3px; accent-color:#c2410c; }
        .lo-pick-name { display:block; font-size:.85rem; font-weight:500; }
        .lo-pick-meta { display:block; font-size:.72rem; color:#9ca3af; margin-top:2px; }
        .lo-run { padding:1rem 1.25rem; border-top:1px solid rgba(26,18,8,.08); display:grid; gap:.5rem; }

        .lo-kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:.75rem; padding:1.25rem; }
        .lo-kpi { background:#faf7f3; border:1px solid rgba(26,18,8,.08); border-radius:10px; padding:.85rem 1rem; }
        .lo-kpi--accent { background:#fff5ee; border-color:rgba(194,65,12,.25); }
        .lo-kpi-label { font-size:.72rem; font-weight:600; color:#9ca3af; margin:0 0 4px; }
        .lo-kpi-value { font-size:1.35rem; font-weight:700; line-height:1.1; margin:0; }
        .lo-kpi--accent .lo-kpi-value { color:#c2410c; }
        .lo-kpi-sub { font-size:.7rem; color:#9ca3af; margin:3px 0 0; }

        .lo-section { padding:0 1.25rem 1.25rem; }
        .lo-h { font-size:.82rem; font-weight:600; margin:0 0 .5rem; }
        .lo-note { font-size:.78rem; color:#6b7280; margin:0 0 .75rem; line-height:1.5; }
        .lo-table-wrap { overflow-x:auto; }
        .lo-table { width:100%; border-collapse:collapse; font-size:.82rem; }
        .lo-table th, .lo-table td { text-align:left; padding:9px 1.25rem; border-bottom:1px solid rgba(26,18,8,.06); white-space:nowrap; }
        .lo-table th { font-size:.75rem; font-weight:600; color:#6b7280; }
        .lo-table tbody tr:hover { background:#fff8f4; }
        .lo-matrix { border:1px solid rgba(26,18,8,.08); border-radius:10px; border-collapse:separate; border-spacing:0; overflow:hidden; }
        .lo-matrix th, .lo-matrix td { padding:8px 12px; }
        .lo-self { color:#9ca3af; background:#faf7f3; }
        .lo-pct { color:#9ca3af; font-size:.72rem; }

        .lo-chip { display:inline-flex; align-items:center; gap:5px; font-size:.72rem; padding:2px 8px; border-radius:99px; background:#faf7f3; border:1px solid rgba(26,18,8,.1); margin-right:4px; }
        .lo-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
        .lo-count { font-weight:700; }
        .lo-count--max { color:#c2410c; }

        .lo-filters { display:flex; gap:.5rem; flex-wrap:wrap; align-items:center; padding:.75rem 1.25rem; border-top:1px solid rgba(26,18,8,.08); border-bottom:1px solid rgba(26,18,8,.08); }
        .lo-foot { display:flex; justify-content:space-between; align-items:center; padding:.75rem 1.25rem; gap:.5rem; flex-wrap:wrap; }
        .lo-pager { display:flex; align-items:center; gap:8px; }
        .lo-bar { height:3px; background:#f3ede3; overflow:hidden; }
        .lo-bar > span { display:block; height:100%; width:40%; background:#c2410c; animation:lo-slide 1.1s infinite ease-in-out; }
        @keyframes lo-slide { from { transform:translateX(-100%); } to { transform:translateX(350%); } }
        @media (prefers-reduced-motion: reduce) { .lo-bar > span { animation:none; width:100%; } }
        .lo-progress { padding:1.5rem 1.25rem; display:grid; gap:.9rem; }
        .lo-prog-row { display:grid; grid-template-columns:minmax(80px,160px) 1fr minmax(110px,auto); gap:.75rem; align-items:center; font-size:.82rem; }
        .lo-prog-name { font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .lo-prog-track { height:6px; background:#f3ede3; border-radius:99px; overflow:hidden; }
        .lo-prog-fill { height:100%; background:#c2410c; border-radius:99px; transition:width .3s ease; }
        @media (prefers-reduced-motion: reduce) { .lo-prog-fill { transition:none; } }
        .lo-error { background:#fef2f2; border:1px solid #fca5a5; color:#991b1b; border-radius:10px; padding:.75rem 1rem; font-size:.82rem; margin-bottom:1rem; }
        .lo-empty { padding:2rem 1.25rem; text-align:center; color:#9ca3af; font-size:.85rem; }
      `}</style>

      <div className="lo">
        <h1 className="lo-title">List overlap</h1>
        <p className="lo-lede">
          Pick the lists you send to and see who is on more than one. Only active subscribers are
          compared, since unsubscribed and bounced contacts are not emailed.
        </p>

        {error && <div className="lo-error" role="alert">{error}</div>}

        <div className="lo-grid">
          {/* ── list picker ── */}
          <div className="lo-panel">
            <div className="lo-panel-head">
              <p className="lo-panel-title">Lists to compare</p>
              <button
                className="lo-btn"
                disabled={listsLoading}
                onClick={() => { clearContactCache(); loadLists(); }}
              >
                {listsLoading ? "Loading…" : "Refresh"}
              </button>
            </div>
            <input
              className="lo-input lo-search"
              type="search"
              placeholder="Search lists"
              aria-label="Search lists"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="lo-scroll">
              {listsLoading && lists.length === 0 ? (
                <div className="lo-empty">Loading lists…</div>
              ) : visibleLists.length === 0 ? (
                <div className="lo-empty">No lists match your search.</div>
              ) : (
                visibleLists.map((l) => (
                  <label key={l.key} className="lo-pick">
                    <input type="checkbox" checked={selected.has(l.key)} onChange={() => toggle(l.key)} />
                    <span>
                      <span className="lo-pick-name">{l.name}</span>
                      <span className="lo-pick-meta">{fmt(l.contacts)} contacts</span>
                    </span>
                  </label>
                ))
              )}
            </div>
            <div className="lo-run">
              <button
                className="lo-btn lo-btn--solid"
                disabled={selected.size < 2 || running}
                onClick={() => compare(false)}
              >
                {running ? "Comparing…" : `Compare ${selected.size} list${selected.size === 1 ? "" : "s"}`}
              </button>
              <span className="lo-muted">
                {selected.size < 2
                  ? "Select at least two lists."
                  : `About ${fmt(selectedTotal)} contacts will be fetched.`}
              </span>
            </div>
          </div>

          {/* ── results ── */}
          <div className="lo-panel">
            {running && <div className="lo-bar" role="progressbar" aria-label="Loading contacts"><span /></div>}

            {running && progress ? (
              <div className="lo-progress">
                {Object.entries(progress).map(([key, p]) => {
                  const pct = p.done ? 100 : p.expected ? Math.min(99, (p.rows / p.expected) * 100) : 0;
                  return (
                    <div key={key} className="lo-prog-row">
                      <span className="lo-prog-name">{p.name}</span>
                      <div className="lo-prog-track">
                        <div className="lo-prog-fill" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="lo-muted">
                        {p.done ? `${fmt(p.rows)} loaded` : `${fmt(p.rows)} of up to ${fmt(p.expected)}`}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : !analysis ? (
              <div className="lo-empty">Choose two or more lists and select Compare.</div>
            ) : (
              <>
                <div className="lo-panel-head">
                  <p className="lo-panel-title">
                    {result.lists.map((l) => l.name).join(", ")}
                  </p>
                  <div className="lo-pager">
                    <span className="lo-muted">
                      {result.cached ? "From cache" : `Loaded in ${(result.tookMs / 1000).toFixed(1)}s`}
                    </span>
                    <button className="lo-btn" onClick={() => compare(true)}>Fetch fresh data</button>
                  </div>
                </div>

                <div className="lo-kpis">
                  <div className="lo-kpi">
                    <p className="lo-kpi-label">Unique active contacts</p>
                    <p className="lo-kpi-value">{fmt(analysis.unique)}</p>
                  </div>
                  <div className="lo-kpi lo-kpi--accent">
                    <p className="lo-kpi-label">On 2 or more lists</p>
                    <p className="lo-kpi-value">{fmt(analysis.overlapping)}</p>
                    <p className="lo-kpi-sub">
                      {analysis.unique ? ((analysis.overlapping / analysis.unique) * 100).toFixed(1) : 0}% of contacts
                    </p>
                  </div>
                  {N > 2 && (
                    <div className="lo-kpi lo-kpi--accent">
                      <p className="lo-kpi-label">On all {N} lists</p>
                      <p className="lo-kpi-value">{fmt(analysis.inAll)}</p>
                    </div>
                  )}
                </div>

                <div className="lo-section">
                  <p className="lo-h">Shared contacts between lists</p>
                  <p className="lo-note">
                    Read each row as: of this list's active contacts, how many are also on the list in the column.
                  </p>
                  <div className="lo-table-wrap">
                    <table className="lo-table lo-matrix">
                      <thead>
                        <tr>
                          <th scope="col"><span className="lo-muted">List</span></th>
                          {result.lists.map((l) => (
                            <th key={l.key} scope="col">
                              <span className="lo-chip"><span className="lo-dot" style={{ background: l.color }} />{l.name}</span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {result.lists.map((a) => {
                          const size = result.data[a.key].length;
                          return (
                            <tr key={a.key}>
                              <th scope="row">
                                <span className="lo-chip"><span className="lo-dot" style={{ background: a.color }} />{a.name}</span>
                              </th>
                              {result.lists.map((b) => {
                                if (a.key === b.key) return <td key={b.key} className="lo-self">{fmt(size)} active</td>;
                                const n = analysis.pair[a.key][b.key];
                                return (
                                  <td key={b.key}>
                                    {fmt(n)} <span className="lo-pct">({size ? ((n / size) * 100).toFixed(1) : 0}%)</span>
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="lo-filters">
                  <input
                    className="lo-input"
                    type="search"
                    placeholder="Search name or email"
                    aria-label="Search name or email"
                    value={filters.q}
                    onChange={(e) => setFilter({ q: e.target.value })}
                  />
                  <select
                    className="lo-input"
                    aria-label="Minimum number of lists"
                    value={filters.minLists}
                    onChange={(e) => setFilter({ minLists: parseInt(e.target.value, 10) })}
                  >
                    {Array.from({ length: N - 1 }, (_, i) => i + 2).map((n) => (
                      <option key={n} value={n}>{n === N ? `On all ${n} lists` : `On ${n} or more lists`}</option>
                    ))}
                  </select>
                  <select
                    className="lo-input"
                    aria-label="Must be on list"
                    value={filters.mustInclude}
                    onChange={(e) => setFilter({ mustInclude: e.target.value })}
                  >
                    <option value="">Any list</option>
                    {result.lists.map((l) => (
                      <option key={l.key} value={l.key}>Must be on {l.name}</option>
                    ))}
                  </select>
                  <button className="lo-btn" disabled={!rowsAll.length} onClick={exportCsv}>
                    Export {rowsAll.length ? fmt(rowsAll.length) : ""} to CSV
                  </button>
                </div>

                {rowsAll.length === 0 ? (
                  <div className="lo-empty">
                    {analysis.overlapping === 0
                      ? "No contact is on more than one of these lists."
                      : "No contacts match these filters."}
                  </div>
                ) : (
                  <>
                    <div className="lo-table-wrap">
                      <table className="lo-table">
                        <thead>
                          <tr>
                            <th scope="col">Email</th>
                            <th scope="col">Name</th>
                            <th scope="col">Company</th>
                            <th scope="col">Lists</th>
                            <th scope="col">Count</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pageRows.map((c) => (
                            <tr key={c.email}>
                              <td>{c.email}</td>
                              <td>{fullName(c) || "—"}</td>
                              <td>{c.company || "—"}</td>
                              <td>
                                {c.listKeys.map((k) => (
                                  <span key={k} className="lo-chip">
                                    <span className="lo-dot" style={{ background: analysis.colorOf[k] }} />
                                    {analysis.nameOf[k]}
                                  </span>
                                ))}
                              </td>
                              <td className={`lo-count ${c.listKeys.length === N && N > 2 ? "lo-count--max" : ""}`}>
                                {c.listKeys.length}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="lo-foot">
                      <span className="lo-muted">
                        {fmt(rowsAll.length)} contact{rowsAll.length === 1 ? "" : "s"} shown
                      </span>
                      <div className="lo-pager">
                        <button className="lo-btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</button>
                        <span className="lo-muted">Page {page + 1} of {pageCount}</span>
                        <button className="lo-btn" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>Next</button>
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}