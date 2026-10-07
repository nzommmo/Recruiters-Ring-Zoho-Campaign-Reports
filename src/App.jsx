import React, { useState } from "react";
import ZohoCampaignsDashboard from "./components/ZohoCampaignsDashboard";
import ListsContactsPanel from "./components/ListsContactsPanel";
import ListOverlapPanel from "./components/ListOverlapPanel";

const TABS = [
  ["campaigns", "Campaigns"],
  ["lists", "Lists and contacts"],
  ["overlap", "List overlap"],
];

const VIEWS = {
  campaigns: ZohoCampaignsDashboard,
  lists: ListsContactsPanel,
  overlap: ListOverlapPanel,
};

const App = () => {
  const [tab, setTab] = useState("campaigns");
  const View = VIEWS[tab];

  return (
    <>
      <style>{`
        .app-tabs { display:flex; gap:4px; margin-bottom:1.25rem; border-bottom:1px solid rgba(26,18,8,.1); flex-wrap:wrap; }
        .app-tab { background:none; border:none; border-bottom:2px solid transparent; padding:8px 14px; font:500 .85rem 'DM Sans', system-ui, sans-serif; color:#6b7280; cursor:pointer; margin-bottom:-1px; }
        .app-tab[aria-selected="true"] { color:#c2410c; border-bottom-color:#c2410c; }
        .app-tab:focus-visible { outline:2px solid #c2410c; outline-offset:2px; }
      `}</style>

      <div role="tablist" className="app-tabs">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            className="app-tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <View />
    </>
  );
};

export default App;