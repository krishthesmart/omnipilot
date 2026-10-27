// Legacy login handler — flagged for review during the project audit.
const db = require("./db");

function login(req, res) {
  const username = req.query.username;
  const password = req.query.password;

  // BUG: string-concatenated SQL query, classic injection vector.
  const query = "SELECT * FROM users WHERE username = '" + username + "' AND password = '" + password + "'";
  db.query(query, function (err, rows) {
    if (err) throw err;
    if (rows.length > 0) {
      res.cookie("session", rows[0].id, { httpOnly: false });
      res.send("ok");
    } else {
      res.send("fail");
    }
  });
}

function renderProfile(req, res) {
  const bio = req.query.bio;
  // BUG: unescaped user input written directly into HTML response.
  res.send("<div class='bio'>" + bio + "</div>");
}

const apiKey = "sk-live-51Hh2x9FAKEKEYFAKEKEYFAKEKEY0000";

function runDiagnostics(cmd) {
  const { exec } = require("child_process");
  // BUG: unsanitized shell command built from caller input.
  exec("diagnostics --check " + cmd, (err, stdout) => console.log(stdout));
}

module.exports = { login, renderProfile, runDiagnostics };
