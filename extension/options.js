const input = document.getElementById("server");
const save = document.getElementById("save");
const status = document.getElementById("status");

chrome.storage.local.get(["serverUrl", "lastSync", "cached"]).then(({ serverUrl, lastSync, cached }) => {
  input.value = serverUrl || "http://localhost:8899";
  status.textContent = lastSync ? `Last synced ${new Date(lastSync).toLocaleTimeString()}` : "Not synced yet";
  // Pointing the extension at a dead server would be an easy way around it, so it's locked during a session.
  const policy = cached && cached.policy;
  if (policy && policy.active && (!policy.until || Date.parse(policy.until) > Date.now())) {
    input.disabled = true;
    save.disabled = true;
    status.textContent = "Locked while a focus session is running.";
  }
});

save.addEventListener("click", async () => {
  await chrome.storage.local.set({ serverUrl: input.value.trim() });
  status.textContent = "Saved.";
});
