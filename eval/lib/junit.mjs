const attr = (text, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(text)?.[1] ?? '';

/** Returns Map(id -> passed). A repeated id counts as failed if any occurrence failed. */
export function parseJunit(xml) {
  const results = new Map();
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const id = `${attr(match[1], 'classname')}::${attr(match[1], 'name')}`;
    const body = match[2] || '';
    if (/<skipped\b/.test(body)) continue;
    const passed = !/<(failure|error)\b/.test(body);
    results.set(id, (results.get(id) ?? true) && passed);
  }
  return results;
}
