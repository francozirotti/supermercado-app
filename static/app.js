const state = {
  users: [],
  currentTicket: null, // ticket recién creado, en revisión
};

// ---------- Utilidades ----------

function euros(n) {
  return `${Number(n).toFixed(2)}€`;
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try {
      const body = await res.json();
      msg = body.error || msg;
    } catch (_) {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------- Tabs ----------

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");

    if (btn.dataset.tab === "tickets") loadTickets();
    if (btn.dataset.tab === "resumen") loadSummary();
  });
});

// ---------- Usuarios ----------

async function loadUsers() {
  state.users = await api("/api/users");
  const select = document.getElementById("owner-select");
  select.innerHTML = "";
  if (state.users.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "Agrega una persona primero";
    opt.disabled = true;
    opt.selected = true;
    select.appendChild(opt);
  } else {
    state.users.forEach((u) => {
      const opt = document.createElement("option");
      opt.value = u.id;
      opt.textContent = u.name;
      select.appendChild(opt);
    });
  }
  updateUploadButtonState();
}

document.getElementById("btn-new-user").addEventListener("click", async () => {
  const name = prompt("Nombre de la nueva persona:");
  if (!name || !name.trim()) return;
  await api("/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() }),
  });
  await loadUsers();
  const select = document.getElementById("owner-select");
  const created = state.users.find((u) => u.name === name.trim());
  if (created) select.value = created.id;
});

// ---------- Subir ticket ----------

const fileInput = document.getElementById("ticket-file");
const uploadBtn = document.getElementById("btn-upload");
const ownerSelect = document.getElementById("owner-select");
const uploadStatus = document.getElementById("upload-status");

function updateUploadButtonState() {
  uploadBtn.disabled = !(fileInput.files.length > 0 && ownerSelect.value);
}

fileInput.addEventListener("change", updateUploadButtonState);
ownerSelect.addEventListener("change", updateUploadButtonState);

uploadBtn.addEventListener("click", async () => {
  const file = fileInput.files[0];
  const ownerId = ownerSelect.value;
  if (!file || !ownerId) return;

  uploadBtn.disabled = true;
  uploadStatus.textContent = "Leyendo ticket con IA… esto puede tardar unos segundos.";
  document.getElementById("review-card").classList.add("hidden");

  const formData = new FormData();
  formData.append("image", file);
  formData.append("owner_id", ownerId);

  try {
    const ticket = await api("/api/tickets", { method: "POST", body: formData });
    state.currentTicket = ticket;
    uploadStatus.textContent = `Ticket leído: ${ticket.items.length} ítems detectados.`;
    renderReview(ticket);
  } catch (err) {
    uploadStatus.textContent = `❌ ${err.message}`;
  } finally {
    updateUploadButtonState();
  }
});

function renderReview(ticket) {
  const card = document.getElementById("review-card");
  card.classList.remove("hidden");
  const tbody = document.getElementById("review-items-body");
  tbody.innerHTML = "";
  ticket.items.forEach((item) => tbody.appendChild(renderItemRow(item)));
  updateReviewTotals(ticket);
}

function renderItemRow(item) {
  const tr = document.createElement("tr");
  tr.dataset.itemId = item.id;
  if (!item.included) tr.classList.add("excluded");

  const tdCheck = document.createElement("td");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = item.included;
  checkbox.addEventListener("change", async () => {
    tr.classList.toggle("excluded", !checkbox.checked);
    await saveItemChange(item.id, { included: checkbox.checked }, tr);
  });
  tdCheck.appendChild(checkbox);

  const tdName = document.createElement("td");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = item.name;
  nameInput.addEventListener("change", () =>
    saveItemChange(item.id, { name: nameInput.value }, tr)
  );
  tdName.appendChild(nameInput);

  const tdPrice = document.createElement("td");
  const priceInput = document.createElement("input");
  priceInput.type = "number";
  priceInput.step = "0.01";
  priceInput.value = item.price;
  priceInput.addEventListener("change", () =>
    saveItemChange(item.id, { price: parseFloat(priceInput.value) || 0 }, tr)
  );
  tdPrice.appendChild(priceInput);

  const tdDelete = document.createElement("td");
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "btn-danger";
  delBtn.textContent = "✕";
  delBtn.addEventListener("click", async () => {
    await api(`/api/items/${item.id}`, { method: "DELETE" });
    tr.remove();
    recalcReviewTotalsFromDOM();
  });
  tdDelete.appendChild(delBtn);

  tr.append(tdCheck, tdName, tdPrice, tdDelete);
  return tr;
}

