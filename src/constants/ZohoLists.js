// Helpers for Zoho Campaigns list and subscriber responses.
// ListsContactsPanel.jsx has its own copies of these; it can import from here later if you
// want to remove the duplication.

// The JSON envelope key is not documented as clearly as the XML one, so we try the
// likely keys and fall back to the first array in the response.
export const firstArray = (data, keys) => {
  for (const k of keys) if (Array.isArray(data?.[k])) return data[k];
  return (data && Object.values(data).find(Array.isArray)) || [];
};

export const extractLists = (d) => firstArray(d, ["list_of_details", "lists"]);
export const extractContacts = (d) =>
  firstArray(d, ["list_of_details", "result_of_subscribers", "contacts", "subscribers"]);

export const normList = (l) => ({
  key: l.listkey,
  name: l.listname || "(unnamed)",
  contacts: parseInt(l.noofcontacts, 10) || 0,
  unsubs: parseInt(l.noofunsubcnt, 10) || 0,
  bounces: parseInt(l.noofbouncecnt, 10) || 0,
  owner: l.owner || "",
  isPublic: String(l.is_public) === "true",
  created: l.created_date ? new Date(parseInt(l.created_date, 10)) : null,
});

export const normContact = (c) => {
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

export const fullName = (c) => [c.firstname, c.lastname].filter(Boolean).join(" ");
export const fmt = (n) => (n == null ? "—" : n.toLocaleString());

// Cells starting with = + - @ can execute as formulas when the CSV is opened in Excel.
export const csvCell = (v) => {
  let s = String(v ?? "");
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
};

export function downloadCsv(filename, header, rows) {
  const lines = rows.map((r) => r.map(csvCell).join(","));
  const blob = new Blob([[header.map(csvCell).join(","), ...lines].join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}