const token = location.hash.slice(1);
let settings;
let policyDirty = false;
const $ = id => document.getElementById(id);
const labels = { healthy: "Capacity available", refresh: "Fresh reading needed", wait_for_reset: "Wait for reset", review_capacity: "Review capacity", recommend_extra_usage: "Extra usage recommended", recommend_upgrade: "Upgrade recommended", budget_exhausted: "Budget exception needed" };
function element(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
async function api(path, options = {}) {
  const response = await fetch(`/api/${path}`, { ...options, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
  if (!response.ok) throw new Error(response.status === 403 ? "Open the private dashboard URL printed in your terminal." : "Request failed. Check the input and local runner connection.");
  return response.json();
}
function showError(error) { $("error").hidden = false; $("error").textContent = error.message; }
function resetLabel(value) {
  if (!value) return "Reset time unavailable";
  const remaining = Date.parse(value) - Date.now();
  if (remaining <= 0) return "Reset passed · refresh required";
  const minutes = Math.ceil(remaining / 60000);
  return `Resets in ${minutes < 60 ? minutes + "m" : minutes < 1440 ? Math.floor(minutes / 60) + "h " + minutes % 60 + "m" : Math.floor(minutes / 1440) + "d " + Math.floor(minutes % 1440 / 60) + "h"}`;
}
function render(data) {
  settings = data.settings;
  $("connection").textContent = data.connected ? "Local runner connected" : "Runner disconnected";
  $("connection").classList.toggle("online", data.connected);
  $("account-count").textContent = data.accounts.length;
  $("attention-count").textContent = data.accounts.filter(account => account.decision.kind !== "healthy").length;
  $("threshold-value").replaceChildren(document.createTextNode(String(settings.policy.threshold_percent)), element("span", "%"));
  if (!policyDirty) { $("threshold").value = settings.policy.threshold_percent; $("grace").value = settings.policy.reset_grace_minutes; }
  const times = data.sources.map(source => Date.parse(source.latest.observed_at));
  $("updated").textContent = times.length ? `Latest observation ${new Date(Math.max(...times)).toLocaleTimeString()}` : "Waiting for first reading";
  $("error").hidden = !data.error;
  if (data.error) $("error").textContent = data.error;
  $("accounts").replaceChildren();
  if (!data.accounts.length) $("accounts").append(element("div", "No account quota readings yet. Provider availability appears below.", "empty"));
  for (const view of data.accounts) {
    const card = element("article", undefined, "account");
    const top = element("div", undefined, "account-top");
    const title = element("div"); title.append(element("h3", view.account.label, "provider-name"), element("div", `${view.observation.plan ?? "Plan unavailable"} · ${view.account.provider}`, "plan"));
    top.append(title, element("span", view.freshness, `badge ${view.freshness}`)); card.append(top);
    const limits = element("div", undefined, "limits");
    for (const limit of view.observation.limits) {
      const row = element("div", undefined, limit.used_percent >= settings.policy.threshold_percent ? "high" : "");
      const head = element("div", undefined, "limit-head"); head.append(element("span", limit.label, "limit-label"), element("strong", limit.used_percent === undefined ? "Unavailable" : `${limit.used_percent.toFixed(1)}% used`)); row.append(head);
      if (limit.used_percent !== undefined) { const bar = element("progress"); bar.max = 100; bar.value = Math.min(100, limit.used_percent); bar.setAttribute("aria-label", limit.label + " consumed"); row.append(bar); }
      const foot = element("div", undefined, "limit-foot"); foot.append(element("span", resetLabel(limit.resets_at)), element("span", limit.window_minutes ? `${limit.window_minutes >= 1440 ? (limit.window_minutes / 1440).toFixed(0) + " day" : (limit.window_minutes / 60).toFixed(1) + " hour"} window` : limit.kind)); row.append(foot); limits.append(row);
    }
    if (!view.observation.limits.length) limits.append(element("p", "The provider returned no quota windows.", "quiet"));
    card.append(limits);
    card.append(element("div", `${view.sources.length} source${view.sources.length === 1 ? "" : "s"} · ${view.account.scope_source === "local" ? "Local identity; configure billing scope to combine machines" : view.account.scope_source + " billing scope"}\nAccount key: ${view.account.key}`, "account-meta"));
    const decision = element("div", undefined, "decision"); decision.append(element("strong", labels[view.decision.kind]), element("span", view.decision.reason));
    if (view.decision.quote) decision.append(element("p", `${view.decision.quote.currency} · ${view.decision.quote.incremental_cost_minor} minor units · quote ${view.decision.quote.id}`));
    card.append(decision); $("accounts").append(card);
  }
  $("unavailable").replaceChildren();
  for (const source of data.sources.filter(source => source.latest.status === "unavailable")) {
    const row = element("div", undefined, "unavailable-row"); row.append(element("strong", `${source.provider_instance_id} / ${source.latest.reason.replaceAll("_", " ")}`), element("span", source.latest.message)); $("unavailable").append(row);
  }
  $("renewals").replaceChildren(); $("renewals").className = data.renewals.length ? "" : "empty";
  if (!data.renewals.length) $("renewals").textContent = "No renewal contracts imported. A quota reset is not a billing renewal.";
  for (const { contract, decision } of data.renewals) {
    const row = element("div", undefined, "renewal-row"); row.append(element("strong", `${contract.current_plan} → ${contract.baseline_plan} · ${decision.kind.replaceAll("_", " ")}`), element("div", decision.reason), element("div", `Effective ${new Date(decision.effective_at).toLocaleDateString()} · change deadline ${new Date(contract.change_deadline_at).toLocaleDateString()}`, "quiet")); $("renewals").append(row);
  }
}
$("refresh").addEventListener("click", async () => { $("refresh").disabled = true; try { render(await api("refresh", { method: "POST" })); } catch (error) { showError(error); } finally { $("refresh").disabled = false; } });
$("policy-form").addEventListener("input", () => { policyDirty = true; });
$("policy-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!settings) return;
  try {
    const result = await api("settings", { method: "PUT", body: JSON.stringify({ ...settings, policy: { ...settings.policy, threshold_percent: Number($("threshold").value), reset_grace_minutes: Number($("grace").value) } }) });
    policyDirty = false; render(result); $("save-status").textContent = "Policy saved.";
  } catch (error) { showError(error); }
});
$("billing-file").addEventListener("change", async event => {
  const file = event.target.files[0]; if (!file) return;
  try { const imported = JSON.parse(await file.text()); const result = await api("settings", { method: "PUT", body: JSON.stringify(imported) }); policyDirty = false; render(result); $("save-status").textContent = "Settings imported."; } catch (error) { showError(error); }
});
$("export").addEventListener("click", () => { if (!settings) return; const url = URL.createObjectURL(new Blob([JSON.stringify(settings, null, 2)], { type: "application/json" })); const link = element("a"); link.href = url; link.download = "hcp-capacity-settings.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
async function poll() { try { render(await api("state")); } catch (error) { showError(error); } }
void poll(); setInterval(poll, 5000);
