const MAX_COUNTER = 3;

const state = {
  clients: [],
  alerts: [],
  settings: {
    autoReset: {
      enabled: false,
      time: "09:00"
    }
  },
  dashboard: {
    totalClients: 0,
    importantClients: 0,
    averageCounter: 0,
    unreadAlerts: 0
  },
  meta: {
    onlineUsers: 0,
    autosaveError: null
  },
  ui: {
    search: "",
    city: "",
    department: "",
    sort: "name",
    importantOnly: false
  }
};

let stream = null;
let isApplyingRemoteState = false;

const els = {
  clientForm: document.getElementById("clientForm"),
  searchInput: document.getElementById("searchInput"),
  cityFilter: document.getElementById("cityFilter"),
  departmentFilter: document.getElementById("departmentFilter"),
  sortFilter: document.getElementById("sortFilter"),
  importantOnly: document.getElementById("importantOnly"),
  clientsList: document.getElementById("clientsList"),
  alertsList: document.getElementById("alertsList"),
  clientsCount: document.getElementById("clientsCount"),
  saveStatus: document.getElementById("saveStatus"),
  onlineUsers: document.getElementById("onlineUsers"),
  readAllAlerts: document.getElementById("readAllAlerts"),
  kpiTotal: document.getElementById("kpiTotal"),
  kpiImportant: document.getElementById("kpiImportant"),
  kpiAverage: document.getElementById("kpiAverage"),
  kpiAlerts: document.getElementById("kpiAlerts"),
  autoResetEnabled: document.getElementById("autoResetEnabled"),
  autoResetTime: document.getElementById("autoResetTime"),
  saveAutomation: document.getElementById("saveAutomation"),
  editDialog: document.getElementById("editDialog"),
  editForm: document.getElementById("editForm"),
  cancelEdit: document.getElementById("cancelEdit"),
  confirmDialog: document.getElementById("confirmDialog"),
  confirmTitle: document.getElementById("confirmTitle"),
  confirmMessage: document.getElementById("confirmMessage"),
  confirmCancel: document.getElementById("confirmCancel"),
  confirmAccept: document.getElementById("confirmAccept"),
  clientCardTemplate: document.getElementById("clientCardTemplate")
};

function setSaveStatus(type, text) {
  const mapping = {
    success: "chip success",
    warning: "chip warning",
    error: "chip error",
    neutral: "chip neutral"
  };
  els.saveStatus.className = mapping[type] || mapping.neutral;
  els.saveStatus.textContent = text;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "date inconnue";
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(date);
}

async function api(path, { method = "GET", body } = {}) {
  const isMutation = method !== "GET";
  if (isMutation) {
    setSaveStatus("warning", "Sauvegarde en cours...");
  }

  const response = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const message = payload.error || `Erreur HTTP ${response.status}`;
    throw new Error(message);
  }

  if (isMutation) {
    setSaveStatus("success", "Sauvegarde automatique active");
  }

  return payload;
}

function applyRemoteState(remote) {
  isApplyingRemoteState = true;
  state.clients = Array.isArray(remote.clients) ? remote.clients : [];
  state.alerts = Array.isArray(remote.alerts) ? remote.alerts : [];
  state.settings = remote.settings || state.settings;
  state.dashboard = remote.dashboard || state.dashboard;
  state.meta = remote.meta || state.meta;
  render();
  isApplyingRemoteState = false;
}

function extractOptions(key) {
  return [...new Set(state.clients.map((client) => client[key]).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "fr")
  );
}

function fillSelect(selectElement, values, keepValue) {
  const previousValue = keepValue;
  selectElement.innerHTML = "";

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = selectElement === els.cityFilter ? "Toutes" : "Tous";
  selectElement.appendChild(defaultOption);

  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    selectElement.appendChild(option);
  }

  if (values.includes(previousValue)) {
    selectElement.value = previousValue;
  } else {
    selectElement.value = "";
  }
}

function renderFilters() {
  fillSelect(els.cityFilter, extractOptions("city"), state.ui.city);
  fillSelect(els.departmentFilter, extractOptions("department"), state.ui.department);
}

function getFilteredClients() {
  const query = state.ui.search.trim().toLowerCase();
  let clients = [...state.clients];

  if (query) {
    clients = clients.filter((client) => {
      const first = (client.firstName || "").toLowerCase();
      const last = (client.lastName || "").toLowerCase();
      return first.includes(query) || last.includes(query);
    });
  }

  if (state.ui.city) {
    clients = clients.filter((client) => client.city === state.ui.city);
  }

  if (state.ui.department) {
    clients = clients.filter((client) => client.department === state.ui.department);
  }

  if (state.ui.importantOnly) {
    clients = clients.filter((client) => client.counter === MAX_COUNTER);
  }

  if (state.ui.sort === "counter_desc") {
    clients.sort((a, b) => b.counter - a.counter || a.lastName.localeCompare(b.lastName, "fr"));
  } else if (state.ui.sort === "recent") {
    clients.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  } else {
    clients.sort((a, b) => {
      const last = a.lastName.localeCompare(b.lastName, "fr");
      if (last !== 0) return last;
      return a.firstName.localeCompare(b.firstName, "fr");
    });
  }

  return clients;
}

