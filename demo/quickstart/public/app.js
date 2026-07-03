const state = {
  snapshot: null,
  busy: new Set(),
};

const els = {
  runnerStatus: document.querySelector("#runnerStatus"),
  workspacePath: document.querySelector("#workspacePath"),
  providerList: document.querySelector("#providerList"),
  promptProvider: document.querySelector("#promptProvider"),
  mcpProvider: document.querySelector("#mcpProvider"),
  actionOutput: document.querySelector("#actionOutput"),
  mcpOutput: document.querySelector("#mcpOutput"),
  eventLog: document.querySelector("#eventLog"),
  eventCount: document.querySelector("#eventCount"),
  promptInput: document.querySelector("#promptInput"),
  promptState: document.querySelector("#promptState"),
  mcpSendTurn: document.querySelector("#mcpSendTurn"),
};

bind("#refreshSnapshot", "click", refreshSnapshot);
bind("#startLocalSession", "click", () => runAction("start-local", "/api/session/start-local", {}, els.actionOutput));
bind("#readFile", "click", () => runAction("read-file", "/api/local/read-file", {}, els.actionOutput));
bind("#gitStatus", "click", () => runAction("git-status", "/api/local/git-status", {}, els.actionOutput));
bind("#safeShell", "click", () => runAction("safe-shell", "/api/local/safe-shell", {}, els.actionOutput));
bind("#startDevServer", "click", () => runAction("start-dev-server", "/api/local/dev-server/start", {}, els.actionOutput));
bind("#stopDevServer", "click", () => runAction("stop-dev-server", "/api/local/dev-server/stop", {}, els.actionOutput));
bind("#sendPrompt", "click", sendPrompt);
bind("#runMcp", "click", runMcp);

const events = new EventSource("/api/events");
events.addEventListener("snapshot", (event) => {
  state.snapshot = JSON.parse(event.data);
  render();
});
events.addEventListener("ui-event", (event) => {
  const item = JSON.parse(event.data);
  if (state.snapshot) {
    state.snapshot.event_log = [...state.snapshot.event_log, item].slice(-120);
    renderEvents();
  }
});

refreshSnapshot();

function bind(selector, event, handler) {
  document.querySelector(selector)?.addEventListener(event, handler);
}

async function refreshSnapshot() {
  const response = await fetch("/api/snapshot");
  state.snapshot = await response.json();
  render();
}

async function runAction(key, path, body, outputEl) {
  await withBusy(key, async () => {
    outputEl.textContent = "running...";
    const payload = await postJson(path, body);
    outputEl.textContent = JSON.stringify(payload, null, 2);
    await refreshSnapshot();
  });
}

async function sendPrompt() {
  await withBusy("send-prompt", async () => {
    els.promptState.textContent = "running";
    const payload = await postJson("/api/prompt/send", {
      provider_instance_id: els.promptProvider.value,
      input: els.promptInput.value,
    });
    els.promptState.textContent = payload.status === "ok" ? "completed" : "unavailable";
    els.actionOutput.textContent = JSON.stringify(payload, null, 2);
    await refreshSnapshot();
  });
}

async function runMcp() {
  await withBusy("run-mcp", async () => {
    els.mcpOutput.textContent = "running...";
    const payload = await postJson("/api/mcp/start", {
      provider_instance_id: els.mcpProvider.value || undefined,
      send_turn: els.mcpSendTurn.checked,
    });
    els.mcpOutput.textContent = JSON.stringify(payload, null, 2);
    await refreshSnapshot();
  });
}

async function postJson(path, body) {
  const token = state.snapshot?.api_token;
  if (!token) {
    await refreshSnapshot();
  }
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hcp-quickstart-token": state.snapshot?.api_token || "",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    return payload;
  }
  return payload;
}

async function withBusy(key, fn) {
  if (state.busy.has(key)) {
    return;
  }
  state.busy.add(key);
  setDisabled(true);
  try {
    await fn();
  } finally {
    state.busy.delete(key);
    setDisabled(false);
  }
}

function setDisabled(disabled) {
  document.querySelectorAll("button, select, textarea, input").forEach((control) => {
    if (control.id !== "refreshSnapshot") {
      control.disabled = disabled;
    }
  });
}

function render() {
  if (!state.snapshot) {
    return;
  }
  renderHeader();
  renderProviders();
  renderEvents();
}

function renderHeader() {
  const status = state.snapshot.runner_status;
  els.runnerStatus.textContent = status;
  els.runnerStatus.className =
    status === "accepted"
      ? "status-pill status-ready"
      : status === "error" || status === "disconnected"
        ? "status-pill status-error"
        : "status-pill status-waiting";
  els.workspacePath.textContent = state.snapshot.workspace_root || "workspace pending";
  els.eventCount.textContent = String(state.snapshot.hcp_event_count);
}

function renderProviders() {
  const providers = state.snapshot.providers || [];
  els.providerList.replaceChildren(
    ...providers.map((provider) => {
      const row = document.createElement("div");
      row.className = `provider ${provider.status}`;
      const title = document.createElement("strong");
      title.textContent = provider.display_name || provider.provider_instance_id;
      const meta = document.createElement("small");
      meta.textContent = `${provider.driver_kind} / ${provider.status}${provider.version ? ` / ${provider.version}` : ""}`;
      const message = document.createElement("small");
      message.textContent = provider.message || provider.auth?.status || "";
      row.append(title, meta, message);
      return row;
    }),
  );
  syncProviderSelect(els.promptProvider, providers.filter((provider) => provider.driver_kind !== "mock"));
  syncProviderSelect(els.mcpProvider, providers);
}

function syncProviderSelect(select, providers) {
  const current = select.value;
  select.replaceChildren(
    ...providers.map((provider) => {
      const option = document.createElement("option");
      option.value = provider.provider_instance_id;
      option.textContent = `${provider.display_name || provider.provider_instance_id} (${provider.status})`;
      return option;
    }),
  );
  if (providers.some((provider) => provider.provider_instance_id === current)) {
    select.value = current;
  }
}

function renderEvents() {
  const events = state.snapshot?.event_log || [];
  els.eventLog.replaceChildren(
    ...events.slice(-80).map((event) => {
      const item = document.createElement("li");
      const time = document.createElement("time");
      time.textContent = new Date(event.created_at).toLocaleTimeString();
      const label = document.createElement("b");
      label.textContent = `${event.channel}: ${event.label}`;
      const message = document.createElement("span");
      message.textContent = event.message;
      item.append(time, label, message);
      return item;
    }),
  );
}
