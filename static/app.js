const state = {
  users: [],
  review: null, // { file, store, date, items: [{localId, name, price, included}] }
  reviewNextLocalId: 1,
};

// ---------- Utilidades ----------

function euros(n) {
  return `${Number(n).toFixed(2)}€`;
}

function formatDateTime(isoLike) {
  if (!isoLike) return "";
  const d = new Date(isoLike.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return isoLike;
  return d.toLocaleString("es-ES", { dateStyle: "medium", timeStyle: "short" });
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
    if (btn.dataset.tab === "historico") loadHistory();
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

// ---------- Subir ticket: selección de archivo ----------

const fileInput = document.getElementById("ticket-file");
const uploadBtn = document.getElementById("btn-upload");
const ownerSelect = document.getElementById("owner-select");
const uploadStatus = document.getElementById("upload-status");
const fileNameDisplay = document.getElementById("file-name-display");

function updateUploadButtonState() {
  uploadBtn.disabled = !(fileInput.files.length > 0 && ownerSelect.value);
}

fileInput.addEventListener("change", () => {
  fileNameDisplay.textContent = fileInput.files.length
    ? `📎 ${fileInput.files[0].name}`
    : "";
  updateUploadButtonState();
});
ownerSelect.addEventListener("change", updateUploadButtonState);

// ---------- Leer ticket (vista previa, no guarda nada todavía) ----------

uploadBtn.addEventListener("click", async () => {
  const file = fileInput.files[0];
  const ownerId = ownerSelect.value;
  if (!file || !ownerId) return;

  if (state.review && state.review.items.length > 0) {
    if (!confirm("Tienes una revisión sin guardar. ¿Descartarla y leer este ticket nuevo?")) {
      return;
    }
  }

  uploadBtn.disabled = true;
  uploadStatus.textContent = "Leyendo ticket con IA… esto puede tardar unos segundos.";
  document.getElementById("review-card").classList.add("hidden");

  const formData = new FormData();
  formData.append("image", file);

  try {
    const preview = await api("/api/ocr/preview", { method: "POST", body: formData });
    state.review = {
      file,
      store: preview.store || null,
      date: preview.date || null,
      items: preview.items.map((it) => ({
        localId: state.reviewNextLocalId++,
        name: it.name,
        price: it.price,
        included: true,
      })),
    };
    uploadStatus.textContent = `Ticket leído: ${state.review.items.length} ítems detectados. Revísalos abajo.`;
    renderReview();
  } catch (err) {
    uploadStatus.textContent = `❌ ${err.message}`;
  } finally {
    updateUploadButtonState();
  }
});

// ---------- Vista previa editable (todo en memoria, nada persistido) ----------

function renderReview() {
  const card = document.getElementById("review-card");
  card.classList.remove("hidden");
  const tbody = document.getElementById("review-items-body");
  tbody.innerHTML = "";
  state.review.items.forEach((item) => tbody.appendChild(renderReviewRow(item)));
  recalcReviewTotals();
  document.getElementById("create-status").textContent = "";
}

function renderReviewRow(item) {
  const tr = document.createElement("tr");
  tr.dataset.localId = item.localId;
  if (!item.included) tr.classList.add("excluded");

  const tdCheck = document.createElement("td");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = item.included;
  checkbox.addEventListener("change", () => {
    item.included = checkbox.checked;
    tr.classList.toggle("excluded", !checkbox.checked);
    recalcReviewTotals();
  });
  tdCheck.appendChild(checkbox);

  const tdName = document.createElement("td");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = item.name;
  nameInput.addEventListener("change", () => {
    item.name = nameInput.value;
  });
  tdName.appendChild(nameInput);

  const tdPrice = document.createElement("td");
  const priceInput = document.createElement("input");
  priceInput.type = "number";
  priceInput.step = "0.01";
  priceInput.value = item.price;
  priceInput.addEventListener("change", () => {
    item.price = parseFloat(priceInput.value) || 0;
    recalcReviewTotals();
  });
  tdPrice.appendChild(priceInput);

  const tdDelete = document.createElement("td");
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "btn-danger";
  delBtn.textContent = "✕";
  delBtn.addEventListener("click", () => {
    state.review.items = state.review.items.filter((i) => i.localId !== item.localId);
    tr.remove();
    recalcReviewTotals();
  });
  tdDelete.appendChild(delBtn);

  tr.append(tdCheck, tdName, tdPrice, tdDelete);
  return tr;
}

function recalcReviewTotals() {
  if (!state.review) return;
  let totalTicket = 0;
  let totalIncluido = 0;
  state.review.items.forEach((item) => {
    totalTicket += item.price;
    if (item.included) totalIncluido += item.price;
  });
  document.getElementById("review-total-ticket").textContent = euros(totalTicket);
  document.getElementById("review-total-incluido").textContent = euros(totalIncluido);
}

document.getElementById("btn-add-item").addEventListener("click", () => {
  if (!state.review) return;
  const name = prompt("Nombre del producto:");
  if (!name || !name.trim()) return;
  const priceStr = prompt("Precio (€):", "0.00");
  const price = parseFloat(priceStr);
  if (isNaN(price)) return;

  const item = { localId: state.reviewNextLocalId++, name: name.trim(), price, included: true };
  state.review.items.push(item);
  document.getElementById("review-items-body").appendChild(renderReviewRow(item));
  recalcReviewTotals();
});

// ---------- Crear ticket (recién ahí se guarda de verdad) ----------

document.getElementById("btn-create-ticket").addEventListener("click", async () => {
  const createStatus = document.getElementById("create-status");
  const ownerId = ownerSelect.value;

  if (!ownerId) {
    createStatus.textContent = "❌ Falta elegir de quién es el ticket.";
    return;
  }
  if (!state.review || state.review.items.length === 0) {
    createStatus.textContent = "❌ El ticket necesita al menos un ítem.";
    return;
  }

  const formData = new FormData();
  formData.append("owner_id", ownerId);
  if (state.review.store) formData.append("store", state.review.store);
  if (state.review.date) formData.append("ticket_date", state.review.date);
  formData.append(
    "items",
    JSON.stringify(
      state.review.items.map((i) => ({ name: i.name, price: i.price, included: i.included }))
    )
  );
  if (state.review.file) formData.append("image", state.review.file);

  createStatus.textContent = "Creando ticket…";
  try {
    await api("/api/tickets", { method: "POST", body: formData });
    createStatus.textContent = "✅ Ticket creado.";
    resetUploadForm();
  } catch (err) {
    createStatus.textContent = `❌ ${err.message}`;
  }
});

function resetUploadForm() {
  state.review = null;
  fileInput.value = "";
  fileNameDisplay.textContent = "";
  uploadStatus.textContent = "";
  document.getElementById("review-card").classList.add("hidden");
  document.getElementById("review-items-body").innerHTML = "";
  updateUploadButtonState();
}

// ---------- Ticket sin respaldo (sin foto) ----------

const manualForm = document.getElementById("manual-ticket-form");

document.getElementById("btn-toggle-manual").addEventListener("click", () => {
  manualForm.classList.toggle("hidden");
});

document.getElementById("btn-manual-create").addEventListener("click", async () => {
  const manualStatus = document.getElementById("manual-status");
  const ownerId = ownerSelect.value;
  const desc = document.getElementById("manual-desc").value.trim() || "Compra sin ticket";
  const amount = parseFloat(document.getElementById("manual-amount").value);

  if (!ownerId) {
    manualStatus.textContent = "❌ Falta elegir de quién es el gasto.";
    return;
  }
  if (isNaN(amount) || amount <= 0) {
    manualStatus.textContent = "❌ Ingresa un monto válido.";
    return;
  }

  const formData = new FormData();
  formData.append("owner_id", ownerId);
  formData.append("items", JSON.stringify([{ name: desc, price: amount, included: true }]));

  manualStatus.textContent = "Creando…";
  try {
    await api("/api/tickets", { method: "POST", body: formData });
    manualStatus.textContent = "✅ Ticket sin respaldo creado.";
    document.getElementById("manual-desc").value = "";
    document.getElementById("manual-amount").value = "";
  } catch (err) {
    manualStatus.textContent = `❌ ${err.message}`;
  }
});

// ---------- Tickets activos (listado, con edición en vivo) ----------

async function loadTickets() {
  const container = document.getElementById("tickets-list");
  container.innerHTML = "<p class='empty-state'>Cargando…</p>";
  try {
    const tickets = await api("/api/tickets");
    if (tickets.length === 0) {
      container.innerHTML = "<p class='empty-state'>No hay tickets activos todavía.</p>";
      return;
    }
    container.innerHTML = "";
    tickets.forEach((ticket) => container.appendChild(renderTicketBlock(ticket)));
  } catch (err) {
    container.innerHTML = `<p class="empty-state">❌ Error cargando tickets: ${err.message}</p>`;
  }
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
  ticket.items.forEach((item) => tbody.appendChild(renderPersistedItemRow(item)));
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

// Fila de ítem de un ticket YA GUARDADO: cada cambio se guarda al instante.
function renderPersistedItemRow(item) {
  const tr = document.createElement("tr");
  tr.dataset.itemId = item.id;
  if (!item.included) tr.classList.add("excluded");

  const tdCheck = document.createElement("td");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = item.included;
  checkbox.addEventListener("change", async () => {
    tr.classList.toggle("excluded", !checkbox.checked);
    await savePersistedItemChange(item.id, { included: checkbox.checked }, tr);
  });
  tdCheck.appendChild(checkbox);

  const tdName = document.createElement("td");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = item.name;
  nameInput.addEventListener("change", () =>
    savePersistedItemChange(item.id, { name: nameInput.value }, tr)
  );
  tdName.appendChild(nameInput);

  const tdPrice = document.createElement("td");
  const priceInput = document.createElement("input");
  priceInput.type = "number";
  priceInput.step = "0.01";
  priceInput.value = item.price;
  priceInput.addEventListener("change", () =>
    savePersistedItemChange(item.id, { price: parseFloat(priceInput.value) || 0 }, tr)
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
  });
  tdDelete.appendChild(delBtn);

  tr.append(tdCheck, tdName, tdPrice, tdDelete);
  return tr;
}

async function savePersistedItemChange(itemId, patch, rowEl) {
  const row = rowEl;
  const currentIncluded = !row.classList.contains("excluded");
  const name = row.querySelector('input[type="text"]').value;
  const price = parseFloat(row.querySelector('input[type="number"]').value) || 0;
  const included = "included" in patch ? patch.included : currentIncluded;

  return api(`/api/items/${itemId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, price, included }),
  });
}

document.getElementById("btn-refresh-tickets").addEventListener("click", loadTickets);

// ---------- Resumen ----------

function renderSummaryHtml(summary) {
  let html = `<div class="summary-total-label">Total en cuenta común</div>`;
  html += `<div class="summary-total-value">${euros(summary.total_shared)}</div>`;
  html += `<div class="summary-total-sub">${euros(summary.fair_share)} por persona</div>`;

  html += `<table class="summary-table"><thead><tr><th>Persona</th><th>Pagó</th><th>Balance</th></tr></thead><tbody>`;
  summary.balances.forEach((b) => {
    const cls = b.balance > 0 ? "balance-positive" : b.balance < 0 ? "balance-negative" : "";
    const label = b.balance > 0 ? `le deben ${euros(b.balance)}` : b.balance < 0 ? `debe ${euros(Math.abs(b.balance))}` : "está a la par";
    html += `<tr><td>${b.name}</td><td>pagó ${euros(b.paid)}</td><td class="${cls}">${label}</td></tr>`;
  });
  html += `</tbody></table>`;

  html += `<div class="settlements-label">Pagos para quedar parejos</div>`;
  if (summary.settlements.length === 0) {
    html += `<p class="empty-state">Nadie le debe nada a nadie.</p>`;
  } else {
    summary.settlements.forEach((s) => {
      html += `<div class="settlement-item"><strong>${s.from}</strong> → <strong>${s.to}</strong> · ${euros(s.amount)}</div>`;
    });
  }
  return html;
}

async function loadSummary() {
  const container = document.getElementById("summary-content");
  const resetBtn = document.getElementById("btn-close-settlement");
  container.innerHTML = "<p class='empty-state'>Calculando…</p>";
  document.getElementById("close-status").textContent = "";

  try {
    const summary = await api("/api/summary");

    if (summary.balances.length === 0) {
      container.innerHTML = "<p class='empty-state'>Agrega personas y tickets para ver el resumen.</p>";
      resetBtn.classList.add("hidden");
      return;
    }

    container.innerHTML = renderSummaryHtml(summary);
    resetBtn.classList.toggle("hidden", summary.total_shared <= 0);
  } catch (err) {
    container.innerHTML = `<p class="empty-state">❌ Error cargando el resumen: ${err.message}</p>`;
    resetBtn.classList.add("hidden");
  }
}

document.getElementById("btn-refresh-summary").addEventListener("click", loadSummary);

document.getElementById("btn-close-settlement").addEventListener("click", async () => {
  const closeStatus = document.getElementById("close-status");
  const confirmed = confirm(
    "¿Ya se hizo el pago entre todos según el resumen actual?\n\nEsto va a archivar los tickets actuales en el Histórico y el resumen quedará en cero para el próximo período."
  );
  if (!confirmed) return;

  closeStatus.textContent = "Repartiendo…";
  try {
    await api("/api/settlement/close", { method: "POST" });
    closeStatus.textContent = "✅ Listo, quedó guardado en el Histórico.";
    await loadSummary();
  } catch (err) {
    closeStatus.textContent = `❌ ${err.message}`;
  }
});

// ---------- Histórico ----------

async function loadHistory() {
  const container = document.getElementById("history-list");
  container.innerHTML = "<p class='empty-state'>Cargando…</p>";
  try {
    const periods = await api("/api/settlement/history");
    if (periods.length === 0) {
      container.innerHTML = "<p class='empty-state'>Todavía no se ha cerrado ningún reparto.</p>";
      return;
    }
    container.innerHTML = "";
    periods.forEach((period) => container.appendChild(renderHistoryBlock(period)));
  } catch (err) {
    container.innerHTML = `<p class="empty-state">❌ Error cargando el histórico: ${err.message}</p>`;
  }
}

function renderHistoryBlock(period) {
  const block = document.createElement("div");
  block.className = "history-block";

  const header = document.createElement("div");
  header.className = "history-block-header";
  header.innerHTML = `
    <div>
      <div class="date">${formatDateTime(period.closed_at)}</div>
      <div class="meta">Total repartido: ${euros(period.total_shared)} · Parte por persona: ${euros(period.fair_share)}</div>
    </div>
  `;

  const body = document.createElement("div");
  body.className = "hidden";
  body.innerHTML = renderSummaryHtml(period);

  const ticketsToggleBtn = document.createElement("button");
  ticketsToggleBtn.className = "btn-secondary";
  ticketsToggleBtn.type = "button";
  ticketsToggleBtn.textContent = "Ver tickets de este período";
  ticketsToggleBtn.style.marginTop = "10px";

  const ticketsContainer = document.createElement("div");
  ticketsContainer.className = "hidden";

  let loaded = false;
  ticketsToggleBtn.addEventListener("click", async () => {
    ticketsContainer.classList.toggle("hidden");
    if (!loaded && !ticketsContainer.classList.contains("hidden")) {
      loaded = true;
      ticketsContainer.innerHTML = "<p class='empty-state'>Cargando…</p>";
      const tickets = await api(`/api/tickets?period_id=${period.id}`);
      ticketsContainer.innerHTML = "";
      tickets.forEach((ticket) => ticketsContainer.appendChild(renderReadOnlyTicketBlock(ticket)));
    }
  });

  body.appendChild(ticketsToggleBtn);
  body.appendChild(ticketsContainer);

  header.addEventListener("click", () => body.classList.toggle("hidden"));

  block.appendChild(header);
  block.appendChild(body);
  return block;
}

function renderReadOnlyTicketBlock(ticket) {
  const div = document.createElement("div");
  div.className = "ticket-block";
  const rows = ticket.items
    .map(
      (i) =>
        `<div style="display:flex;justify-content:space-between;padding:3px 0;${i.included ? "" : "opacity:0.5;text-decoration:line-through;"}">
          <span>${i.name}</span><span>${euros(i.price)}</span>
        </div>`
    )
    .join("");
  div.innerHTML = `
    <div class="owner">${ticket.owner_name || "?"}</div>
    <div class="meta">${ticket.store || "Ticket"} · ${ticket.ticket_date || ""}</div>
    <div style="margin-top:6px;">${rows}</div>
  `;
  return div;
}

document.getElementById("btn-refresh-history").addEventListener("click", loadHistory);

// ---------- Init ----------

loadUsers();