function renderDashboard() {
  const dashboard = state.dashboard || {};
  els.kpiTotal.textContent = String(dashboard.totalClients || 0);
  els.kpiImportant.textContent = String(dashboard.importantClients || 0);
  els.kpiAverage.textContent = Number(dashboard.averageCounter || 0).toFixed(2);
  els.kpiAlerts.textContent = String(dashboard.unreadAlerts || 0);
}

function renderClients() {
  const clients = getFilteredClients();
  els.clientsList.innerHTML = "";
  els.clientsCount.textContent = `${clients.length} resultat(s)`;

  if (clients.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent =
      "Aucun client ne correspond a votre recherche. Essayez d'ajuster vos filtres.";
    els.clientsList.appendChild(p);
    return;
  }

  for (const client of clients) {
    const fragment = els.clientCardTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".client-card");
    const name = fragment.querySelector(".client-name");
    const meta = fragment.querySelector(".client-meta");
    const badge = fragment.querySelector(".counter-badge");
    const btnDown = fragment.querySelector(".counter-down");
    const btnUp = fragment.querySelector(".counter-up");
    const btnReset = fragment.querySelector(".reset-counter");
    const btnEdit = fragment.querySelector(".edit-client");

    name.textContent = `${client.lastName} ${client.firstName}`;
    meta.textContent = `${client.city} - Dept ${client.department}`;
    badge.textContent = `${client.counter}/${MAX_COUNTER}`;
    if (client.counter === MAX_COUNTER) {
      card.classList.add("important");
    }

    btnDown.disabled = client.counter <= 0;
    btnUp.disabled = client.counter >= MAX_COUNTER;

    btnDown.addEventListener("click", async () => {
      await runWithConfirmation(
        "Confirmer la modification",
        `Passer le compteur de ${client.firstName} ${client.lastName} a ${Math.max(0, client.counter - 1)} ?`,
        "Confirmer",
        () => api(`/api/clients/${encodeURIComponent(client.id)}/counter`, { method: "PATCH", body: { delta: -1 } })
      );
    });

    btnUp.addEventListener("click", async () => {
      await runWithConfirmation(
        "Confirmer la modification",
        `Passer le compteur de ${client.firstName} ${client.lastName} a ${Math.min(MAX_COUNTER, client.counter + 1)} ?`,
        "Confirmer",
        () => api(`/api/clients/${encodeURIComponent(client.id)}/counter`, { method: "PATCH", body: { delta: 1 } })
      );
    });

    btnReset.addEventListener("click", async () => {
      await runWithConfirmation(
        "Confirmer le reset",
        `Reinitialiser le compteur de ${client.firstName} ${client.lastName} a 0 ?`,
        "Reset",
        () => api(`/api/clients/${encodeURIComponent(client.id)}/reset`, { method: "POST" })
      );
    });

    btnEdit.addEventListener("click", () => openEditDialog(client));
    els.clientsList.appendChild(fragment);
  }
}

function renderAlerts() {
  els.alertsList.innerHTML = "";
  if (state.alerts.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = "Aucune alerte pour le moment.";
    els.alertsList.appendChild(p);
    return;
  }

  for (const alert of state.alerts.slice(0, 20)) {
    const item = document.createElement("article");
    item.className = `alert-item ${alert.read ? "" : "unread"}`.trim();

    const top = document.createElement("div");
    top.className = "alert-top";

    const type = document.createElement("span");
    type.className = "alert-type";
    type.textContent = alert.type || "INFO";

    const date = document.createElement("span");
    date.className = "alert-date";
    date.textContent = formatDate(alert.createdAt);

    top.append(type, date);

    const message = document.createElement("p");
    message.textContent = alert.message;
    message.style.margin = "0";

    item.append(top, message);

    if (!alert.read) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn ghost";
      btn.textContent = "Marquer comme lu";
      btn.addEventListener("click", async () => {
        try {
          await api(`/api/alerts/${encodeURIComponent(alert.id)}/read`, { method: "POST" });
        } catch (error) {
          setSaveStatus("error", error.message);
        }
      });
      item.appendChild(btn);
    }

    els.alertsList.appendChild(item);
  }
}

function renderAutomation() {
  els.autoResetEnabled.checked = !!state.settings?.autoReset?.enabled;
  els.autoResetTime.value = state.settings?.autoReset?.time || "09:00";
}

function renderMeta() {
  els.onlineUsers.textContent = `${state.meta.onlineUsers || 0} connecte(s)`;
  els.onlineUsers.className = "chip neutral";

  if (state.meta.autosaveError) {
    setSaveStatus("error", `Erreur sauvegarde: ${state.meta.autosaveError}`);
    return;
  }

  if (!isApplyingRemoteState) {
    setSaveStatus("success", "Sauvegarde automatique active");
  }
}

function render() {
  renderDashboard();
  renderFilters();
  renderClients();
  renderAlerts();
  renderAutomation();
  renderMeta();
}

