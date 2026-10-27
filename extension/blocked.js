const params = new URLSearchParams(location.search);
const category = params.get("category");
const task = params.get("task");
const headlines = {
  ai: "AI tools are off right now",
  settings: "Settings are locked",
  distraction: "That's for later",
  off_task: "That doesn't look like part of your task",
  parent_rule: "A parent blocked this site",
};
document.getElementById("headline").textContent = headlines[category] || "Let's get back to it";
document.getElementById("reason").textContent = params.get("reason") || "";
if (task) document.getElementById("task").textContent = `Your task: ${task}`;
document.getElementById("back").addEventListener("click", () => {
  if (history.length > 2) history.go(-2);
  else location.href = "https://www.khanacademy.org";
});