async function saveItemChange(itemId, patch, rowEl) {
  const row = rowEl;
  const currentIncluded = !row.classList.contains("excluded");
  const name = row.querySelector('input[type="text"]').value;
  const price = parseFloat(row.querySelector('input[type="number"]').value) || 0;
  const included = "included" in patch ? patch.included : currentIncluded;

  const updated = await api(`/api/items/${itemId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, price, included }),
  });
  recalcReviewTotalsFromDOM();
  return updated;
}

function recalcReviewTotalsFromDOM() {
  const rows = document.querySelectorAll("#review-items-body tr");
  let totalTicket = 0;
  let totalIncluido = 0;
  rows.forEach((row) => {
    const price = parseFloat(row.querySelector('input[type="number"]').value) || 0;
    const included = row.querySelector('input[type="checkbox"]').checked;
    totalTicket += price;
    if (included) totalIncluido += price;
  });
  document.getElementById("review-total-ticket").textContent = euros(totalTicket);
  document.getElementById("review-total-incluido").textContent = euros(totalIncluido);
}

function updateReviewTotals(ticket) {
  document.getElementById("review-total-ticket").textContent = euros(ticket.total_ticket);
  document.getElementById("review-total-incluido").textContent = euros(ticket.total_incluido);
}

document.getElementById("btn-add-item").addEventListener("click", async () => {
  if (!state.currentTicket) return;
  const name = prompt("Nombre del producto:");
  if (!name || !name.trim()) return;
  const priceStr = prompt("Precio (€):", "0.00");
  const price = parseFloat(priceStr);
  if (isNaN(price)) return;

  const item = await api(`/api/tickets/${state.currentTicket.id}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim(), price }),
  });
  document.getElementById("review-items-body").appendChild(renderItemRow(item));
  recalcReviewTotalsFromDOM();
});

// ---------- Tickets (listado) ----------

async function loadTickets() {
  const container = document.getElementById("tickets-list");
  container.innerHTML = "<p class='empty-state'>Cargando…</p>";
  const tickets = await api("/api/tickets");
  if (tickets.length === 0) {
    container.innerHTML = "<p class='empty-state'>Todavía no hay tickets subidos.</p>";
    return;
  }
  container.innerHTML = "";
  tickets.forEach((ticket) => container.appendChild(renderTicketBlock(ticket)));
}

function renderTicketBlock(ticket) {
  const block = document.createElement("div");
  block.className = "ticket-block";

  const header = document.createElement("div");
  header.className = "ticket-block-header";
  header.innerHTML = `
    <div>
      <div class="owner">${ticket.owner_name || "?"}</div>
      <div class="meta">${ticket.store || "Ticket"} · ${ticket.ticket_date || ""} · ${ticket.items.length} ítems</div>
    </div>
    <div class="meta">Común: ${euros(ticket.total_incluido)} / Total: ${euros(ticket.total_ticket)}</div>
  `;

  const body = document.createElement("div");
  body.className = "hidden";

  const table = document.createElement("table");
  table.className = "items-table";
  table.innerHTML = "<thead><tr><th></th><th>Producto</th><th>Precio (€)</th><th></th></tr></thead>";
  const tbody = document.createElement("tbody");
  ticket.items.forEach((item) => tbody.appendChild(renderItemRow(item)));
  table.appendChild(tbody);

  const delTicketBtn = document.createElement("button");
  delTicketBtn.className = "btn-secondary";
  delTicketBtn.type = "button";
  delTicketBtn.textContent = "Eliminar ticket completo";
  delTicketBtn.style.marginTop = "10px";
  delTicketBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm("¿Eliminar este ticket y todos sus ítems?")) return;
    await api(`/api/tickets/${ticket.id}`, { method: "DELETE" });
    block.remove();
  });

  body.appendChild(table);
  body.appendChild(delTicketBtn);

  header.addEventListener("click", () => body.classList.toggle("hidden"));

  block.appendChild(header);
  block.appendChild(body);
  return block;
}

document.getElementById("btn-refresh-tickets").addEventListener("click", loadTickets);

// ---------- Resumen ----------

async function loadSummary() {
  const container = document.getElementById("summary-content");
  container.innerHTML = "<p class='empty-state'>Calculando…</p>";
  const summary = await api("/api/summary");

  if (summary.balances.length === 0) {
    container.innerHTML = "<p class='empty-state'>Agrega personas y tickets para ver el resumen.</p>";
    return;
  }

  let html = `<p class="hint">Total gastado en la cuenta común: <strong>${euros(summary.total_shared)}</strong> · Parte justa por persona: <strong>${euros(summary.fair_share)}</strong></p>`;

  html += `<table class="summary-table"><thead><tr><th>Persona</th><th>Pagó</th><th>Balance</th></tr></thead><tbody>`;
  summary.balances.forEach((b) => {
    const cls = b.balance > 0 ? "balance-positive" : b.balance < 0 ? "balance-negative" : "";
    const label = b.balance > 0 ? `le deben ${euros(b.balance)}` : b.balance < 0 ? `debe ${euros(Math.abs(b.balance))}` : "está a la par";
    html += `<tr><td>${b.name}</td><td>${euros(b.paid)}</td><td class="${cls}">${label}</td></tr>`;
  });
  html += `</tbody></table>`;

  html += `<h3 style="margin-top:18px;">Pagos para quedar parejos</h3>`;
  if (summary.settlements.length === 0) {
    html += `<p class="empty-state">Nadie le debe nada a nadie. 🎉</p>`;
  } else {
    summary.settlements.forEach((s) => {
      html += `<div class="settlement-item"><strong>${s.from}</strong> le paga <strong>${euros(s.amount)}</strong> a <strong>${s.to}</strong></div>`;
    });
  }

  container.innerHTML = html;
}

document.getElementById("btn-refresh-summary").addEventListener("click", loadSummary);

// ---------- Init ----------

loadUsers();
