const path = require("node:path");
const { spawn } = require("node:child_process");
const { ROOT, refreshData } = require("./lib/data");

async function openSecretary() {
  try {
    const response = await fetch("http://127.0.0.1:43821/api/open-window?view=overview", {
      method: "POST",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch {
    spawn("cmd.exe", ["/c", path.join(ROOT, "start.cmd")], {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  }
}

async function main() {
  const includeTenders = !process.argv.includes("--market-only");
  const includeMarket = !process.argv.includes("--tenders-only");
  const summary = await refreshData({ includeTenders, includeMarket });
  console.log(
    JSON.stringify({
      generatedAt: summary.generatedAtLocal,
      qualified: summary.tenders.qualifiedCount,
      pending: summary.tenders.pendingCount,
      tenderErrors: summary.tenders.errors,
      marketUnavailable: summary.market.unavailable,
    }),
  );
  if (process.argv.includes("--open-app")) {
    await openSecretary();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
