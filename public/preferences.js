// Browser preferences are a private example overlay, never the shared policy file.
export const preferenceKey = 'ridgeline.demo.preferences.v1';

export function settingsMatch(left, right) {
  return left.stockMode === right.stockMode
    && Object.keys(right.rules).every(key => left.rules[key] === right.rules[key]);
}

export function loadPreferences(storage, defaults) {
  try {
    const raw = storage.getItem(preferenceKey);
    if (!raw) return { settings: structuredClone(defaults), saved: false, available: true };
    const saved = JSON.parse(raw);
    const valid = saved.version === 1 && saved.rules && !Array.isArray(saved.rules)
      && ['healthy', 'unavailable', 'stale'].includes(saved.stockMode)
      && Object.keys(defaults.rules).every(key => typeof saved.rules[key] === 'number' && Number.isFinite(saved.rules[key]) && saved.rules[key] >= 0)
      && saved.rules.specialistMaxDiscountPct <= saved.rules.managerMaxDiscountPct
      && saved.rules.managerMaxDiscountPct <= 100 && saved.rules.confidenceMinimum <= 1
      && Number.isSafeInteger(saved.rules.managerMinNetCents);
    if (!valid) throw new Error('Invalid saved preferences');
    return { settings: { rules: Object.fromEntries(Object.keys(defaults.rules).map(key => [key, saved.rules[key]])), stockMode: saved.stockMode }, saved: true, available: true };
  } catch {
    // Corrupt data or blocked storage should not prevent trying the supplied demo.
    return { settings: structuredClone(defaults), saved: false, available: false };
  }
}

export function savePreferences(storage, config) {
  try {
    storage.setItem(preferenceKey, JSON.stringify({ version: 1, rules: config.rules, stockMode: config.stockMode }));
    return true;
  } catch { return false; }
}

export function clearPreferences(storage) {
  try { storage.removeItem(preferenceKey); return true; } catch { return false; }
}

export async function synchronizePreferences(storage, defaults, current, apply) {
  const loaded = loadPreferences(storage, defaults);
  // Avoid resetting approvals on each reload when the workspace already matches.
  const config = settingsMatch(current, loaded.settings) ? current : await apply(loaded.settings);
  return { ...loaded, config };
}
