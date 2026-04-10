let debugEnabled = false;

export function setDebug(flag) {
  debugEnabled = !!flag;
}

export function isDebug() {
  return debugEnabled;
}

export function debug(...args) {
  if (debugEnabled) {
    console.log("[DEBUG]", ...args);
  }
}
