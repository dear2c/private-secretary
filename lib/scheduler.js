const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { CONFIG, DATA_DIR, ROOT } = require("./data");

const STATE_PATH = path.join(DATA_DIR, "scheduler-state.json");

function marketClockParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: CONFIG.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const weekday = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 0,
  }[parts.weekday];
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday,
  };
}

function scheduledMinutes() {
  const [hour, minute] = CONFIG.notificationTime.split(":").map(Number);
  return hour * 60 + minute;
}

function engineeringScheduledMinutes() {
  const [hour, minute] = (CONFIG.engineeringReminderTime || "18:00")
    .split(":")
    .map(Number);
  return hour * 60 + minute;
}

function shouldRun(clock = marketClockParts()) {
  return (
    clock.weekday >= 1 &&
    clock.weekday <= 5 &&
    clock.minutes >= scheduledMinutes()
  );
}

function shouldRunEngineering(clock = marketClockParts()) {
  return (
    clock.weekday === Number(CONFIG.engineeringReminderWeekday || 5) &&
    clock.minutes >= engineeringScheduledMinutes()
  );
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function maybeRunDailyReport({ dryRun = false } = {}) {
  const clock = marketClockParts();
  const state = readState();
  if (!shouldRun(clock) || state.lastRunDate === clock.dateKey) {
    return { triggered: false, clock, state };
  }
  if (!dryRun) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      STATE_PATH,
      JSON.stringify(
        {
          ...state,
          lastRunDate: clock.dateKey,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
    const child = spawn(
      process.execPath,
      [path.join(ROOT, "refresh.js"), "--market-only", "--open-app"],
      {
        cwd: ROOT,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    child.unref();
  }
  return { triggered: true, clock, state };
}

function maybeRunEngineeringReport({ dryRun = false } = {}) {
  const clock = marketClockParts();
  const state = readState();
  if (
    !shouldRunEngineering(clock) ||
    state.lastEngineeringRunDate === clock.dateKey
  ) {
    return { triggered: false, clock, state };
  }
  if (!dryRun) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      STATE_PATH,
      JSON.stringify(
        {
          ...state,
          lastEngineeringRunDate: clock.dateKey,
          engineeringStartedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
    const child = spawn(
      process.execPath,
      [path.join(ROOT, "refresh.js"), "--tenders-only", "--open-app"],
      {
        cwd: ROOT,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    child.unref();
  }
  return { triggered: true, clock, state };
}

module.exports = {
  marketClockParts,
  maybeRunDailyReport,
  maybeRunEngineeringReport,
  shouldRun,
  shouldRunEngineering,
};