function openEditDialog(client) {
  els.editForm.id.value = client.id;
  els.editForm.lastName.value = client.lastName;
  els.editForm.firstName.value = client.firstName;
  els.editForm.city.value = client.city;
  els.editForm.department.value = client.department;
  els.editDialog.showModal();
}

function closeEditDialog() {
  els.editDialog.close();
}

function askConfirmation({ title, message, confirmLabel = "Confirmer" }) {
  return new Promise((resolve) => {
    els.confirmTitle.textContent = title;
    els.confirmMessage.textContent = message;
    els.confirmAccept.textContent = confirmLabel;

    const cleanup = () => {
      els.confirmCancel.removeEventListener("click", onCancel);
      els.confirmAccept.removeEventListener("click", onAccept);
      els.confirmDialog.removeEventListener("cancel", onCancel);
      if (els.confirmDialog.open) {
        els.confirmDialog.close();
      }
    };

    const onCancel = () => {
      cleanup();
      resolve(false);
    };

    const onAccept = () => {
      cleanup();
      resolve(true);
    };

    els.confirmCancel.addEventListener("click", onCancel, { once: true });
    els.confirmAccept.addEventListener("click", onAccept, { once: true });
    els.confirmDialog.addEventListener("cancel", onCancel, { once: true });
    els.confirmDialog.showModal();
  });
}

async function runWithConfirmation(title, message, label, action) {
  try {
    const confirmed = await askConfirmation({
      title,
      message,
      confirmLabel: label
    });
    if (!confirmed) return;
    await action();
  } catch (error) {
    setSaveStatus("error", error.message);
  }
}

function connectEvents() {
  if (stream) {
    stream.close();
  }
  stream = new EventSource("/events");
  stream.addEventListener("state", (event) => {
    try {
      const payload = JSON.parse(event.data);
      applyRemoteState(payload);
    } catch {
      setSaveStatus("error", "Flux collaboratif invalide.");
    }
  });
  stream.addEventListener("error", () => {
    setSaveStatus("warning", "Reconnexion collaborative en cours...");
  });
  stream.addEventListener("open", () => {
    setSaveStatus("success", "Synchronisation collaborative active");
  });
}

async function fetchInitialState() {
  try {
    const payload = await api("/api/state");
    applyRemoteState(payload);
  } catch (error) {
    setSaveStatus("error", `Demarrage impossible: ${error.message}`);
  }
}

function bindEvents() {
  els.clientForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(els.clientForm);
    const payload = {
      lastName: String(formData.get("lastName") || "").trim(),
      firstName: String(formData.get("firstName") || "").trim(),
      city: String(formData.get("city") || "").trim(),
      department: String(formData.get("department") || "").trim().toUpperCase()
    };

    try {
      await api("/api/clients", { method: "POST", body: payload });
      els.clientForm.reset();
    } catch (error) {
      setSaveStatus("error", error.message);
    }
  });

  els.searchInput.addEventListener("input", (event) => {
    state.ui.search = event.target.value;
    renderClients();
  });

  els.cityFilter.addEventListener("change", (event) => {
    state.ui.city = event.target.value;
    renderClients();
  });

  els.departmentFilter.addEventListener("change", (event) => {
    state.ui.department = event.target.value;
    renderClients();
  });

  els.sortFilter.addEventListener("change", (event) => {
    state.ui.sort = event.target.value;
    renderClients();
  });

  els.importantOnly.addEventListener("change", (event) => {
    state.ui.importantOnly = event.target.checked;
    renderClients();
  });

  els.readAllAlerts.addEventListener("click", async () => {
    await runWithConfirmation(
      "Confirmer l'action",
      "Marquer toutes les alertes comme lues ?",
      "Confirmer",
      () => api("/api/alerts/read-all", { method: "POST" })
    );
  });

  els.saveAutomation.addEventListener("click", async () => {
    const enabled = els.autoResetEnabled.checked;
    const time = els.autoResetTime.value || "09:00";
    await runWithConfirmation(
      "Confirmer l'automatisation",
      enabled
        ? `Activer le reset quotidien a ${time} ?`
        : "Desactiver le reset quotidien automatique ?",
      "Enregistrer",
      () => api("/api/settings/automation", { method: "PUT", body: { enabled, time } })
    );
  });

  els.editForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(els.editForm);
    const id = String(formData.get("id"));
    const payload = {
      lastName: String(formData.get("lastName") || "").trim(),
      firstName: String(formData.get("firstName") || "").trim(),
      city: String(formData.get("city") || "").trim(),
      department: String(formData.get("department") || "").trim().toUpperCase()
    };

    await runWithConfirmation(
      "Confirmer la modification",
      "Enregistrer les changements de ce client ?",
      "Enregistrer",
      async () => {
        await api(`/api/clients/${encodeURIComponent(id)}`, { method: "PUT", body: payload });
        closeEditDialog();
      }
    );
  });

  els.cancelEdit.addEventListener("click", closeEditDialog);
}

async function init() {
  bindEvents();
  await fetchInitialState();
  connectEvents();
}

init();
