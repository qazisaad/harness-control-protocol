const token = location.hash.slice(1);
const $ = id => document.getElementById(id);
function element(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
async function api(path, options = {}) {
  const response = await fetch(`/api/${path}`, { ...options, headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(response.status === 403 ? "Open the private dashboard URL printed in your terminal." : "Request failed. Check the local runner connection.");
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
  $("connection").textContent = data.connected ? "Local runner connected" : "Runner disconnected";
  $("connection").classList.toggle("online", data.connected);
  $("account-count").textContent = data.accounts.length;
  $("attention-count").textContent = data.accounts.filter(account => account.freshness !== "fresh").length;
  $("age-value").replaceChildren(document.createTextNode(String(data.max_observation_age_seconds)), element("span", "s"));
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
      const row = element("div");
      const head = element("div", undefined, "limit-head"); head.append(element("span", limit.label, "limit-label"), element("strong", limit.used_percent === undefined ? "Unavailable" : `${limit.used_percent.toFixed(1)}% used`)); row.append(head);
      if (limit.used_percent !== undefined) { const bar = element("progress"); bar.max = 100; bar.value = Math.min(100, limit.used_percent); bar.setAttribute("aria-label", limit.label + " consumed"); row.append(bar); }
      const foot = element("div", undefined, "limit-foot"); foot.append(element("span", resetLabel(limit.resets_at)), element("span", limit.window_minutes ? `${limit.window_minutes >= 1440 ? (limit.window_minutes / 1440).toFixed(0) + " day" : (limit.window_minutes / 60).toFixed(1) + " hour"} window` : limit.kind)); row.append(foot); limits.append(row);
    }
    if (!view.observation.limits.length) limits.append(element("p", "The provider returned no quota windows.", "quiet"));
    card.append(limits);
    card.append(element("div", `${view.sources.length} source${view.sources.length === 1 ? "" : "s"} · ${view.account.scope_source === "local" ? "Local identity; configure a billing scope to combine machines" : view.account.scope_source + " billing scope"}\nAccount key: ${view.account.key}`, "account-meta"));
    $("accounts").append(card);
  }
  $("unavailable").replaceChildren();
  for (const source of data.sources.filter(source => source.latest.status === "unavailable")) {
    const row = element("div", undefined, "unavailable-row"); row.append(element("strong", `${source.provider_instance_id} / ${source.latest.reason.replaceAll("_", " ")}`), element("span", source.latest.message)); $("unavailable").append(row);
  }
}
$("refresh").addEventListener("click", async () => { $("refresh").disabled = true; try { render(await api("refresh", { method: "POST" })); } catch (error) { showError(error); } finally { $("refresh").disabled = false; } });
async function poll() { try { render(await api("state")); } catch (error) { showError(error); } }
void poll(); setInterval(poll, 5000);
