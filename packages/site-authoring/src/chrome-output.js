export const CHROME_UNAVAILABLE_MESSAGE = "Chrome contrast was not checked because the theme report was unavailable.";

const CONTEXT_DISPLAY_LENGTH = 128;

// Shown ratios round down, so a pair 0.004 short of AA never displays as 4.50.
export function floorTo(value, places) {
  const scale = 10 ** places;
  return Math.floor(value * scale + 1e-9) / scale;
}

export function displayChromeRatio(ratio, required) {
  const shown = floorTo(ratio, 2);
  // The tolerance in floorTo can otherwise round a value just below AA up to AA.
  return ratio < required && shown >= required ? required - 0.01 : shown;
}

export function displayChromeContext(context) {
  if (context === null || context.length <= CONTEXT_DISPLAY_LENGTH) return { context };
  return {
    context: context.slice(0, CONTEXT_DISPLAY_LENGTH),
    contextTruncated: true,
    contextLength: context.length,
  };
}

function dictionary(values) {
  const items = [...new Set(values)].sort();
  return { items, indexes: new Map(items.map((item, index) => [item, index])) };
}

function identityKey({ element, foreground, background, state, kind }) {
  return JSON.stringify([element, foreground, background, state, kind]);
}

/** Index the selected paint while retaining the callers' scheme, card and row order. */
export function indexChromePaint(entries) {
  const identities = new Map();
  for (const cards of Object.values(entries)) {
    for (const { pairs } of cards) {
      for (const pair of pairs) identities.set(identityKey(pair), pair);
    }
  }
  const pairs = [...identities.values()];
  const elements = dictionary(pairs.map(({ element }) => element));
  const colors = dictionary(pairs.flatMap(({ foreground, background }) => [foreground, background]));
  const states = dictionary(pairs.map(({ state }) => state));
  const kinds = dictionary(pairs.map(({ kind }) => kind));
  // Sorting each dictionary makes an index stay the same or shrink when entries are removed.
  const pairKeys = dictionary(identities.keys());
  const chromeCatalog = {
    elements: elements.items,
    colors: colors.items,
    states: states.items,
    kinds: kinds.items,
    pairs: pairKeys.items.map((key) => {
      const { element, foreground, background, state, kind } = identities.get(key);
      return [
        elements.indexes.get(element),
        colors.indexes.get(foreground),
        colors.indexes.get(background),
        states.indexes.get(state),
        kinds.indexes.get(kind),
      ];
    }),
  };
  const chrome = Object.fromEntries(Object.entries(entries).map(([scheme, cards]) => [
    scheme,
    cards.map(({ role, context, pairs }) => ({
      role,
      ...displayChromeContext(context),
      pairs: pairs.map((pair) => [
        pairKeys.indexes.get(identityKey(pair)),
        displayChromeRatio(pair.ratio, pair.required),
        pair.required,
      ]),
    })),
  ]));
  return { chrome, chromeCatalog };
}

export function decodeChromePair(catalog, [identityIndex, ratio, required]) {
  const [element, foreground, background, state, kind] = catalog.pairs[identityIndex];
  return {
    element: catalog.elements[element],
    foreground: catalog.colors[foreground],
    background: catalog.colors[background],
    state: catalog.states[state],
    kind: catalog.kinds[kind],
    ratio,
    required,
  };
}
